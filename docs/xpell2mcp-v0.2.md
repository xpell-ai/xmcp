# Xpell2MCP v0.2

**Read-only proof of concept for review.** A capability is an application operation, an MCP tool is a consumer-facing projection, and XCommand is the native invocation. A host defines the projection, selects a catalog for the current actor and context, and executes the operation through the existing Xpell runtime. In-process hosts can use the registry independently of the MCP transport. Core, XNode, Wormholes and XAgent keep their existing contracts.

## Registry lifecycle

| Method | Contract |
| --- | --- |
| `discover()` | Returns frozen module/operation/description records using the loaded runtime's Core Skills. Reflection is descriptive and can miss inherited commands. |
| `expose(definition)` | Registers a unique tool name for one fixed, loaded module and canonical hyphenated operation. Requires explicit read effect, read permission, schemas, authorization and projection. The target module instance and operation are checked again during selection and invocation. |
| `seal()` | Ends registration for this registry. Contextual tools are available only after sealing. Build a replacement registry to change the catalog. |
| `select(selection, context)` | Returns a frozen list of frozen tool summaries passing authorization, availability and relevance checks. Matches any label within a group or tag filter and both filters when supplied together. An empty filter admits all eligible tools. Names sort lexically. The default view limit is 32 and the maximum is 64. |
| `invoke(name, input, context)` | Trusted in-process entry for a sealed native exposure. Validates arguments and rechecks the actor, readiness, target, authorization and availability. Resolves to the same bounded projected data sent as MCP structured content. Rejects with a safe `XError`. |
| `register(tool)`, `listTools()`, `registerWithServer(server)` | Existing curated and host-custom handler path. The original list contains curated/custom entries. The optional second argument to `registerWithServer` supplies a verified actor and selector for a fresh server instance. |

Build the catalog after modules load. Set the existing XMCP runtime readiness through the owning host lifecycle. A custom registry starts empty. The default curated registry is used only when the host omits a registry. Native exposures share the tool-name namespace with manually registered handlers. Manually registered handlers keep their existing policy contract.

## Example

The module in this example implements a read of public catalog data and retains its own domain policy. `publicCatalogOwners` and `catalogEnabled` represent server-owned state.

```ts
import { MCPToolRegistry, mountXpellMCPRoute } from "@xpell/mcp";
import { z } from "zod";

const registry = new MCPToolRegistry();

// The host has already loaded the catalog module.
registry.expose({
  _name: "catalog_read",
  _module: "catalog",
  _op: "get-public-item",
  _description: "Read a public catalog item's title.",
  _effect: "read",
  _permission: "runtime:read",
  _groups: ["catalog"],
  _tags: ["summary"],
  _input_schema: z.strictObject({ item_id: z.string().min(1).max(64) }),
  _output_schema: z.strictObject({ title: z.string().max(160) }),
  _is_available: (actor) => catalogEnabled(actor._account_id),
  _authorize: (actor, input) => {
    const account_id = actor._account_id;
    if (typeof account_id !== "string" || !isCatalogReader(account_id)) return false;
    return input === undefined ||
      publicCatalogOwners.get(String(input.item_id)) === account_id;
  },
  _project: (result) => ({ title: (result as { title: string }).title }),
});
registry.seal();

mountXpellMCPRoute(app, {
  _registry: registry,
  _settings: { enabled: true, require_auth: true },
  _select_exposure: ({ _auth }) => ({
    _groups: scopesForAccount(_auth?._account_id),
    _limit: 16,
  }),
});

// Use the same registry in a trusted in-process host.
const view = registry.select({ _groups: ["catalog"] }, verifiedContext);
const item = await registry.invoke("catalog_read", { item_id: "item-7" }, verifiedContext);
```

`_authorize(actor, undefined)` admits the identity to the tool catalog. `_authorize(actor, input)` additionally decides access to the requested resource. Invocation requires both to return true. `_is_available(actor)` is a separate optional business-state condition. Hooks and selectors are synchronous in this PoC. Exceptions fail closed. Selection hints only affect which tools the host advertises. Native invocation applies policy and readiness independently of a previous list or selection.

## Request and result boundaries

- **Actor.** The HTTP adapter authenticates the bearer through XAuth. The SDK's per-request factory receives verified auth, builds a fresh server and registers only the eligible exposures for that request. The call callback compares the verified claims with the factory actor and applies the invocation checks again. A native host supplies the existing `XpellMCPToolContext._auth` from its own verification boundary. The new exposure path requires `_authenticated: true`, a verified user, account, agent or subject identifier, and the explicit `xpell:read` claim in `scope`. Curated tools keep their existing credential and permission checks.
- **Invocation.** XMCP constructs an XCommand-compatible object with a fixed module and operation, frozen validated arguments and projected server-owned claims in `_params._auth` and `_ctx._auth`. The context carries the limited identity and scope fields that the adapter uses. The bearer and other transport metadata stay at the HTTP boundary. The module remains responsible for the semantics of its operation. The host must choose an actual read operation, since runtime metadata cannot prove its effects.
- **Schemas.** The supported Zod profile is a strict object with bounded strings and arrays, booleans, finite numbers, string enums or supported literals, optional fields and nested strict objects. Use built-in synchronous constraints. Defaults, transforms, custom checks, open records, unions and recursive schemas are outside this profile. The SDK wrapper checks raw tool arguments against the same budget and validator as the native path. Identity, scope, dispatch, output routing and transport field names are reserved throughout the schema and value.
- **Results.** Supply a projection that copies only the permitted data. XMCP bounds and validates the projection, applies its existing redaction mapper, and checks the redacted structured content again. A returned native `_ok: false`, thrown native error, or invalid projection yields a fixed safe failure. Hosts should treat the projection as the application data boundary, including for values that lack recognizable credential formats.
- **Limits.** Up to 64 exposed entries, 16 group/tag labels per filter or definition, 32 fields per object, 64 items per array, 8 levels of nesting and 16 KiB per schema. Configurable defaults and maxima respectively are 4/16 KiB and 128/512 values for input, 16/64 KiB and 256/1024 values for projected structured output, and 2/10 seconds for the read deadline. The root counts as one value. Limits are checked on tool arguments after transport parsing. Hosts own the HTTP body limit. The deadline bounds waiting for an asynchronous read. An operation may finish after timeout, and synchronous host work cannot be interrupted.
- **Catalog lifetime.** Server factory selection applies to the current SDK request. Use `createXpellMCPServer(options, view)` or `registerWithServer(server, view)` only on a fresh instance scoped to that verified actor. Omitting the view registers curated/custom tools only. The modern SDK emits a private, zero-TTL list, while clients determine whether and when to request a new catalog. A stale or previously discovered tool remains subject to invocation checks.

## Verification

Run `pnpm run build` and `pnpm run test` with a supported Node version in the Xpell workspace. The existing regression suite includes a source check that expects the sibling XVibe checkout. The focused suite in [read-exposure.test.ts](../src/tests/read-exposure.test.ts) exercises the following:

| Area | Evidence |
| --- | --- |
| Registry and discovery | Hidden, inherited and write fixtures, invalid/duplicate registration, canonical targets, empty catalog, legacy registration and sealing |
| Selection | Stable group/tag order, immutable summaries, size limit, verified actor and availability |
| Native dispatch | Fixed XCommand, strict arguments, reserved fields, missing actor and scope, resource denial, stale catalog, target changes and runtime readiness |
| Results and limits | Schema and safe projection, native failure and exception mapping, byte/value/count limits and asynchronous deadline |
| HTTP integration | Installed MCP SDK over ephemeral loopback HTTP with synthetic auth and modules. 2025 stateless and 2026 per-request lists/calls, concurrent actor separation and same-request availability recheck |

The tests use fixture authorization and local HTTP. External clients, live OAuth, and deployed environments require separate qualification.

## Deferred stages

Typed domain batch writes require exact targets, validation, one bound confirmation, reauthorization, staleness and replay checks, and authoritative readback. Atomic operations can commit as a unit. Other operations need explicit partial outcomes. Product and ADK action lifecycles own those rules. Shared XAgent selection, semantic expansion and bounded composition need separate design and review.
