# Xpell2MCP v0.3

**Prepare-only write exposure for review.** A host can add a fixed write target to the registry alongside the [v0.2 read exposures](./xpell2mcp-v0.2.md). The existing Action lifecycle owns approval and execution. XMCP prepares a pending proposal and returns a safe projection through the native registry or MCP.

## Contract

- Register a loaded module and canonical operation through `registry.expose()` with `_effect: "write"`, `_permission: "runtime:write"` and a host-owned `_prepare` hook. One target has one declared effect within the registry. The host attests the effect of the operation it registers.
- Seal the catalog as in v0.2. A verified actor must have the explicit `xpell:write` scope to list or invoke a write exposure. Read exposures retain their `xpell:read` requirement. Authorization, configured availability, readiness and target identity are checked at invocation even when a client previously listed the tool.
- Supply the same strict Zod schemas, structural limits and explicit output projection used for reads. Command routing, actor and scope fields remain reserved. Write arguments also reserve approval, binding, delivery and Action control fields at every nesting level.
- The hook gets `XpellMCPWritePreparationInput` with the fixed tool name, module and op, deeply frozen validated arguments and a frozen verified actor projection. Its result must be a host-attested pending Action with `_state: "pending"`. Project only safe proposal details with `_status: "pending"`. The output schema must accept that status, and XMCP checks the final status after validation and redaction.
- XMCP sends declared writes only to the prepare hook. The hook may persist a pending Action and must leave application data untouched. The host's confirmation channel resolves the exact Action and executes its fixed native XCommand. Keep Action bindings and confirmation credentials inside the host.
- The same per-tool `_timeout_ms` bounds how long XMCP waits for preparation. A timeout, lost response, thrown hook error or unusable projection yields `E_XMCP_EXPOSURE_PREPARATION_UNCERTAIN`. Check the host Action before submitting again. XMCP does not cancel, retry or infer rollback. Preparation may already be durable.

## Host composition example

The functions in this example belong to the host. `prepareCatalogAction` maps this fixed target to an existing Action capability and obtains the participant, conversation and delivery identity from trusted host context. It returns a pending record only after reading the Action state. Its public summary contains data intended for the requesting actor.

```ts
import { MCPToolRegistry } from "@xpell/mcp";
import { z } from "zod";

const registry = new MCPToolRegistry();
registry.expose({
  _name: "catalog_add_product",
  _module: "catalog",
  _op: "add-product",
  _description: "Prepare a product addition for human approval.",
  _effect: "write",
  _permission: "runtime:write",
  _input_schema: z.strictObject({
    catalog_id: z.string().min(1).max(64),
    product_name: z.string().min(1).max(120),
  }),
  _output_schema: z.strictObject({
    _status: z.literal("pending"),
    summary: z.string().max(200),
  }),
  _authorize: (actor, args) => canPrepareCatalogChange(actor, args?.catalog_id),
  _is_available: (actor) => catalogChangesAvailable(actor),
  _prepare: (request) => prepareCatalogAction(request),
  _project: (pending) => ({
    _status: "pending",
    summary: (pending as { publicSummary: string }).publicSummary,
  }),
});
registry.seal();

const proposal = await registry.invoke(
  "catalog_add_product",
  { catalog_id: "demo-catalog", product_name: "Sample item" },
  verifiedContext,
);
```

A Starter adapter can call its existing pending Action creation API with a capability, validated arguments, actor and persisted conversation turn. An ADK adapter can use its host-bound context and the existing prepare and inspect APIs. The host binds the target, arguments, capability revision, authority and expiry, then reauthorizes the exact proposal at confirmation. Execution claims, idempotency, recovery and fresh readback belong to the host and domain operation. Existing Starter/ADK capability schemas use bounded strings. Typed XMCP arrays need an explicitly designed host mapping before entering those contracts.

## Verification and compatibility

The v0.2 curated and contextual read tests still run. The write tests use an in-memory Action fixture and a synthetic XModule. They check scope and policy, immutable arguments, cancellation, exact confirmation, competing confirmations, safe pending output, uncertain preparation and readback. Both installed SDK HTTP wire paths are exercised over loopback with synthetic authentication. The fixture demonstrates the boundary and does not qualify a live ADK adapter or product mutation.
