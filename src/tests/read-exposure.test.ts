import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { _x, XModule, XResponseError, type XCommand } from "@xpell/core";
import { z } from "zod";
import {
  MCPToolRegistry, createXpellMCPRequestHandler, markXpellMCPRuntimeReady,
  markXpellMCPRuntimeStarting, type XpellMCPExposureDefinition, type XpellMCPExposureSelector,
  type XpellMCPToolContext,
} from "../index.js";

const INPUT = z.strictObject({
  resource_id: z.string().min(1).max(48),
  options: z.strictObject({ brief: z.boolean() }).optional(),
  fields: z.array(z.string().max(12)).max(4).optional(),
});
const OUTPUT = z.strictObject({ title: z.string().max(100) });
const MODULE = "test-catalog";

function actor(account = "north"): XpellMCPToolContext {
  return {
    _auth: {
      _authenticated: true,
      _user_id: account + "-user",
      _account_id: account,
      scope: "xpell:read",
      _token: "fixture-secret",
    },
  };
}

class HiddenCatalogMethods extends XModule {
  _inherited_read() {
    return { title: "Inherited" };
  }
}

class TestCatalog extends HiddenCatalogMethods {
  calls: XCommand[] = [];
  state = true;
  outcome: "success" | "failure" | "response-error" | "throw" | "slow" | "large" = "success";
  pause?: (actor: string) => Promise<void>;

  constructor() {
    super({ _name: MODULE });
  }

  async _read_catalog(command: XCommand) {
    this.calls.push(command);
    const auth = command._params?._auth as Record<string, string>;
    await this.pause?.(auth._account_id);
    switch (this.outcome) {
      case "failure": return { _ok: false, _result: { _message: "private failure detail" } };
      case "response-error": return new XResponseError(new Error("private class failure"));
      case "throw": throw new Error("private thrown detail");
      case "large": return { title: "x".repeat(4001) };
      case "slow": await delay(80); break;
    }
    return { title: auth._account_id + " catalog", private_note: "unprojected fixture data" };
  }

  _read_availability(command: XCommand) {
    this.calls.push(command);
    return { title: "In stock" };
  }

  _hidden_read() {
    throw new Error("An unregistered operation must never be invoked");
  }

  _change_catalog() {
    throw new Error("A write must never be invoked");
  }
}

class TestReadAuth extends XModule {
  constructor() {
    super({ _name: "xauth" });
  }

  _authorize_req(command: XCommand) {
    const token = command._params?._token;
    if (token !== "north" && token !== "south" && token !== "no-read") return { _authenticated: false };
    return {
      ...actor(token)._auth,
      _auth_type: "fixture",
      scope: token === "no-read" ? "xpell:write" : "xpell:read",
    };
  }
}

async function fixture(t: TestContext) {
  const module = new TestCatalog();
  await _x.loadModuleAsync(module);
  await _x.loadModuleAsync(new TestReadAuth());
  markXpellMCPRuntimeReady("read_exposure_fixture");
  t.after(() => {
    // Each node:test file runs in its own process. Restore this fixture's entries.
    const modules = (_x as unknown as { _modules: Record<string, XModule> })._modules;
    delete modules[MODULE];
    delete modules.xauth;
    markXpellMCPRuntimeStarting("read_exposure_fixture_stopped");
  });

  const registry = new MCPToolRegistry();
  const definition: XpellMCPExposureDefinition = {
    _module: MODULE,
    _op: "read-catalog",
    _name: "catalog_read",
    _description: "Read a synthetic catalog.",
    _effect: "read",
    _permission: "runtime:read",
    _groups: ["catalog"],
    _tags: ["summary"],
    _input_schema: INPUT,
    _output_schema: OUTPUT,
    _authorize: (claims, input) => claims._account_id === "north" || claims._account_id === "south"
      ? input === undefined || input.resource_id === claims._account_id + "-public"
      : false,
    _is_available: () => module.state,
    _project: (value) => ({ title: (value as { title: string }).title }),
  };
  const input = { resource_id: "north-public" };
  return { registry, definition, input, module };
}

const errorCode = (code: string) => (error: unknown) => {
  const mapped = error as { _code: string; message: string; _cause?: unknown; _meta?: unknown };
  assert.equal(mapped._code, code);
  assert.doesNotMatch(mapped.message, /private|fixture-secret/);
  assert.equal(mapped._cause, undefined);
  assert.equal(mapped._meta, undefined);
  return true;
};

test("discovery describes hidden methods without exposing them; empty and unsealed catalogs deny", async (t) => {
  const { registry, definition, input } = await fixture(t);
  const ops = registry.discover().filter((item) => item._module === MODULE);
  assert.ok(ops.some((item) => item._op === "hidden-read"));
  assert.ok(ops.some((item) => item._op === "change-catalog"));
  assert.equal(ops.some((item) => item._op === "inherited-read"), false);
  assert.ok(Object.isFrozen(registry.discover()));
  assert.deepEqual(registry.select({}, actor()), []);
  registry.expose(definition);
  assert.deepEqual(registry.select({}, actor()), []);
  await assert.rejects(registry.invoke("catalog_read", input, actor()), errorCode("E_XMCP_EXPOSURE_UNAVAILABLE"));
  registry.seal();
  assert.deepEqual(registry.select({}, actor()).map((tool) => tool._name), ["catalog_read"]);
  assert.deepEqual(registry.listTools(), []);
  for (const name of ["hidden-read", "change-catalog", "test-catalog:read-catalog"]) {
    await assert.rejects(registry.invoke(name, input, actor()), errorCode("E_XMCP_EXPOSURE_UNAVAILABLE"));
  }
});

test("registration rejects missing targets, wildcard, write permission, invalid schemas and duplicate names", async (t) => {
  const { registry, definition } = await fixture(t);
  const invalid: [Partial<XpellMCPExposureDefinition>, RegExp][] = [
    [{ _module: "unloaded" }, /loaded module operation/],
    [{ _op: "unknown" }, /loaded module operation/],
    [{ _module: "*" }, /fixed canonical/],
    [{ _op: "*" }, /fixed canonical/],
    [{ _name: "read*" }, /fixed canonical/],
    [{ _op: "read_catalog" }, /fixed canonical/],
    [{ _effect: "write" as "read" }, /read effect/],
    [{ _permission: "runtime:write" as "runtime:read" }, /runtime:read/],
    [{ _authorize: undefined }, /host policy/],
    [{ _project: undefined }, /output projection/],
    [{ _input_schema: z.object({ resource_id: z.string().max(32) }) }, /strict, bounded/],
    [{ _input_schema: z.strictObject({ field: z.string() }) }, /strict, bounded/],
    [{ _input_schema: z.strictObject({ field: z.array(z.boolean()) }) }, /strict, bounded/],
    [{ _input_schema: z.strictObject({ field: z.object({ resource: z.boolean() }) }) }, /strict, bounded/],
    [{ _input_schema: z.strictObject({ field: z.strictObject({ _auth: z.boolean() }) }) }, /strict, bounded/],
    [{ _input_schema: z.strictObject({ field: z.any() }) }, /strict, bounded/],
    [{ _input_schema: z.strictObject({ field: z.string().max(9).refine(async () => false) }) }, /strict, bounded/],
    [{ _output_schema: z.object({ title: z.string().max(32) }) }, /strict, bounded/],
    [{ _limits: { _max_input_bytes: Infinity } }, /Invalid exposure limit/],
    [{ _limits: { _timeout_ms: 0 } }, /Invalid exposure limit/],
  ];
  for (const [override, expected] of invalid) {
    assert.throws(() => registry.expose({ ...definition, ...override }), expected, JSON.stringify(override));
  }

  registry.expose(definition);
  assert.throws(() => registry.expose(definition), /already registered/);
  const custom = {
    _name: definition._name, _description: "Custom", _input_schema: z.object({}),
    _permission: "runtime:read" as const, _handler: () => ({}),
  };
  assert.throws(() => registry.register(custom), /already registered/);
  registry.register({ ...custom, _name: "custom_read" });
  assert.throws(() => registry.expose({ ...definition, _name: "custom_read" }), /already registered/);
  registry.seal();
  assert.throws(() => registry.expose({ ...definition, _name: "extra" }), /sealed/);
  assert.throws(() => registry.register({ ...custom, _name: "extra" }), /sealed/);
  assert.deepEqual(registry.listTools().map((tool) => tool._name), ["custom_read"]);
});

test("a host can explicitly expose a native read that reflection omits", async (t) => {
  const { registry, definition, input } = await fixture(t);
  assert.equal(registry.discover().some((op) => op._op === "inherited-read"), false);
  registry.expose({ ...definition, _op: "inherited-read" });
  registry.seal();
  assert.deepEqual(await registry.invoke("catalog_read", input, actor()), { title: "Inherited" });
});

test("selection is stable, scoped, bounded and non-mutating; relevance does not grant permission", async (t) => {
  const { registry, definition } = await fixture(t);
  const tags = ["summary"];
  registry.expose({ ...definition, _name: "z_catalog", _tags: tags });
  registry.expose({
    ...definition, _name: "a_stock", _groups: ["stock"], _tags: ["detail"], _op: "read-availability",
    _authorize: (claims, input) => claims._account_id === "south" &&
      (input === undefined || input.resource_id === "south-public"),
  });
  registry.expose({ ...definition, _name: "b_catalog" });
  tags[0] = "changed";
  registry.seal();

  const south = actor("south");
  const names = (view: ReturnType<MCPToolRegistry["select"]>) => view.map((tool) => tool._name);
  assert.deepEqual(names(registry.select({}, south)), ["a_stock", "b_catalog", "z_catalog"]);
  assert.deepEqual(names(registry.select({}, actor())), ["b_catalog", "z_catalog"]);
  assert.deepEqual(names(registry.select({ _groups: ["stock", "catalog"], _tags: ["summary"], _limit: 1 }, south)), ["b_catalog"]);
  const view = registry.select({ _groups: ["catalog"], _tags: ["summary"] }, south);
  assert.deepEqual(names(view), ["b_catalog", "z_catalog"]);
  assert.ok(Object.isFrozen(view) && Object.isFrozen(view[0]));
  assert.deepEqual(registry.select({ _groups: ["stock"] }, actor()), []);
  assert.deepEqual(registry.select({ _tags: ["changed"] }, south), []);
  assert.throws(() => registry.select({ _limit: 65 }, south), /limit/);
  assert.throws(() => registry.select({ _groups: ["*"] }, south), /groups and tags/);
  assert.deepEqual(await registry.invoke("b_catalog", { resource_id: "south-public" }, south), { title: "south catalog" });
});

test("native invocation sends only a fixed command and verified scoped actor, with explicit output projection", async (t) => {
  const { registry, definition, module, input } = await fixture(t);
  registry.expose(definition);
  registry.seal();
  assert.deepEqual(await registry.invoke("catalog_read", input, actor()), { title: "north catalog" });
  assert.equal(module.calls.length, 1);
  const cmd = module.calls[0] as XCommand & { _ctx: { _auth: Record<string, unknown> } };
  assert.deepEqual(Object.keys(cmd).sort(), ["_ctx", "_module", "_op", "_params"]);
  assert.equal(cmd._module, MODULE);
  assert.equal(cmd._op, "read-catalog");
  assert.equal(cmd._params?.resource_id, "north-public");
  assert.equal(cmd._params?._auth, cmd._ctx._auth);
  assert.ok(Object.isFrozen(cmd._ctx._auth));
  assert.equal(cmd._ctx._auth._account_id, "north");
  assert.equal(Object.hasOwn(cmd._ctx._auth, "_token"), false);
});

test("native invocation rejects unexpected or reserved arguments and nested identity before dispatch", async (t) => {
  const { registry, definition, module, input } = await fixture(t);
  registry.expose(definition);
  registry.seal();
  for (const key of ["_module", "_op", "_object", "_output", "_params", "_auth", "_ctx", "_account_id", "app_id", "extra"]) {
    await assert.rejects(registry.invoke("catalog_read", { ...input, [key]: "bad" }, actor()),
      errorCode("E_XMCP_EXPOSURE_INPUT"));
  }
  for (const args of [{}, null, [], { resource_id: 100 }, { ...input, options: { brief: true, _actor: "bad" } }]) {
    await assert.rejects(registry.invoke("catalog_read", args, actor()), errorCode("E_XMCP_EXPOSURE_INPUT"));
  }
  assert.equal(module.calls.length, 0);
});

test("invocation fails closed for missing actors, missing scope, resource denial and throwing policy", async (t) => {
  const { registry, definition, module, input } = await fixture(t);
  registry.expose(definition);
  registry.expose({ ...definition, _name: "broken", _authorize: () => { throw new Error("private policy detail"); } });
  registry.expose({
    ...definition, _name: "async_policy",
    _authorize: (async () => { throw new Error("private async policy"); }) as unknown as typeof definition._authorize,
  });
  registry.seal();
  for (const context of [{}, { _auth: { _user_id: "north-user", scope: "xpell:read" } },
    { _auth: { _authenticated: true, scope: "xpell:read" } }, { _auth: { ...actor()._auth, scope: "xpell:write" } }]) {
    assert.deepEqual(registry.select({}, context), []);
    await assert.rejects(registry.invoke("catalog_read", input, context), errorCode("E_XMCP_EXPOSURE_FORBIDDEN"));
  }
  for (const [name, context] of [["catalog_read", actor("south")], ["broken", actor()], ["async_policy", actor()]] as const) {
    await assert.rejects(registry.invoke(name, input, context), errorCode("E_XMCP_EXPOSURE_FORBIDDEN"));
  }
  assert.equal(module.calls.length, 0);
});

test("a previously selected tool rechecks live readiness, policy, availability and target identity", async (t) => {
  const { registry, definition, module, input } = await fixture(t);
  let allowed = true;
  registry.expose({ ...definition, _authorize: () => allowed });
  registry.seal();
  const [previous] = registry.select({}, actor());
  assert.ok(previous);
  module.state = false;
  await assert.rejects(registry.invoke(previous._name, input, actor()), errorCode("E_XMCP_EXPOSURE_UNAVAILABLE"));
  module.state = true;
  allowed = false;
  await assert.rejects(registry.invoke(previous._name, input, actor()), errorCode("E_XMCP_EXPOSURE_FORBIDDEN"));
  allowed = true;
  markXpellMCPRuntimeStarting("fixture_restart");
  await assert.rejects(registry.invoke(previous._name, input, actor()), errorCode("E_XMCP_RUNTIME_NOT_READY"));
  markXpellMCPRuntimeReady("fixture_ready");
  module._read_catalog = async () => ({ title: "Changed target" });
  await assert.rejects(registry.invoke(previous._name, input, actor()), errorCode("E_XMCP_EXPOSURE_UNAVAILABLE"));
  assert.equal(module.calls.length, 0);
});

test("native errors including returned _ok:false, projection mismatch and output redaction are safe", async (t) => {
  const { registry, definition, module, input } = await fixture(t);
  registry.expose(definition);
  registry.expose({ ...definition, _name: "bad_projection", _project: () => ({ title: 4, extra: "private" }) });
  registry.expose({ ...definition, _name: "redact", _project: () => ({ title: "Bearer sensitive-value" }) });
  registry.seal();
  for (const outcome of ["failure", "response-error", "throw"] as const) {
    module.outcome = outcome;
    await assert.rejects(registry.invoke("catalog_read", input, actor()), errorCode("E_XMCP_EXPOSURE_READ_FAILED"));
  }
  module.outcome = "success";
  await assert.rejects(registry.invoke("bad_projection", input, actor()), errorCode("E_XMCP_EXPOSURE_OUTPUT"));
  assert.deepEqual(await registry.invoke("redact", input, actor()), { title: "Bearer [redacted]" });
});

test("per-tool byte/value bounds, bounded collection schemas and read deadline are enforced", async (t) => {
  const { registry, definition, module, input } = await fixture(t);
  registry.expose({ ...definition, _limits: { _max_input_bytes: 40, _max_input_values: 3 } });
  registry.expose({ ...definition, _name: "byte_output", _limits: { _max_output_bytes: 16 } });
  registry.expose({ ...definition, _name: "value_output", _limits: { _max_output_values: 1 } });
  registry.expose({ ...definition, _name: "short_deadline", _limits: { _timeout_ms: 10 } });
  registry.seal();

  for (const args of [
    { resource_id: "x".repeat(40) },
    { ...input, fields: ["a", "b", "c"] },
    { ...input, fields: ["a", "b", "c", "d", "e"] },
  ]) await assert.rejects(registry.invoke("catalog_read", args, actor()), errorCode("E_XMCP_EXPOSURE_INPUT"));
  assert.equal(module.calls.length, 0);
  for (const name of ["byte_output", "value_output"]) {
    await assert.rejects(registry.invoke(name, input, actor()), errorCode("E_XMCP_EXPOSURE_OUTPUT"));
  }
  module.outcome = "large";
  await assert.rejects(registry.invoke("catalog_read", input, actor()), errorCode("E_XMCP_EXPOSURE_OUTPUT"));
  module.outcome = "slow";
  await assert.rejects(registry.invoke("short_deadline", input, actor()), errorCode("E_XMCP_EXPOSURE_TIMEOUT"));
  assert.ok(module.calls.length > 0);
});

async function sdkEndpoint(
  t: TestContext,
  registry: MCPToolRegistry,
  select?: XpellMCPExposureSelector,
  requireAuth = true,
) {
  const handler = createXpellMCPRequestHandler({
    _registry: registry, _select_exposure: select,
    _settings: { enabled: true, require_auth: requireAuth, allow_unauthenticated_localhost: !requireAuth },
  });
  const server = createServer((request, response) => {
    // Model an upstream Express request that already has an unrelated auth field.
    if (!requireAuth) Object.assign(request, { auth: { extra: actor()._auth } });
    void handler(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) =>
    server.once("error", reject).listen(0, "127.0.0.1", resolve)
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");

  let id = 0;
  return async (method: string, token: string, params: Record<string, unknown> = {}, modern = false) => {
    const protocol = modern ? "2026-07-28" : "2025-11-25";
    const modernHeaders = modern
      ? { "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}) }
      : undefined;
    const meta = modern ? { _meta: {
      "io.modelcontextprotocol/protocolVersion": protocol,
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "xmcp-fixture", version: "0.1.0" },
    } } : undefined;
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": protocol, authorization: `Bearer ${token}`, ...modernHeaders,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: { ...params, ...meta } }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return { status: response.status, response: JSON.parse(data ? data.slice(6) : text) };
  };
}

test("SDK HTTP path selects per actor, validates raw calls, and isolates concurrent native invocations", async (t) => {
  const { registry, definition, module, input } = await fixture(t);
  registry.expose({ ...definition, _limits: { _max_input_bytes: 64 } });
  registry.expose({ ...definition, _name: "stock_read", _groups: ["stock"], _op: "read-availability" });
  registry.seal();
  const call = await sdkEndpoint(t, registry, ({ _auth }) => ({
    _groups: _auth?._account_id === "north" ? ["catalog"] : ["stock", "catalog"],
  }));
  const [north, south] = await Promise.all([call("tools/list", "north"), call("tools/list", "south")]);
  assert.equal(north.status, 200);
  assert.equal(south.status, 200);
  assert.deepEqual(north.response.result.tools.map((tool: { name: string }) => tool.name), ["catalog_read"]);
  assert.deepEqual(south.response.result.tools.map((tool: { name: string }) => tool.name), ["catalog_read", "stock_read"]);
  assert.equal(north.response.result.tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual((await call("tools/list", "no-read")).response.result.tools, []);

  const tool = (token: string, name: string, args: object) =>
    call("tools/call", token, { name, arguments: args });
  for (const name of ["stock_read", "hidden_read", "change_catalog"]) {
    const denied = await tool("north", name, input);
    assert.ok(denied.response.error || denied.response.result?.isError);
  }
  const invalid = await tool("north", "catalog_read", { ...input, _auth: "hidden-argument-marker" });
  assert.ok(invalid.response.error || invalid.response.result?.isError);
  assert.doesNotMatch(JSON.stringify(invalid.response), /hidden-argument-marker/);
  const oversized = await tool("north", "catalog_read", { ...input, fields: Array(4).fill("x".repeat(12)) });
  assert.ok(oversized.response.error || oversized.response.result?.isError);
  const deniedResource = await tool("north", "catalog_read", { resource_id: "south-public" });
  assert.equal(deniedResource.response.result.isError, true);
  assert.equal(deniedResource.response.result.structuredContent._error._code, "E_XMCP_EXPOSURE_FORBIDDEN");
  assert.equal(module.calls.length, 0);

  const arrived: string[] = [];
  let release!: () => void;
  const both = new Promise<void>((resolve) => { release = resolve; });
  module.pause = async (account) => {
    arrived.push(account);
    if (arrived.length === 2) release();
    await both;
  };
  const [northCall, southCall] = await Promise.all([
    tool("north", "catalog_read", input), tool("south", "catalog_read", { resource_id: "south-public" }),
  ]);
  assert.deepEqual(arrived.sort(), ["north", "south"]);
  assert.deepEqual(northCall.response.result.structuredContent, { title: "north catalog" });
  assert.deepEqual(southCall.response.result.structuredContent, { title: "south catalog" });
  module.pause = undefined;
  module.outcome = "failure";
  const resultFailure = await tool("north", "catalog_read", input);
  assert.equal(resultFailure.response.result.isError, true);
  assert.doesNotMatch(JSON.stringify(resultFailure.response), /private failure detail/);
  module.state = false;
  const stale = await tool("north", "catalog_read", input);
  assert.ok(stale.response.error || stale.response.result?.isError);
});

test("modern SDK HTTP catalogs are private and native invocation uses the request actor", async (t) => {
  const { registry, definition, input } = await fixture(t);
  registry.expose(definition);
  registry.seal();
  const call = await sdkEndpoint(t, registry, ({ _auth }) => ({
    _groups: _auth?._account_id === "north" ? ["catalog"] : ["stock"],
  }));
  const listed = await call("tools/list", "north", {}, true);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.response.result.tools.map((tool: { name: string }) => tool.name), ["catalog_read"]);
  assert.equal(listed.response.result.cacheScope, "private");
  assert.equal(listed.response.result.ttlMs, 0);
  assert.deepEqual((await call("tools/list", "south", {}, true)).response.result.tools, []);
  const result = await call("tools/call", "north", { name: "catalog_read", arguments: input }, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.response.result.structuredContent, { title: "north catalog" });
});

test("SDK invocation rechecks availability after registration in the same request", async (t) => {
  const { registry, definition, module, input } = await fixture(t);
  let checks = 0;
  registry.expose({ ...definition, _is_available: () => ++checks === 1 });
  registry.seal();
  const call = await sdkEndpoint(t, registry);
  const reply = await call("tools/call", "north", { name: "catalog_read", arguments: input });
  assert.equal(checks, 2);
  assert.equal(reply.response.result.isError, true);
  assert.equal(reply.response.result.structuredContent._error._code, "E_XMCP_EXPOSURE_UNAVAILABLE");
  assert.equal(module.calls.length, 0);
});

test("SDK catalog fails closed for empty registries, missing actors and selector errors", async (t) => {
  const { registry, definition } = await fixture(t);
  const empty = new MCPToolRegistry();
  empty.seal();
  assert.deepEqual((await (await sdkEndpoint(t, empty))("tools/list", "north")).response.result.tools, []);
  registry.expose(definition);
  registry.seal();
  const unauthenticated = await sdkEndpoint(t, registry, undefined, false);
  const listed = await unauthenticated("tools/list", "north");
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.response.result.tools, []);
  const badSelector = await sdkEndpoint(t, registry, () => { throw new Error("private selector detail"); });
  assert.deepEqual((await badSelector("tools/list", "north")).response.result.tools, []);
});
