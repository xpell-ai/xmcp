import type { CallToolResult } from "@modelcontextprotocol/server";

export type XpellMCPSanitizedResult = Record<string, unknown>;

const MAX_DEPTH = 16;
const MAX_ARRAY_ITEMS = 250;
const MAX_OBJECT_KEYS = 200;
const MAX_STRING_LENGTH = 4000;

const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|password|passwd|secret|token|jwt|api[_-]?key|session)/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi;
const POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'(])\/(?:Users|home|var|private|tmp|etc|opt|Volumes|Applications)\/[^\s"',)]+/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /\b[A-Za-z]:\\[^\s"',)]+/g;

export function toMCPToolResult(value: unknown): CallToolResult {
  const sanitized = sanitizeResult(value);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(sanitized, null, 2),
      },
    ],
    structuredContent: sanitized,
  };
}

export function toMCPToolError(error: unknown): CallToolResult {
  const sanitized = sanitizeError(error);

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(sanitized, null, 2),
      },
    ],
    structuredContent: sanitized,
  };
}

export function sanitizeResult(value: unknown): XpellMCPSanitizedResult {
  const sanitized = sanitizeValue(value, 0);

  if (isRecord(sanitized)) {
    return sanitized;
  }

  return { _result: sanitized };
}

export function sanitizeError(error: unknown): XpellMCPSanitizedResult {
  if (isRecord(error)) {
    const code = readErrorCode(error) ?? "E_XMCP_TOOL_FAILED";
    const message = readErrorMessage(error) ?? "MCP tool execution failed.";
    const details = readErrorDetails(error);

    return {
      _ok: false,
      _error: {
        _code: code,
        _message: redactString(message),
        ...(details ? { _details: details } : {}),
      },
    };
  }

  return {
    _ok: false,
    _error: {
      _code: "E_XMCP_TOOL_FAILED",
      _message: redactString(error instanceof Error ? error.message : String(error)),
    },
  };
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1));
  }

  if (!isRecord(value)) {
    return redactString(String(value));
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);

  for (const [key, item] of entries) {
    if (key === "stack" || key === "_stack" || key === "trace" || key === "_trace") {
      continue;
    }

    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[redacted]";
      continue;
    }

    const sanitized = sanitizeValue(item, depth + 1);
    if (sanitized !== undefined) {
      out[key] = sanitized;
    }
  }

  return out;
}

function redactString(value: string): string {
  const trimmed = value.length > MAX_STRING_LENGTH
    ? value.slice(0, MAX_STRING_LENGTH) + "...[truncated]"
    : value;

  return trimmed
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(JWT_PATTERN, "[redacted-jwt]")
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, (match) => {
      const prefix = match.startsWith("/") ? "" : match.charAt(0);
      return `${prefix}[redacted-path]`;
    })
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function readErrorCode(value: Record<string, unknown>): string | undefined {
  const direct = value._code ?? value.code;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const error = value._error ?? value.error ?? value._result;
  if (isRecord(error)) {
    return readErrorCode(error);
  }

  return undefined;
}

function readErrorMessage(value: Record<string, unknown>): string | undefined {
  const direct = value._message ?? value.message;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const error = value._error ?? value.error ?? value._result;
  if (isRecord(error)) {
    return readErrorMessage(error);
  }

  return undefined;
}

function readErrorDetails(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = value._details ?? value.details;
  if (isRecord(direct)) return sanitizeResult(direct);

  const meta = value._meta;
  if (isRecord(meta)) return sanitizeResult(meta);

  const error = value._error ?? value.error ?? value._result;
  if (isRecord(error)) {
    return readErrorDetails(error);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
