# @xpell/mcp

MCP adapter for Xpell server runtimes.

Current scope:

- Streamable HTTP only.
- Mounted into the existing XWeb server at `/mcp`.
- Disabled by default.
- Uses XSettings key `mcp`.
- Reuses `xauth.authorize_req` for bearer JWT authorization.
- Supports OAuth protected-resource discovery for MCP clients.
- Supports XAuth-owned OAuth authorization-code + PKCE issuance for MCP access tokens.
- Does not expose arbitrary `_x.execute`.
- Does not depend on XVibe.
- Does not implement Xpell as an MCP client.

## Settings

`@xpell/mcp` uses the existing XSettings store:

```json
{
  "mcp": {
    "enabled": false,
    "transport": "streamable-http",
    "path": "/mcp",
    "require_auth": true,
    "allow_unauthenticated_localhost": false,
    "resource_url": "https://xpell.example.com/mcp",
    "authorization_server_url": "https://xpell.example.com",
    "issuer_url": "https://xpell.example.com",
    "scopes_supported": ["xpell:read", "xpell:write", "xpell:admin"]
  }
}
```

When `enabled` is `false`, XWeb still installs a disabled guard for the configured path so `/mcp` returns `E_XMCP_DISABLED` instead of falling through to the generic XWeb fallback.

## Auth

When `require_auth` is true, clients must send:

```http
Authorization: Bearer <JWT>
```

The adapter passes the token to Xpell through:

```json
{
  "_module": "xauth",
  "_op": "authorize_req",
  "_params": {
    "_ctx": {
      "_source": "mcp",
      "_transport": "streamable-http"
    },
    "_token": "<JWT>"
  }
}
```

Tool arguments are never trusted as authentication context.

Browser session JWTs are not accepted as MCP bearer credentials. MCP JWTs issued by `/xauth/mcp-token` carry `_token_purpose: "mcp"` and `_audience: "mcp"` and continue to be authorized through `xauth.authorize_req`.

## OAuth Discovery

XWeb advertises `/mcp` as an OAuth-protected MCP resource while preserving the legacy bearer flow:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`

The protected-resource metadata identifies the canonical `/mcp` URL, the XAuth authorization server, supported scopes, and header bearer usage. If `resource_url`, `authorization_server_url`, or `issuer_url` are not configured, URLs are derived from the incoming request host and forwarded protocol headers.

Unauthenticated or invalid `/mcp` requests return `401` with:

```http
WWW-Authenticate: Bearer resource_metadata="https://xpell.example.com/.well-known/oauth-protected-resource/mcp", scope="xpell:read xpell:write xpell:admin"
```

The authorization-server metadata advertises the canonical OAuth endpoints:

- `/oauth/authorize`
- `/oauth/token`
- `/oauth/revoke`

`/oauth/authorize` implements authorization-code requests with PKCE S256. It reuses the existing XAuth browser session cookie, renders a minimal login form when no browser session is present, and renders a minimal consent step before issuing a one-time authorization code.

`/oauth/token` supports:

```text
grant_type=authorization_code
grant_type=refresh_token
```

The authorization-code exchange validates the one-time code, `client_id`, exact `redirect_uri`, exact `resource`, and PKCE verifier before returning a short-lived MCP access token and an opaque refresh token.

Refresh tokens are server-side grant credentials, not browser sessions. XAuth stores only keyed HMAC-SHA256 refresh-token hashes in XDB records under the `xauth_oauth_refresh_tokens` entity. Records include the grant/family id, client id, user/account ids, clearance, resource, scopes, created/expiry timestamps, replacement linkage, and revocation fields. Raw refresh tokens are not persisted.

Refresh-token exchange validates the exact client/resource binding and can only reproduce the stored scopes or narrow them to a subset. Refresh tokens rotate on every successful refresh. Reusing an already replaced token is treated as replay and revokes the full grant family, including the newest descendant.

`/oauth/revoke` revokes refresh-token grant families and returns an OAuth-compatible success response without revealing token validity. Access tokens are not persisted or revoked individually in this phase; they remain short-lived MCP JWTs and expire according to `XAUTH_MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN`.

The authorization server supports public MCP clients through Client ID Metadata Documents. The `client_id` must be an HTTPS metadata URL, except loopback HTTP is allowed for local development. The metadata document must list the exact `redirect_uri` and support token endpoint auth method `none`.

Native loopback redirects follow RFC 8252: a registered public-client redirect such as `http://127.0.0.1/callback` or `http://localhost/callback` may use an ephemeral request port such as `http://127.0.0.1:53158/callback`. Only the port may vary. Scheme, loopback host, path, query parameters, userinfo, and fragment rules remain strict. Normal HTTPS redirects still require an exact registered URI match.

Successful authorization redirects include `code`, the original `state` when provided, and `iss` matching the authorization-server metadata issuer. Access tokens are XAuth-signed JWTs with `_token_purpose: "mcp"`, `_audience: "mcp"`, `aud`/`resource` bound to the canonical `/mcp` URL, `scope`, `client_id`, `grant_id`, `family_id`, `sub`, `iat`, `exp`, and `jti`.

OAuth lifetime configuration:

- `XAUTH_MCP_OAUTH_ACCESS_TOKEN_EXPIRES_IN`, default `15m`
- `XAUTH_MCP_OAUTH_REFRESH_TOKEN_EXPIRES_IN`, default `90d`
- `XAUTH_MCP_OAUTH_GRANT_EXPIRES_IN`, default `90d`
- `XAUTH_MCP_OAUTH_REFRESH_TOKEN_HASH_SECRET`, optional HMAC key override; defaults to the XAuth JWT secret

Current authorization behavior is fixed at grant time because XAuth currently has no separate durable user/account authorization store to re-check during refresh. Refresh never increases clearance or scopes.

Post-Phase 3 boundary: connected-client management UI, persistent grant administration tooling, optional per-access-token revocation/jti tracking, and richer client trust policy.

## Tools

The curated registry exposes bounded runtime tools through the official MCP SDK:

- `xpell_server_status`
- `xpell_get_capabilities`
- `xpell_list_apps`
- `xpell_get_app`
- `xpell_list_views`
- `xpell_get_view`
- `xpell_list_flows`
- `xpell_get_flow`
- `xpell_list_entities`
- `xpell_get_entity_schema`
- `xpell_apply_view_edit`
- `xpell_apply_semantic_view_edit` when XVibe exposes `plan-semantic-view-edit`
- `xpell_create_data_feature` when XVibe exposes `data-feature`

`xpell_create_data_feature` is a thin adapter to `xvibe.data-feature`. It accepts structured Data Feature fields only, defaults to plan-only `apply: false`, does not expose arbitrary execution-graph execution, and leaves validation, planning, conflict detection, execution, and partial failure behavior to XVibe.

## Codex Configuration

Generate the current Codex configuration with:

```sh
codex mcp add xpell --url http://localhost:3000/mcp --bearer-token-env-var XPELL_MCP_TOKEN
```

Equivalent TOML:

```toml
[mcp_servers.xpell]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "XPELL_MCP_TOKEN"
```

Do not hardcode the JWT in configuration. Set `XPELL_MCP_TOKEN` in the environment that starts Codex.

## Local Verification

Start XNode with MCP enabled in `settings/server-settings.json`, create or obtain an admin JWT through `xauth`, export it as `XPELL_MCP_TOKEN`, then verify:

- missing auth returns `401`
- invalid auth returns `401`
- `tools/list` returns the curated tool set available for the loaded runtime modules
- read tools return successful structured content
- disabled MCP returns `404` with `E_XMCP_DISABLED`
