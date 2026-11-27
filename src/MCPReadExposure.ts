import { _x, XError, XModule, type XCommandData } from "@xpell/core";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { getXpellMCPRuntimeReadiness } from "./MCPRuntimeReadiness.js";
import { toMCPToolResult } from "./MCPResultMapper.js";
import {
  assertExposureSchema, freezeExposurePayload, isBoundedExposurePayload, isBoundedInteger, isPlainRecord,
} from "./MCPExposureSchema.js";
import type { XpellMCPToolContext } from "./MCPToolRegistry.js";

type Claims = Readonly<NonNullable<XpellMCPToolContext["_auth"]>>;
type Payload = Readonly<Record<string, unknown>>;

export type XpellMCPExposureLimits = {
  _max_input_bytes: number;
  _max_input_values: number;
  _max_output_bytes: number;
  _max_output_values: number;
  _timeout_ms: number;
};

export type XpellMCPExposureDefinition = {
  _module: string;
  _op: string;
  _name: string;
  _description: string;
  _input_schema: z.ZodObject;
  _output_schema: z.ZodObject;
  _effect: "read";
  _permission: "runtime:read";
  _groups?: readonly string[];
  _tags?: readonly string[];
  _limits?: Partial<XpellMCPExposureLimits>;
  _authorize: (actor: Claims, input?: Payload) => boolean;
  _is_available?: (actor: Claims) => boolean;
  _project: (result: unknown) => unknown;
};

export type XpellMCPExposureSelection = {
  _groups?: readonly string[];
  _tags?: readonly string[];
  _limit?: number;
};

export type XpellMCPExposureSelector = (context: Readonly<XpellMCPToolContext>) =>
  XpellMCPExposureSelection | undefined;

export type XpellMCPExposureView = {
  _context: XpellMCPToolContext;
  _select?: XpellMCPExposureSelector;
};

export type XpellMCPDiscoveredOperation = Readonly<{
  _module: string;
  _op: string;
  _description: string;
}>;

const IDENTIFIER = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
const OPERATION = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_EXPOSURES = 64;
const DEFAULT_LIMITS: XpellMCPExposureLimits = {
  _max_input_bytes: 4096,
  _max_input_values: 128,
  _max_output_bytes: 16384,
  _max_output_values: 256,
  _timeout_ms: 2000,
};
const HARD_LIMITS: XpellMCPExposureLimits = {
  _max_input_bytes: 16384,
  _max_input_values: 512,
  _max_output_bytes: 65536,
  _max_output_values: 1024,
  _timeout_ms: 10000,
};

export type ReadExposure = Readonly<XpellMCPExposureDefinition & {
  _groups: readonly string[];
  _tags: readonly string[];
  _limits: Readonly<XpellMCPExposureLimits>;
  _instance: XModule;
  _method: unknown;
}>;

function isIdentifier(value: unknown, pattern = IDENTIFIER): value is string {
  return typeof value === "string" && value.length <= 64 && pattern.test(value);
}

function labels(values: readonly string[] = []): readonly string[] {
  if (!Array.isArray(values) || values.length > 16 || !values.every((value) => isIdentifier(value))) {
    throw new Error("Exposure groups and tags must contain at most 16 bounded identifiers each.");
  }
  return Object.freeze([...new Set(values)]);
}

export function normalizeExposureSelection(selection: XpellMCPExposureSelection) {
  if (!isPlainRecord(selection) ||
      Object.keys(selection).some((key) => !["_limit", "_groups", "_tags"].includes(key))) {
    throw new Error("Invalid exposure selection.");
  }
  const limit = selection._limit === undefined ? 32 : selection._limit;
  if (!isBoundedInteger(limit, MAX_EXPOSURES)) throw new Error("Invalid exposure catalog limit.");
  return { groups: labels(selection._groups), tags: labels(selection._tags), limit };
}

export function compareExposureNames(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

export function discoverOperations(): readonly XpellMCPDiscoveredOperation[] {
  const operations = _x.getSkills()._modules.flatMap(({ _name }) => {
    const module = _x.getModule(_name);
    return (module?.getCommandSkills() ?? []).map((op) => Object.freeze({
      _module: _name,
      _op: op._name,
      _description: op._description ?? "",
    }));
  });
  return Object.freeze(operations.sort((a, b) =>
    compareExposureNames(a._module, b._module) || compareExposureNames(a._op, b._op)
  ));
}

export function prepareReadExposure(definition: XpellMCPExposureDefinition): ReadExposure {
  const { _module, _op, _name, _description, _effect, _permission } = definition;
  if (!isIdentifier(_module) || !isIdentifier(_op, OPERATION) || !isIdentifier(_name) ||
      typeof _description !== "string" || !_description.trim() || _description.length > 512) {
    throw new Error("Exposure requires a fixed canonical module/op, tool name and description.");
  }
  if (_effect !== "read" || _permission !== "runtime:read") {
    throw new Error("Native tool exposure requires read effect and runtime:read permission.");
  }
  if (typeof definition._authorize !== "function" || typeof definition._project !== "function" ||
      (definition._is_available !== undefined && typeof definition._is_available !== "function")) {
    throw new Error("Exposure requires a host policy and explicit output projection.");
  }

  const instance = _x.getModule(_module);
  const method = instance instanceof XModule && getModuleOperation(instance, _op);
  if (typeof method !== "function") throw new Error("Exposure target is not a loaded module operation.");

  assertExposureSchema(definition._input_schema);
  assertExposureSchema(definition._output_schema);
  const limits = { ...DEFAULT_LIMITS, ...definition._limits };
  for (const key of Object.keys(limits) as (keyof XpellMCPExposureLimits)[]) {
    if (!isBoundedInteger(limits[key], HARD_LIMITS[key]) || limits[key] === 0) {
      throw new Error("Invalid exposure limit.");
    }
  }
  return Object.freeze({
    ...definition,
    _groups: labels(definition._groups),
    _tags: labels(definition._tags),
    _limits: Object.freeze(limits),
    _instance: instance,
    _method: method,
  });
}

function getModuleOperation(module: XModule, op: string): unknown {
  const name = "_" + op.replaceAll("-", "_");
  for (let source: object | null = module; source; source = Object.getPrototypeOf(source)) {
    const property = Object.getOwnPropertyDescriptor(source, name);
    if (property) return property.value;
  }
  return undefined;
}

export function readExposureActor(context: XpellMCPToolContext | undefined): Claims | undefined {
  const auth = context?._auth;
  if (auth?._authenticated !== true || typeof auth.scope !== "string" ||
      auth.scope.length > 1024 || !auth.scope.split(/\s+/).includes("xpell:read")) return;

  const actor: Record<string, unknown> = { _authenticated: true, scope: auth.scope };
  for (const field of ["_user_id", "_account_id", "_agent_id", "_auth_type", "sub", "client_id", "resource"]) {
    const value = auth[field];
    if (typeof value === "string" && value.trim() && value.length <= 512) actor[field] = value;
  }
  if (!(actor._user_id || actor._account_id || actor._agent_id || actor.sub)) return;
  if (typeof auth._clearance_level === "number" && Number.isFinite(auth._clearance_level)) {
    actor._clearance_level = auth._clearance_level;
  }
  return Object.freeze(actor);
}

export function checkReadExposure(tool: ReadExposure, actor: Claims, input?: Payload): void {
  if (!getXpellMCPRuntimeReadiness()._ready) {
    throw new XError("E_XMCP_RUNTIME_NOT_READY", "Xpell MCP runtime is not ready.");
  }
  if (_x.getModule(tool._module) !== tool._instance ||
      getModuleOperation(tool._instance, tool._op) !== tool._method) {
    throw new XError("E_XMCP_EXPOSURE_UNAVAILABLE", "Native read operation is unavailable.");
  }
  if (!allows(() => tool._authorize(actor)) ||
      (input !== undefined && !allows(() => tool._authorize(actor, input)))) {
    throw new XError("E_XMCP_EXPOSURE_FORBIDDEN", "Native read operation is not authorized.");
  }
  const available = tool._is_available;
  if (available && !allows(() => available(actor))) {
    throw new XError("E_XMCP_EXPOSURE_UNAVAILABLE", "Native read operation is unavailable.");
  }
}

function allows(check: () => boolean): boolean {
  try {
    const answer: unknown = check();
    // A policy accidentally supplied as async never counts as authorization.
    if (answer instanceof Promise) void answer.catch(() => undefined);
    return answer === true;
  } catch {
    return false;
  }
}

export function parseExposureInput(tool: ReadExposure, input: unknown): Payload {
  const limits = { bytes: tool._limits._max_input_bytes, values: tool._limits._max_input_values };
  try {
    const args = input === undefined ? {} : input;
    if (isBoundedExposurePayload(args, limits)) {
      const parsed = tool._input_schema.safeParse(args);
      if (parsed.success && isBoundedExposurePayload(parsed.data, limits)) {
        return freezeExposurePayload(parsed.data);
      }
    }
  } catch {
    // Keep client-supplied input and schema diagnostics out of errors.
  }
  throw new XError("E_XMCP_EXPOSURE_INPUT", "Invalid or oversized native read arguments.");
}

export function exposureInputSchema(tool: ReadExposure): StandardSchemaWithJSON<unknown, Payload> {
  return {
    "~standard": {
      ...tool._input_schema["~standard"],
      validate: (input: unknown) => {
        try {
          return { value: parseExposureInput(tool, input) };
        } catch {
          return { issues: [{ message: "Invalid or oversized native read arguments." }] };
        }
      },
    },
  };
}

export async function runReadExposure(tool: ReadExposure, input: Payload, actor: Claims) {
  const deadline = performance.now() + tool._limits._timeout_ms;
  const timeout = () => new XError("E_XMCP_EXPOSURE_TIMEOUT", "Native read deadline exceeded.");
  const checkDeadline = () => {
    if (performance.now() >= deadline) throw timeout();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeout()), tool._limits._timeout_ms);
    });
    const read = async () => {
      checkReadExposure(tool, actor, input);
      checkDeadline();

      const command: XCommandData & { _ctx: { _auth: Claims } } = {
        _module: tool._module,
        _op: tool._op,
        _params: { ...input, _auth: actor },
        _ctx: Object.freeze({ _auth: actor }),
      };
      let value: unknown;
      try {
        value = await _x.execute(command);
      } catch {
        throw nativeReadFailure();
      }
      checkDeadline();
      if (reportedNativeFailure(value)) throw nativeReadFailure();
      const result = projectExposureResult(tool, value);
      checkDeadline();
      return result;
    };
    return await Promise.race([expired, read()]);
  } finally {
    clearTimeout(timer);
  }
}

function reportedNativeFailure(value: unknown): boolean {
  try {
    return value !== null && typeof value === "object" && "_ok" in value && value._ok === false;
  } catch {
    return true;
  }
}

function nativeReadFailure(): XError {
  return new XError("E_XMCP_EXPOSURE_READ_FAILED", "Native read operation failed.");
}

function projectExposureResult(tool: ReadExposure, value: unknown) {
  const limits = { bytes: tool._limits._max_output_bytes, values: tool._limits._max_output_values };
  try {
    const projected = tool._project(value);
    if (projected instanceof Promise) void projected.catch(() => undefined);
    if (isBoundedExposurePayload(projected, limits)) {
      const parsed = tool._output_schema.safeParse(projected);
      if (parsed.success && isBoundedExposurePayload(parsed.data, limits)) {
        const result = toMCPToolResult(parsed.data);
        const content = result.structuredContent;
        if (isBoundedExposurePayload(content, limits) &&
            tool._output_schema.safeParse(content).success) return { ...result, structuredContent: content };
      }
    }
  } catch {
    // Projection and validation diagnostics may contain private result data.
  }
  throw new XError("E_XMCP_EXPOSURE_OUTPUT", "Invalid or oversized native read result.");
}
