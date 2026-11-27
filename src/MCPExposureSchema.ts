import { z } from "zod";

const MAX_DEPTH = 8;
const MAX_FIELDS = 32;
const MAX_ITEMS = 64;
const MAX_STRING_LENGTH = 4000;

const reserved_fields = new Set([
  "module", "op", "object", "output", "params", "auth", "actor", "actor_id",
  "authenticated", "auth_type", "authorization", "ctx", "context", "token", "cookie",
  "scope", "scopes", "permissions", "clearance_level", "user_id", "account_id",
  "agent_id", "client_id", "app_id", "env", "session", "sid", "wid", "from", "to",
  "state", "tenant_id", "session_id", "connection_id", "role", "roles", "auth_context",
  "request_context", "api_key", "access_token", "password", "constructor", "prototype", "proto", "tojson",
]);
const supported_checks = new Set([
  "min_length", "max_length", "length_equals", "string_format",
  "number_format", "greater_than", "less_than", "multiple_of",
]);

type PayloadLimits = { bytes: number; values: number };

export function assertExposureSchema(schema: z.ZodObject): void {
  try {
    if (!(schema instanceof z.ZodObject) || !hasSupportedChecks(schema, 0)) throw new Error();
    const json = z.toJSONSchema(schema, { io: "input" });
    if (isClosedJSONSchema(json, 0) && Buffer.byteLength(JSON.stringify(json)) <= 16384) return;
  } catch {
    // Some Zod schemas cannot be represented as the MCP input contract.
  }
  throw new Error("Exposure requires a strict, bounded Zod object schema.");
}

function hasSupportedChecks(schema: unknown, depth: number): boolean {
  if (!(schema instanceof z.ZodType) || depth > MAX_DEPTH ||
      schema.def.checks?.some((check) => !supported_checks.has(check._zod.def.check))) {
    return false;
  }
  if (schema instanceof z.ZodOptional) return hasSupportedChecks(schema.unwrap(), depth);
  if (schema instanceof z.ZodArray) return hasSupportedChecks(schema.element, depth + 1);
  if (schema instanceof z.ZodObject) {
    return Object.values(schema.shape).every((field) => hasSupportedChecks(field, depth + 1));
  }
  return schema instanceof z.ZodString || schema instanceof z.ZodNumber || schema instanceof z.ZodBoolean ||
    schema instanceof z.ZodEnum || schema instanceof z.ZodLiteral || schema instanceof z.ZodNull;
}

function isClosedJSONSchema(schema: unknown, depth: number): boolean {
  if (!isPlainRecord(schema) || depth > MAX_DEPTH) return false;
  switch (schema.type) {
    case "object": {
      if (schema.additionalProperties !== false || !isPlainRecord(schema.properties)) return false;
      const fields = Object.entries(schema.properties);
      return fields.length <= MAX_FIELDS && fields.every(([key, child]) =>
        isExposureField(key) && isClosedJSONSchema(child, depth + 1)
      );
    }
    case "array":
      return isBoundedInteger(schema.maxItems, MAX_ITEMS) && isClosedJSONSchema(schema.items, depth + 1);
    case "string":
      if (isBoundedInteger(schema.maxLength, MAX_STRING_LENGTH)) return true;
      if (typeof schema.const === "string") return schema.const.length <= MAX_STRING_LENGTH;
      return Array.isArray(schema.enum) && schema.enum.length <= MAX_ITEMS &&
        schema.enum.every((value) => typeof value === "string" && value.length <= MAX_STRING_LENGTH);
    case "boolean":
    case "number":
    case "integer":
    case "null":
      return true;
    default:
      return false;
  }
}

export function isBoundedInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function isExposureField(key: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key) &&
    !reserved_fields.has(key.replace(/^_+/, "").toLowerCase());
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isBoundedExposurePayload(value: unknown, limits: PayloadLimits): value is Record<string, unknown> {
  let remaining = limits.values;
  let characters = 0;

  function visit(node: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > MAX_DEPTH) return false;
    if (node === null || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (typeof node === "string") {
      characters += node.length;
      return node.length <= MAX_STRING_LENGTH && characters <= limits.bytes;
    }
    if (typeof node !== "object" || Object.getOwnPropertySymbols(node).length) return false;
    if (Array.isArray(node)) {
      if (Object.getPrototypeOf(node) !== Array.prototype || node.length > MAX_ITEMS ||
          Object.getOwnPropertyNames(node).length !== node.length + 1) return false;
      for (let index = 0; index < node.length; index += 1) {
        const item = Object.getOwnPropertyDescriptor(node, String(index));
        if (!item || !("value" in item) || !visit(item.value, depth + 1)) return false;
      }
      return true;
    }
    const keys = Object.getOwnPropertyNames(node);
    if (!isPlainRecord(node) || keys.length > MAX_FIELDS) return false;
    for (const key of keys) {
      const field = Object.getOwnPropertyDescriptor(node, key);
      if (!isExposureField(key) || !field?.enumerable ||
          !("value" in field) || !visit(field.value, depth + 1)) return false;
    }
    return true;
  }

  return isPlainRecord(value) && visit(value, 0) && Buffer.byteLength(JSON.stringify(value)) <= limits.bytes;
}

export function freezeExposurePayload<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeExposurePayload(child);
    Object.freeze(value);
  }
  return value;
}
