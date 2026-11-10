import type { XpellMCPIncomingRequest } from "./MCPAuth.js";
import type { XpellMCPSettings } from "./MCPConfig.js";

export const XPELL_MCP_PROTECTED_RESOURCE_METADATA_BASE_PATH = "/.well-known/oauth-protected-resource";

export type XpellMCPUrlContext = XpellMCPIncomingRequest & {
  protocol?: string;
  secure?: boolean;
};

export type XpellMCPProtectedResourceMetadata = {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ["header"];
};

export function createXpellMCPProtectedResourceMetadata(
  settings: XpellMCPSettings,
  ctx: XpellMCPUrlContext = {},
): XpellMCPProtectedResourceMetadata {
  const origin = resolveXpellMCPRequestOrigin(ctx);
  const authorization_server = resolveXpellMCPAuthorizationServer(settings, origin);

  return {
    resource: resolveXpellMCPResourceUrl(settings, origin),
    authorization_servers: [authorization_server],
    scopes_supported: [...settings.scopes_supported],
    bearer_methods_supported: ["header"],
  };
}

export function createXpellMCPWWWAuthenticateChallenge(
  settings: XpellMCPSettings,
  ctx: XpellMCPUrlContext = {},
): string {
  const origin = resolveXpellMCPRequestOrigin(ctx);
  const metadata_url = joinOriginPath(origin, getXpellMCPProtectedResourceMetadataPath(settings.path));
  const scope = settings.scopes_supported.join(" ");

  return `Bearer resource_metadata="${escapeAuthParam(metadata_url)}", scope="${escapeAuthParam(scope)}"`;
}

export function getXpellMCPProtectedResourceMetadataPath(resource_path = "/mcp"): string {
  return `${XPELL_MCP_PROTECTED_RESOURCE_METADATA_BASE_PATH}${normalizePath(resource_path)}`;
}

export function resolveXpellMCPResourceUrl(
  settings: XpellMCPSettings,
  origin = DEFAULT_LOCAL_ORIGIN,
): string {
  return settings.resource_url ?? joinOriginPath(origin, settings.path);
}

export function resolveXpellMCPAuthorizationServer(
  settings: XpellMCPSettings,
  origin = DEFAULT_LOCAL_ORIGIN,
): string {
  return settings.authorization_server_url ?? settings.issuer_url ?? origin;
}

export function resolveXpellMCPRequestOrigin(ctx: XpellMCPUrlContext = {}): string {
  const forwarded_proto = firstForwarded(readHeader(ctx, "x-forwarded-proto"));
  const forwarded_host = firstForwarded(readHeader(ctx, "x-forwarded-host"));
  const host = forwarded_host || readHeader(ctx, "host");
  if (host) {
    const protocol = forwarded_proto || ctx.protocol || (ctx.secure ? "https" : "http");
    return `${protocol}://${host}`.replace(/\/+$/, "");
  }

  return DEFAULT_LOCAL_ORIGIN;
}

function joinOriginPath(origin: string, path: string): string {
  const normalized_origin = origin.replace(/\/+$/, "");
  return `${normalized_origin}${normalizePath(path)}`;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function firstForwarded(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
}

function readHeader(ctx: XpellMCPUrlContext, name: string): string | undefined {
  const headers = ctx.headers ?? {};
  const value = headers[name] ?? headers[name.toLowerCase()];

  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function escapeAuthParam(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

const DEFAULT_LOCAL_ORIGIN = "http://localhost:3000";
