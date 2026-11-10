import { XLogger as _xlog, XModule, _x } from "@xpell/core";
import type { XCommand, XpellSkill, XpellSkillCommand } from "@xpell/core";
import { DEFAULT_XMCP_SETTINGS, getXpellMCPSettings } from "./MCPConfig.js";
import { DefaultMCPToolRegistry, type MCPToolRegistry } from "./MCPToolRegistry.js";
import { getXpellMCPRuntimeReadiness } from "./MCPRuntimeReadiness.js";
import { getXpellMCPPackageInfo, getXpellMCPRouteStatus } from "./MCPServer.js";

export const MCP_OPS: Record<string, XpellSkillCommand> = {
  status: {
    _name: "status",
    _scope: "module",
    _description: "Return non-sensitive MCP adapter and Xpell runtime status.",
  },
  "list-tools": {
    _name: "list-tools",
    _scope: "module",
    _description: "List curated MCP tools registered by the Xpell MCP adapter.",
  },
};

export const MCP_SKILL: XpellSkill = {
  _id: "mcp",
  _title: "Xpell MCP Adapter Module",
  _version: "1.0.0",
  _active: true,
  _type: "server-module-api",
  _requires: ["xmodule"],
  _description:
    "Server-side module exposing status for the Xpell MCP Streamable HTTP adapter.",
  _exports: {
    _modules: [
      {
        _name: "mcp",
        _scope: "server",
        _description: "Xpell MCP adapter status module.",
        _ops: Object.values(MCP_OPS),
      },
    ],
  },
  _core_rules: [
    "The mcp module does not implement MCP protocol calls.",
    "External MCP protocol traffic is handled by the official MCP SDK.",
    "Only curated MCP tools are exposed; arbitrary _x.execute is not exported.",
  ],
};

export class MCPModule extends XModule {
  static _name = "mcp";
  static _skill = MCP_SKILL;
  static _ops = MCP_OPS;

  constructor(private readonly registry: MCPToolRegistry = DefaultMCPToolRegistry) {
    super({ _name: MCPModule._name });
  }

  _status(_xcmd?: XCommand) {
    const settings = getXpellMCPSettings();
    const route_status = getXpellMCPRouteStatus();
    const package_info = getXpellMCPPackageInfo();
    const runtime_readiness = getXpellMCPRuntimeReadiness();
    const enabled = route_status?._enabled ?? settings.enabled;
    const mounted = route_status?._mounted ?? enabled;
    const path = route_status?._path ?? settings.path;
    const transport = route_status?._transport ?? settings.transport;
    const require_auth = route_status?._require_auth ?? settings.require_auth;

    _xlog.log("[mcp] status requested", { _enabled: enabled, _path: path });

    return {
      _ok: true,
      _enabled: enabled,
      _mounted: mounted,
      _transport: transport,
      _path: path,
      _require_auth: require_auth,
      _xpell_available: typeof (_x as any).execute === "function",
      _mcp: {
        _package: package_info._package,
        _package_version: package_info._package_version,
        _sdk: package_info._sdk,
        _enabled: enabled,
        _mounted: mounted,
        _transport: transport,
        _path: path,
        _require_auth: require_auth,
        _runtime_readiness: runtime_readiness,
      },
      _runtime: {
        _engine_id: typeof (_x as any)._engine_id === "string" ? (_x as any)._engine_id : undefined,
        _version: typeof (_x as any)._version === "string" ? (_x as any)._version : undefined,
        _ready: typeof (_x as any).isReady === "function"
          ? {
            _mcp: (_x as any).isReady("mcp"),
          }
          : {},
        _loaded_modules: readLoadedModuleNames(),
      },
      _tools: this.registry.listTools(),
    };
  }

  _list_tools(_xcmd?: XCommand) {
    return {
      _ok: true,
      _tools: this.registry.listTools(),
    };
  }

  protected async onLoad(): Promise<void> {
    if (typeof (_x as any).ready === "function") {
      (_x as any).ready("mcp", true);
    }

    getXpellMCPSettings(DEFAULT_XMCP_SETTINGS);
  }
}

function readLoadedModuleNames(): string[] {
  const modules = typeof (_x as any).getSkills === "function"
    ? (_x as any).getSkills()?._modules
    : [];

  if (!Array.isArray(modules)) return [];

  return modules
    .map((mod) => isRecord(mod) && typeof mod._name === "string" ? mod._name : "")
    .filter(Boolean)
    .slice(0, 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
