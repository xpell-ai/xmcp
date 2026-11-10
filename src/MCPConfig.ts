import { _xs } from "@xpell/node-core";

export type XpellMCPTransport = "streamable-http";

export type XpellMCPSettings = {
  enabled: boolean;
  transport: XpellMCPTransport;
  path: string;
  require_auth: boolean;
  allow_unauthenticated_localhost: boolean;
  resource_url?: string;
  authorization_server_url?: string;
  issuer_url?: string;
  scopes_supported: string[];
};

export const XPELL_MCP_OAUTH_SCOPES = [
  "xpell:read",
  "xpell:write",
  "xpell:admin",
] as const;

export const DEFAULT_XMCP_SETTINGS: XpellMCPSettings = {
  enabled: false,
  transport: "streamable-http",
  path: "/mcp",
  require_auth: true,
  allow_unauthenticated_localhost: false,
  scopes_supported: [...XPELL_MCP_OAUTH_SCOPES],
};

export function ensureXpellMCPSettings(): XpellMCPSettings {
  _xs.ensureDefaults("mcp", DEFAULT_XMCP_SETTINGS);
  return getXpellMCPSettings();
}

export function getXpellMCPSettings(overrides?: Partial<XpellMCPSettings>): XpellMCPSettings {
  const raw = _xs.get("mcp");

  return normalizeMCPSettings({
    ...(isRecord(raw) ? raw : {}),
    ...(overrides ?? {}),
  });
}

export function normalizeMCPSettings(value: unknown): XpellMCPSettings {
  const raw = isRecord(value) ? value : {};
  const path = typeof raw.path === "string" && raw.path.trim()
    ? normalizeMCPPath(raw.path)
    : DEFAULT_XMCP_SETTINGS.path;

  return {
    enabled: raw.enabled === true,
    transport: raw.transport === "streamable-http"
      ? "streamable-http"
      : DEFAULT_XMCP_SETTINGS.transport,
    path,
    require_auth: raw.require_auth !== false,
    allow_unauthenticated_localhost: raw.allow_unauthenticated_localhost === true,
    resource_url: normalizeUrl(raw.resource_url),
    authorization_server_url: normalizeUrl(raw.authorization_server_url ?? raw.authorization_server),
    issuer_url: normalizeUrl(raw.issuer_url ?? raw.issuer),
    scopes_supported: normalizeScopes(raw.scopes_supported),
  };
}

function normalizeMCPPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : undefined;
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...XPELL_MCP_OAUTH_SCOPES];

  const scopes = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return scopes.length > 0 ? Array.from(new Set(scopes)) : [...XPELL_MCP_OAUTH_SCOPES];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
