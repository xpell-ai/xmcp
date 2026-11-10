import type { AuthInfo } from "@modelcontextprotocol/server";
import { _x } from "@xpell/core";
import type { XpellMCPSettings } from "./MCPConfig.js";
import {
  resolveXpellMCPAuthorizationServer,
  resolveXpellMCPRequestOrigin,
  resolveXpellMCPResourceUrl,
} from "./MCPOAuthMetadata.js";
import { sanitizeError } from "./MCPResultMapper.js";

export type XpellMCPIncomingRequest = {
  headers?: Record<string, string | string[] | undefined>;
  socket?: {
    remoteAddress?: string;
  };
};

export type XpellMCPAuthorizationResult =
  | {
    _ok: true;
    _auth?: AuthInfo;
  }
  | {
    _ok: false;
    _status: number;
    _code: string;
    _message: string;
  };

export async function authorizeMCPRequest(
  req: XpellMCPIncomingRequest,
  settings: XpellMCPSettings,
): Promise<XpellMCPAuthorizationResult> {
  const origin = resolveXpellMCPRequestOrigin(req);
  const oauth_resource = resolveXpellMCPResourceUrl(settings, origin);
  const oauth_issuer = resolveXpellMCPAuthorizationServer(settings, origin);

  if (!settings.require_auth) {
    if (settings.allow_unauthenticated_localhost && isLocalhostRequest(req)) {
      return { _ok: true };
    }

    return {
      _ok: false,
      _status: 403,
      _code: "E_XMCP_UNAUTHENTICATED_MODE_NOT_LOCAL",
      _message: "Unauthenticated MCP access is only available for explicitly configured local development.",
    };
  }

  const token = readBearerToken(req);
  if (!token) {
    return {
      _ok: false,
      _status: 401,
      _code: "E_XMCP_AUTH_REQUIRED",
      _message: "MCP bearer token is required.",
    };
  }

  try {
    const auth: any = await _x.execute({
      _module: "xauth",
      _op: "authorize_req",
      _params: {
        _ctx: {
          _source: "mcp",
          _transport: "streamable-http",
          _meta: {
            _token: token,
            _oauth_issuer: oauth_issuer,
            _oauth_resource: oauth_resource,
          },
        },
        _token: token,
      },
    } as any);

    if (auth?._authenticated !== true) {
      return {
        _ok: false,
        _status: 401,
        _code: "E_XMCP_INVALID_AUTH",
        _message: "MCP bearer token was rejected.",
      };
    }

    if (!isMCPBearerAuth(auth, {
      _resource: oauth_resource,
      _supported_scopes: settings.scopes_supported,
    })) {
      return {
        _ok: false,
        _status: 401,
        _code: "E_XMCP_INVALID_AUTH",
        _message: "MCP bearer token was rejected.",
      };
    }

    const scopes = readMCPAuthScopes(auth);

    return {
      _ok: true,
      _auth: {
        token,
        clientId: readClientId(auth),
        scopes: scopes.length > 0 ? scopes : ["xpell:mcp"],
        extra: toSafeAuthContext(auth),
      },
    };
  } catch (error) {
    const sanitized = sanitizeError(error);
    const detail = readSanitizedError(sanitized);

    return {
      _ok: false,
      _status: 401,
      _code: detail._code,
      _message: detail._message,
    };
  }
}

function isMCPBearerAuth(
  auth: Record<string, unknown>,
  options: { _resource: string; _supported_scopes: string[] },
): boolean {
  if (auth._auth_type !== "jwt") return true;

  if (auth._token_purpose !== "mcp" || auth._audience !== "mcp") return false;
  if (!isOAuthMCPAccessToken(auth)) return true;

  const resource = readString(auth.resource) ?? readString(auth.aud);
  if (resource !== options._resource) return false;

  const scopes = readMCPAuthScopes(auth);
  if (scopes.length === 0) return false;

  const supported = new Set(options._supported_scopes);
  return scopes.every((scope) => supported.has(scope));
}

export function readBearerToken(req: XpellMCPIncomingRequest): string | undefined {
  const raw = readHeader(req, "authorization");
  if (!raw) return undefined;

  const match = raw.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token || undefined;
}

function readClientId(auth: Record<string, unknown>): string {
  const oauth_client_id = typeof auth.client_id === "string" ? auth.client_id : "";
  const user_id = typeof auth._user_id === "string" ? auth._user_id : "";
  const account_id = typeof auth._account_id === "string" ? auth._account_id : "";
  const agent_id = typeof auth._agent_id === "string" ? auth._agent_id : "";

  return oauth_client_id || user_id || agent_id || account_id || "xpell-mcp";
}

function toSafeAuthContext(auth: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    _authenticated: auth._authenticated === true,
  };

  for (const key of [
    "_auth_type",
    "_user_id",
    "_account_id",
    "_agent_id",
    "_clearance_level",
    "_token_purpose",
    "_audience",
    "aud",
    "resource",
    "scope",
    "client_id",
    "jti",
    "sub",
  ]) {
    const value = auth[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  for (const key of ["_permissions", "permissions", "_scopes", "scopes"]) {
    const value = auth[key];
    if (Array.isArray(value)) {
      const entries = value.filter((entry): entry is string => typeof entry === "string");
      if (entries.length > 0) out[key] = entries;
    }
  }

  return out;
}

function isOAuthMCPAccessToken(auth: Record<string, unknown>): boolean {
  return (
    typeof auth.client_id === "string" ||
    typeof auth.resource === "string" ||
    typeof auth.aud === "string" ||
    typeof auth.scope === "string"
  );
}

function readMCPAuthScopes(auth: Record<string, unknown>): string[] {
  const scope = readString(auth.scope);
  if (scope) return Array.from(new Set(scope.split(/\s+/).filter(Boolean)));

  for (const key of ["_scopes", "scopes"]) {
    const value = auth[key];
    if (Array.isArray(value)) {
      return Array.from(new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)));
    }
  }

  return [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readHeader(req: XpellMCPIncomingRequest, name: string): string | undefined {
  const headers = req.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()];

  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function isLocalhostRequest(req: XpellMCPIncomingRequest): boolean {
  const remote = req.socket?.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function readSanitizedError(value: Record<string, unknown>): { _code: string; _message: string } {
  const error = isRecord(value._error) ? value._error : {};
  const code = typeof error._code === "string" ? error._code : "E_XMCP_INVALID_AUTH";
  const message = typeof error._message === "string" ? error._message : "MCP bearer token was rejected.";

  return { _code: code, _message: message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
