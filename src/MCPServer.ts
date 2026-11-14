import { createRequire } from "node:module";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { toNodeHandler, type NodeIncomingMessageLike, type NodeServerResponseLike } from "@modelcontextprotocol/node";
import { _xlog } from "@xpell/core";
import { authorizeMCPRequest } from "./MCPAuth.js";
import {
  DEFAULT_XMCP_SETTINGS,
  ensureXpellMCPSettings,
  getXpellMCPSettings,
  normalizeMCPSettings,
  type XpellMCPSettings,
} from "./MCPConfig.js";
import { createXpellMCPWWWAuthenticateChallenge } from "./MCPOAuthMetadata.js";
import { getXpellMCPRuntimeReadiness } from "./MCPRuntimeReadiness.js";
import { DefaultMCPToolRegistry, type MCPToolRegistry } from "./MCPToolRegistry.js";

const require = createRequire(import.meta.url);

export type XpellMCPPackageInfo = {
  _package: "@xpell/mcp";
  _package_version: string;
  _sdk: {
    _server: string;
    _node: string;
  };
};

export type XpellMCPServerOptions = {
  _registry?: MCPToolRegistry;
};

export type XpellMCPRequestHandlerOptions = XpellMCPServerOptions & {
  _settings?: Partial<XpellMCPSettings>;
};

export type XpellMCPRouteApp = {
  all?: (path: string, handler: (req: any, res: any) => void | Promise<void>) => unknown;
  use?: (path: string, handler: (req: any, res: any) => void | Promise<void>) => unknown;
};

export type XpellMCPMountResult = {
  _mounted: boolean;
  _path: string;
  _enabled: boolean;
  _transport: XpellMCPSettings["transport"];
  _require_auth: boolean;
};

let xpell_mcp_route_status: XpellMCPMountResult | null = null;

export function createXpellMCPServer(options: XpellMCPServerOptions = {}): McpServer {
  const package_info = getXpellMCPPackageInfo();
  const server = new McpServer(
    {
      name: "xpell",
      version: package_info._package_version,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  (options._registry ?? DefaultMCPToolRegistry).registerWithServer(server);
  return server;
}

export function createXpellMCPRequestHandler(options: XpellMCPRequestHandlerOptions = {}) {
  const settings = normalizeMCPSettings({
    ...getXpellMCPSettings(),
    ...(options._settings ?? {}),
  });

  const handler = createMcpHandler(
    () => createXpellMCPServer({ _registry: options._registry }),
    {
      legacy: "stateless",
      onerror: (error) => {
        _xlog.warn("[mcp] handler error", {
          _code: "E_XMCP_HANDLER",
          _message: error.message,
        });
      },
    },
  );
  const nodeHandler = toNodeHandler(handler);

  return async (
    req: NodeIncomingMessageLike,
    res: NodeServerResponseLike,
    parsedBody?: unknown,
  ): Promise<void> => {
    if (!settings.enabled) {
      writeJson(res, 404, {
        _ok: false,
        _error: {
          _code: "E_XMCP_DISABLED",
          _message: "Xpell MCP endpoint is disabled.",
        },
      });
      return;
    }

    if (settings.transport !== "streamable-http") {
      writeJson(res, 404, {
        _ok: false,
        _error: {
          _code: "E_XMCP_UNSUPPORTED_TRANSPORT",
          _message: "Xpell MCP only supports Streamable HTTP in this phase.",
        },
      });
      return;
    }

    const auth = await authorizeMCPRequest(req, settings);
    if (!auth._ok) {
      writeJson(res, auth._status, {
        _ok: false,
        _error: {
          _code: auth._code,
          _message: auth._message,
        },
      }, auth._status === 401
        ? { "WWW-Authenticate": createXpellMCPWWWAuthenticateChallenge(settings, req) }
        : undefined);
      return;
    }

    const readiness = getXpellMCPRuntimeReadiness();
    if (!readiness._ready) {
      _xlog.warn("[mcp] runtime not ready", {
        _status: readiness._status,
        _reason: readiness._reason,
      });
      writeJson(res, 503, {
        _ok: false,
        _error: {
          _code: "E_XMCP_RUNTIME_NOT_READY",
          _message: "Xpell MCP runtime is not ready.",
          _retryable: true,
          _status: readiness._status,
          _reason: readiness._reason,
        },
      }, {
        "Retry-After": "1",
      });
      return;
    }

    const req_with_auth = req as NodeIncomingMessageLike & { auth?: AuthInfo };
    if (auth._auth) {
      req_with_auth.auth = auth._auth;
    }

    await nodeHandler(req_with_auth, res, parsedBody);
  };
}

export function mountXpellMCPRoute(
  app: XpellMCPRouteApp,
  options: XpellMCPRequestHandlerOptions = {},
): XpellMCPMountResult {
  const settings = normalizeMCPSettings({
    ...ensureXpellMCPSettings(),
    ...(options._settings ?? {}),
  });

  if (!settings.enabled) {
    mountHandler(app, settings.path, createXpellMCPRequestHandler({
      ...options,
      _settings: settings,
    }));

    xpell_mcp_route_status = {
      _mounted: false,
      _path: settings.path,
      _enabled: false,
      _transport: settings.transport,
      _require_auth: settings.require_auth,
    };

    return { ...xpell_mcp_route_status };
  }

  const route = createXpellMCPRequestHandler({
    ...options,
    _settings: settings,
  });

  const expressHandler = async (req: any, res: any): Promise<void> => {
    await route(req, res, req?.body);
  };

  mountHandler(app, settings.path, expressHandler);

  xpell_mcp_route_status = {
    _mounted: true,
    _path: settings.path,
    _enabled: true,
    _transport: settings.transport,
    _require_auth: settings.require_auth,
  };

  return { ...xpell_mcp_route_status };
}

export function getXpellMCPRouteStatus(): XpellMCPMountResult | null {
  return xpell_mcp_route_status ? { ...xpell_mcp_route_status } : null;
}

function mountHandler(
  app: XpellMCPRouteApp,
  path: string,
  handler: (req: any, res: any) => void | Promise<void>,
): void {
  if (typeof app.all === "function") {
    app.all(path, handler);
  } else if (typeof app.use === "function") {
    app.use(path, handler);
  } else {
    throw new Error("Xpell MCP route mount requires an app with all() or use().");
  }
}

export function getXpellMCPPackageInfo(): XpellMCPPackageInfo {
  const own = readPackageJson("@xpell/mcp/package.json");
  const dependencies = isRecord(own) && isRecord(own.dependencies)
    ? own.dependencies
    : {};

  return {
    _package: "@xpell/mcp",
    _package_version: readVersion(own, DEFAULT_XMCP_PACKAGE_VERSION),
    _sdk: {
      _server: readDependencyVersion(dependencies, "@modelcontextprotocol/server"),
      _node: readDependencyVersion(dependencies, "@modelcontextprotocol/node"),
    },
  };
}

function writeJson(
  res: NodeServerResponseLike,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readPackageJson(specifier: string): unknown {
  try {
    return require(specifier);
  } catch {
    return {};
  }
}

function readVersion(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.version === "string" ? value.version : fallback;
}

function readDependencyVersion(dependencies: Record<string, unknown>, name: string): string {
  const value = dependencies[name];
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const DEFAULT_XMCP_PACKAGE_VERSION = "2.0.8";
