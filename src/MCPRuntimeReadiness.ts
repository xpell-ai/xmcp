export type XpellMCPRuntimeReadinessStatus = "starting" | "ready" | "failed";

export type XpellMCPRuntimeReadiness = {
  _ready: boolean;
  _status: XpellMCPRuntimeReadinessStatus;
  _reason?: string;
  _details?: Record<string, unknown>;
};

let mcp_runtime_readiness: XpellMCPRuntimeReadiness = {
  _ready: false,
  _status: "starting",
  _reason: "runtime_starting",
};

export function getXpellMCPRuntimeReadiness(): XpellMCPRuntimeReadiness {
  return {
    ...mcp_runtime_readiness,
    ...(mcp_runtime_readiness._details
      ? { _details: { ...mcp_runtime_readiness._details } }
      : {}),
  };
}

export function markXpellMCPRuntimeStarting(reason = "runtime_starting"): XpellMCPRuntimeReadiness {
  mcp_runtime_readiness = {
    _ready: false,
    _status: "starting",
    _reason: reason,
  };

  return getXpellMCPRuntimeReadiness();
}

export function markXpellMCPRuntimeReady(reason = "runtime_ready"): XpellMCPRuntimeReadiness {
  mcp_runtime_readiness = {
    _ready: true,
    _status: "ready",
    _reason: reason,
  };

  return getXpellMCPRuntimeReadiness();
}

export function markXpellMCPRuntimeFailed(
  reason = "runtime_start_failed",
  details: Record<string, unknown> = {},
): XpellMCPRuntimeReadiness {
  mcp_runtime_readiness = {
    _ready: false,
    _status: "failed",
    _reason: reason,
    _details: sanitizeReadinessDetails(details),
  };

  return getXpellMCPRuntimeReadiness();
}

function sanitizeReadinessDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, 16)) {
    if (typeof value === "string") {
      sanitized[key] = value.slice(0, 240);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}
