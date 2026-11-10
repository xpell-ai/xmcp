import { McpServer, type CallToolResult, type ServerContext, type ToolAnnotations } from "@modelcontextprotocol/server";
import { _x, XError } from "@xpell/core";
import { z } from "zod";
import { toMCPToolError, toMCPToolResult, sanitizeResult } from "./MCPResultMapper.js";

export type XpellMCPPermission = "runtime:read" | "runtime:write";

export type XpellMCPToolContext = {
  _auth?: Record<string, unknown>;
};

export type XpellMCPToolDefinition<Input extends z.ZodType = z.ZodType> = {
  _name: string;
  _description: string;
  _input_schema: Input;
  _permission: XpellMCPPermission;
  _annotations?: ToolAnnotations;
  _is_available?: () => boolean;
  _handler: (
    args: z.infer<Input>,
    context: XpellMCPToolContext,
  ) => Promise<unknown> | unknown;
};

export type XpellMCPToolSummary = {
  _name: string;
  _description: string;
  _permission: XpellMCPPermission;
};

export class MCPToolRegistry {
  private readonly tools = new Map<string, XpellMCPToolDefinition>();

  register(tool: XpellMCPToolDefinition): void {
    if (this.tools.has(tool._name)) {
      throw new Error(`MCP tool '${tool._name}' is already registered.`);
    }

    this.tools.set(tool._name, tool);
  }

  listTools(): XpellMCPToolSummary[] {
    return Array.from(this.tools.values())
      .filter((tool) => tool._is_available?.() !== false)
      .map((tool) => ({
        _name: tool._name,
        _description: tool._description,
        _permission: tool._permission,
      }));
  }

  registerWithServer(server: McpServer): void {
    for (const tool of this.tools.values()) {
      if (tool._is_available?.() === false) continue;
      server.registerTool(
        tool._name,
        {
          description: tool._description,
          inputSchema: tool._input_schema,
          annotations: {
            readOnlyHint: tool._permission === "runtime:read",
            ...(tool._annotations ?? {}),
          },
        },
        async (args: unknown, ctx: ServerContext): Promise<CallToolResult> => {
          try {
            const auth = ctx?.http?.authInfo?.extra;
            requireScopeForPermission(auth, tool._permission);
            const result = await tool._handler(args as never, { _auth: auth });
            return toMCPToolResult(result);
          } catch (error) {
            return toMCPToolError(error);
          }
        },
      );
    }
  }
}

export function createDefaultMCPToolRegistry(): MCPToolRegistry {
  const registry = new MCPToolRegistry();
  const emptyInput = z.object({});
  const capabilitiesInput = z.object({
    app_id: z.string().optional(),
    env: z.string().optional(),
    category: z.string().optional(),
    type: z.string().optional(),
    include_components: z.boolean().optional(),
  });
  const envInput = z.object({
    env: z.string().optional(),
    include_system: z.boolean().optional(),
  });
  const appInput = z.object({
    app_id: z.string(),
    env: z.string().optional(),
  });
  const viewInput = appInput.extend({
    view_id: z.string(),
  });
  const viewEditInput = z.object({
    app_id: z.string(),
    env: z.string(),
    view_id: z.string(),
    edit_action: z.enum([
      "add-child",
      "set-property",
      "set-style",
      "set-styles",
      "remove-style",
      "move-object",
      "remove-object",
    ]),
    target_id: z.string(),
    target_type: z.string().optional(),
    child: z.record(z.string(), z.unknown()).optional(),
    property_name: z.string().optional(),
    property_value: z.unknown().optional(),
    style_property: z.string().optional(),
    style_value: z.string().optional(),
    styles: z.record(z.string(), z.unknown()).optional(),
    before_id: z.string().optional(),
    after_id: z.string().optional(),
    position: z.enum(["append", "prepend", "before", "after"]).optional(),
    destination_id: z.string().optional(),
    destination_type: z.string().optional(),
    destination_text: z.string().optional(),
  });
  const semanticTargetInput = z.object({
    id: z.string().optional(),
    text: z.string().optional(),
    label: z.string().optional(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    type: z.string().optional(),
    semantic_child: z.string().optional(),
  }).strict();
  const semanticChangeInput = z.object({
    semantic_property: z.string(),
    value: z.unknown(),
  }).strict();
  const semanticViewEditInput = z.object({
    app_id: z.string(),
    env: z.string().optional(),
    view_id: z.string(),
    target: semanticTargetInput,
    changes: z.array(semanticChangeInput).min(1),
    apply: z.boolean().optional(),
  }).strict();
  const dataFeatureFieldInput = z.object({
    id: z.string(),
    type: z.enum(["String", "Number", "Boolean", "Date"]),
    required: z.boolean().optional(),
  }).strict();
  const dataFeatureInput = z.object({
    app_id: z.string(),
    env: z.string().optional(),
    feature_name: z.string(),
    entity_id: z.string(),
    fields: z.array(dataFeatureFieldInput).min(1),
    apply: z.boolean().optional().default(false),
  }).strict();
  const flowInput = appInput.extend({
    flow_id: z.string(),
  });
  const entityInput = appInput.extend({
    entity_id: z.string(),
  });

  registry.register({
    _name: "xpell_server_status",
    _description:
      "Confirm MCP to Xpell connectivity and return bounded non-sensitive runtime status.",
    _input_schema: emptyInput,
    _permission: "runtime:read",
    _handler: async () => _x.execute({
      _module: "mcp",
      _op: "status",
      _params: {},
    } as any),
  });

  registry.register({
    _name: "xpell_get_capabilities",
    _description:
      "Return bounded Xpell runtime skills/capabilities, curated MCP tools, and loaded XUI/XDashboard component metadata when available.",
    _input_schema: capabilitiesInput,
    _permission: "runtime:read",
    _handler: async (args) => {
      const input = readArgs(args);
      const app_id = readOptionalString(input.app_id);
      const env = app_id ? readEnv(input.env) : undefined;
      const effective_skills = await collectEffectiveRuntimeSkills({
        _app_id: app_id,
        _env: env,
      });

      return sanitizeResult({
        _ok: true,
        _xpell_capabilities: summarizeSkills(effective_skills._skills, {
          _category: input.category,
          _type: input.type,
          _include_components: input.include_components !== false,
          _runtime_xui_types: collectRuntimeXUITypesFromPayload(effective_skills._skills),
          _skill_sources: effective_skills._sources,
        }),
        _semantic_view_edit: {
          _available: hasXVibeSemanticViewEditCapability(),
          ...(hasXVibeSemanticViewEditCapability()
            ? {
              _tool: "xpell_apply_semantic_view_edit",
              _xvibe_op: "plan-semantic-view-edit",
            }
            : {}),
        },
        _data_feature: {
          _available: hasXVibeDataFeatureCapability(),
          ...(hasXVibeDataFeatureCapability()
            ? {
              _tool: "xpell_create_data_feature",
              _xvibe_op: "data-feature",
            }
            : {}),
        },
        _mcp_tools: registry.listTools(),
      });
    },
  });

  registry.register({
    _name: "xpell_list_apps",
    _description:
      "List Xpell applications visible to the MCP runtime with bounded metadata. This preserves the current admin boundary for server-xvm list-apps.",
    _input_schema: envInput,
    _permission: "runtime:read",
    _handler: async (args, context) => {
      const input = readArgs(args);
      requireAdmin(context, "xpell_list_apps");
      const response = await executeServerXVM("list_apps", {
        ...(readOptionalString(input.env) ? { _env: readOptionalString(input.env) } : {}),
        ...(input.include_system === true ? { _include_system: true } : {}),
      });
      const result = readResult(response);
      const apps = Array.isArray(result._apps) ? result._apps : [];

      return sanitizeResult({
        _ok: true,
        _result: {
          _app_ids: apps.map((app) => readOptionalString(app?._app_id)).filter(Boolean),
          _apps: apps.map((app) => summarizeApp(app)),
        },
      });
    },
  });

  registry.register({
    _name: "xpell_get_app",
    _description:
      "Read bounded Xpell application metadata, including view, flow, and entity ids, without returning view JSON, flow bodies, conversations, project memory, or record data.",
    _input_schema: appInput,
    _permission: "runtime:read",
    _handler: async (args) => {
      const input = readArgs(args);
      const app_id = requireInputString(input.app_id, "app_id");
      const env = readEnv(input.env);
      const response = await executeServerXVM("get_app", {
        _app_id: app_id,
        _env: env,
        _include_views: false,
        _include_flows: false,
      });
      const result = readResult(response);

      return sanitizeResult({
        _ok: true,
        _result: summarizeAppBundle(result),
      });
    },
  });

  registry.register({
    _name: "xpell_list_views",
    _description:
      "List persisted Xpell view summaries for one app. Use this to choose a view id before reading a specific screen.",
    _input_schema: appInput,
    _permission: "runtime:read",
    _handler: async (args, context) => {
      const input = readArgs(args);
      requireAdmin(context, "xpell_list_views");
      const app_id = requireInputString(input.app_id, "app_id");
      const env = readEnv(input.env);
      const [views_response, app_response] = await Promise.all([
        executeServerXVM("list_views", { _app_id: app_id, _env: env }),
        executeServerXVM("get_app", {
          _app_id: app_id,
          _env: env,
          _include_views: false,
          _include_flows: false,
        }),
      ]);
      const views_result = readResult(views_response);
      const app_result = readResult(app_response);
      const entry_view_id = readEntryViewId(app_result._app);
      const views = Array.isArray(views_result._views) ? views_result._views : [];

      return sanitizeResult({
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _entry_view_id: entry_view_id,
          _views: views.map((view) => ({
            ...summarizeArtifact(view),
            _is_entry: readOptionalString(view?._id) === entry_view_id,
          })),
        },
      });
    },
  });

  registry.register({
    _name: "xpell_get_view",
    _description:
      "Read the canonical persisted JSON for one Xpell view. Use this before reasoning about or editing a specific app screen.",
    _input_schema: viewInput,
    _permission: "runtime:read",
    _handler: async (args) => {
      const input = readArgs(args);
      const app_id = requireInputString(input.app_id, "app_id");
      const env = readEnv(input.env);
      const view_id = requireInputString(input.view_id, "view_id");
      const response = await executeServerXVM("get_view", {
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
      });

      return sanitizeResult(response);
    },
  });

  registry.register({
    _name: "xpell_list_flows",
    _description:
      "List persisted Xpell flow summaries for one app without executing any flow.",
    _input_schema: appInput,
    _permission: "runtime:read",
    _handler: async (args) => {
      const input = readArgs(args);
      const app_id = requireInputString(input.app_id, "app_id");
      const env = readEnv(input.env);
      const response = await executeServerXVM("list_flows", {
        _app_id: app_id,
        _env: env,
      });
      const result = readResult(response);
      const flows = Array.isArray(result._flows) ? result._flows : [];

      return sanitizeResult({
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _flows: flows.map((flow) => summarizeArtifact(flow)),
        },
      });
    },
  });

  registry.register({
    _name: "xpell_get_flow",
    _description:
      "Read one canonical persisted Xpell flow definition for inspection. This tool never executes the flow.",
    _input_schema: flowInput,
    _permission: "runtime:read",
    _handler: async (args) => {
      const input = readArgs(args);
      const app_id = requireInputString(input.app_id, "app_id");
      const env = readEnv(input.env);
      const flow_id = requireInputString(input.flow_id, "flow_id");
      const response = await executeServerXVM("get_flow", {
        _app_id: app_id,
        _env: env,
        _flow_id: flow_id,
      });

      return sanitizeResult(response);
    },
  });

  registry.register({
    _name: "xpell_list_entities",
    _description:
      "List persisted Xpell entity/schema summaries for one app without returning stored entity records.",
    _input_schema: appInput,
    _permission: "runtime:read",
    _handler: async (args) => {
      const input = readArgs(args);
      const app_id = requireInputString(input.app_id, "app_id");
      const env = readEnv(input.env);
      const response = await executeServerXVM("get_app", {
        _app_id: app_id,
        _env: env,
        _include_views: false,
        _include_flows: false,
      });
      const result = readResult(response);
      const entities = isRecord(result._entities) ? result._entities : {};

      return sanitizeResult({
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _entities: Object.values(entities).map((entity) => summarizeEntity(entity)),
        },
      });
    },
  });

  registry.register({
    _name: "xpell_get_entity_schema",
    _description:
      "Read an Xpell entity definition/schema without returning entity record data.",
    _input_schema: entityInput,
    _permission: "runtime:read",
    _handler: async (args) => {
      const input = readArgs(args);
      const app_id = requireInputString(input.app_id, "app_id");
      const env = readEnv(input.env);
      const entity_id = requireInputString(input.entity_id, "entity_id");
      const response = await executeServerXVM("get_app", {
        _app_id: app_id,
        _env: env,
        _include_views: false,
        _include_flows: false,
      });
      const result = readResult(response);
      const entities = isRecord(result._entities) ? result._entities : {};
      const entity = entities[entity_id];
      if (!isRecord(entity)) {
        throw new XError("E_XVM_ENTITY_NOT_FOUND", `Entity not found: ${entity_id}`);
      }

      return sanitizeResult({
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _version: result._app?._meta?._version,
          _entity: stripEntityRecordData(entity),
        },
      });
    },
  });

  registry.register({
    _name: "xpell_apply_view_edit",
    _description:
      "Deterministically edit one persisted Xpell view after inspecting it with xpell_get_view. This tool does not perform natural-language planning; it delegates to the canonical XVibe structured-edit contract xvibe.apply-view-edit.",
    _input_schema: viewEditInput,
    _permission: "runtime:write",
    _handler: async (args, context) => {
      const input = readArgs(args);
      requireAdmin(context, "xpell_apply_view_edit");
      const params = await buildXVibeApplyViewEditParams(input);
      const response = await _x.execute({
        _module: "xvibe",
        _op: "apply-view-edit",
        _params: params,
      } as any);
      throwIfXpellErrorResponse(response);
      return sanitizeResult(response);
    },
  });

  registry.register({
    _name: "xpell_apply_semantic_view_edit",
    _description:
      "Plan or apply deterministic semantic Xpell view edits through XVibe. Workflow: inspect the app/view first when target context is unknown; use this for structured semantic property/design changes; prefer plan-only apply=false for ambiguous or important edits; use apply=true only after the semantic plan is acceptable; re-read the view afterward to verify persistence. This tool is not natural-language planning, does not accept free-text instructions, and delegates all semantic resolution, option validation, semantic-child handling, style-path resolution, and mutation-plan construction to xvibe.plan-semantic-view-edit.",
    _input_schema: semanticViewEditInput,
    _permission: "runtime:write",
    _annotations: {
      destructiveHint: true,
    },
    _is_available: hasXVibeSemanticViewEditCapability,
    _handler: async (args, context) => {
      const input = readArgs(args);
      if (input.apply === true) {
        requireAdmin(context, "xpell_apply_semantic_view_edit");
      } else {
        requireAuthenticated(context, "xpell_apply_semantic_view_edit");
      }
      const response = await _x.execute({
        _module: "xvibe",
        _op: "plan-semantic-view-edit",
        _params: buildXVibeSemanticViewEditParams(input),
      } as any);
      throwIfXpellErrorResponse(response);
      return sanitizeResult(response);
    },
  });

  registry.register({
    _name: "xpell_create_data_feature",
    _description:
      "Plan or apply a coordinated Xpell Data Feature by delegating to xvibe.data-feature: entity, create/update/delete flows, create form, and list view. Use plan-only apply=false first, inspect returned conflicts before applying, then verify created artifacts with xpell_get_entity_schema, xpell_get_flow, and xpell_get_view. Do not use this tool for editing existing view appearance; use structured view edit tools for appearance changes.",
    _input_schema: dataFeatureInput,
    _permission: "runtime:read",
    _annotations: {
      destructiveHint: true,
    },
    _is_available: hasXVibeDataFeatureCapability,
    _handler: async (args, context) => {
      const input = readArgs(args);
      if (input.apply === true) {
        requireOAuthScope(context, "xpell:write", "xpell_create_data_feature");
      } else {
        requireOAuthScope(context, "xpell:read", "xpell_create_data_feature");
      }
      requireAuthenticated(context, "xpell_create_data_feature");
      const response = await _x.execute({
        _module: "xvibe",
        _op: "data-feature",
        _params: buildXVibeDataFeatureParams(input),
      } as any);
      throwIfXpellErrorResponse(response);
      return sanitizeResult(response);
    },
  });

  return registry;
}

export const DefaultMCPToolRegistry = createDefaultMCPToolRegistry();

type CapabilitySummaryOptions = {
  _category?: unknown;
  _type?: unknown;
  _include_components: boolean;
  _runtime_xui_types?: string[];
  _skill_sources?: string[];
};

async function executeServerXVM(op: string, params: Record<string, unknown>): Promise<unknown> {
  return _x.execute({
    _module: "server-xvm",
    _op: op,
    _params: params,
  } as any);
}

async function buildXVibeApplyViewEditParams(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const app_id = requireInputString(input.app_id, "app_id");
  const env = requireInputString(input.env, "env");
  const view_id = requireInputString(input.view_id, "view_id");
  const edit_action = requireInputString(input.edit_action, "edit_action");
  const target_id = requireInputString(input.target_id, "target_id");

  const params: Record<string, unknown> = {
    _app_id: app_id,
    _env: env,
    _view_id: view_id,
    _edit_action: edit_action,
    _target_id: target_id,
  };

  copyOptionalString(input, params, "target_type", "_target_type");
  copyOptionalString(input, params, "property_name", "_property_name");
  if (Object.prototype.hasOwnProperty.call(input, "property_value")) {
    params._property_value = input.property_value;
  }
  copyOptionalString(input, params, "style_property", "_style_property");
  copyOptionalString(input, params, "style_value", "_style_value");
  if (isRecord(input.styles)) {
    params._styles = input.styles;
  }
  copyOptionalString(input, params, "before_id", "_before_id");
  copyOptionalString(input, params, "after_id", "_after_id");
  copyOptionalString(input, params, "position", "_position");
  copyOptionalString(input, params, "destination_id", "_destination_id");
  copyOptionalString(input, params, "destination_type", "_destination_type");
  copyOptionalString(input, params, "destination_text", "_destination_text");

  if (edit_action === "add-child") {
    if (isRecord(input.child)) {
      params._child = input.child;
    }
    const effective_skills = await collectEffectiveRuntimeSkills({
      _app_id: app_id,
      _env: env,
    });
    params._runtime_xui_types = collectRuntimeXUITypesFromPayload(effective_skills._skills);
  }

  return params;
}

function buildXVibeSemanticViewEditParams(input: Record<string, unknown>): Record<string, unknown> {
  const app_id = requireInputString(input.app_id, "app_id");
  const env = readEnv(input.env);
  const view_id = requireInputString(input.view_id, "view_id");
  const target = isRecord(input.target) ? input.target : {};
  const changes = Array.isArray(input.changes) ? input.changes : [];

  return {
    _app_id: app_id,
    _env: env,
    _view_id: view_id,
    _target: buildXVibeSemanticTarget(target),
    _changes: changes.map((change) =>
      buildXVibeSemanticChange(isRecord(change) ? change : {})
    ),
    _apply: input.apply === true,
  };
}

function buildXVibeSemanticTarget(input: Record<string, unknown>): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  copyOptionalString(input, target, "id", "_id");
  copyOptionalString(input, target, "text", "_text");
  copyOptionalString(input, target, "label", "_label");
  copyOptionalString(input, target, "title", "_title");
  copyOptionalString(input, target, "subtitle", "_subtitle");
  copyOptionalString(input, target, "type", "_type");
  copyOptionalString(input, target, "semantic_child", "_semantic_child");
  return target;
}

function buildXVibeSemanticChange(input: Record<string, unknown>): Record<string, unknown> {
  return {
    _semantic_property: requireInputString(input.semantic_property, "semantic_property"),
    _value: input.value,
  };
}

function buildXVibeDataFeatureParams(input: Record<string, unknown>): Record<string, unknown> {
  const app_id = requireInputString(input.app_id, "app_id");
  const env = readEnv(input.env);
  const feature_name = requireInputString(input.feature_name, "feature_name");
  const entity_id = requireInputString(input.entity_id, "entity_id");
  const fields = Array.isArray(input.fields) ? input.fields : [];

  return {
    _app_id: app_id,
    _env: env,
    _feature_name: feature_name,
    _entity_id: entity_id,
    _fields: fields.map((field) =>
      buildXVibeDataFeatureField(isRecord(field) ? field : {})
    ),
    _apply: input.apply === true,
  };
}

function buildXVibeDataFeatureField(input: Record<string, unknown>): Record<string, unknown> {
  return {
    _field_id: requireInputString(input.id, "fields[].id"),
    _type: requireInputString(input.type, "fields[].type"),
    ...(typeof input.required === "boolean" ? { _required: input.required } : {}),
  };
}

function hasXVibeSemanticViewEditCapability(): boolean {
  return hasXVibeOperationCapability("plan-semantic-view-edit", "_plan_semantic_view_edit");
}

function hasXVibeDataFeatureCapability(): boolean {
  return hasXVibeOperationCapability("data-feature", "_data_feature");
}

function hasXVibeOperationCapability(op_name: string, method_name: string): boolean {
  try {
    const get_module = (_x as any).getModule;
    const module =
      typeof get_module === "function"
        ? get_module.call(_x, "xvibe")
        : undefined;
    if (!module) return false;

    if (typeof module[method_name] === "function") return true;

    const command_skills =
      typeof module.getCommandSkills === "function"
        ? module.getCommandSkills()
        : [];
    if (
      Array.isArray(command_skills) &&
      command_skills.some((op) => isRecord(op) && op._name === op_name)
    ) {
      return true;
    }

    const static_ops =
      isRecord(module.constructor?._ops)
        ? module.constructor._ops
        : isRecord(module._ops)
          ? module._ops
          : {};
    return Object.prototype.hasOwnProperty.call(static_ops, op_name);
  } catch {
    return false;
  }
}

function copyOptionalString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  source_key: string,
  target_key: string,
): void {
  const value = readOptionalString(source[source_key]);
  if (value) target[target_key] = value;
}

async function collectEffectiveRuntimeSkills(input: {
  _app_id?: string;
  _env?: string;
} = {}): Promise<{
  _skills: Record<string, unknown>;
  _sources: string[];
}> {
  const payloads: unknown[] = [];
  const sources: string[] = [];
  const server_skills = readServerRuntimeSkills();
  if (isRecord(server_skills)) {
    payloads.push(server_skills);
    sources.push("server-runtime");
  }

  const scoped_skills =
    input._app_id
      ? await readXVibeScopedRuntimeSkills(input._app_id, input._env)
      : undefined;
  if (isRecord(scoped_skills)) {
    payloads.push(scoped_skills);
    sources.push("xvibe-scoped-runtime-skills");
  }

  return {
    _skills: mergeRuntimeSkillPayloads(payloads),
    _sources: sources,
  };
}

function readServerRuntimeSkills(): unknown {
  const skills = typeof (_x as any).getSkills === "function"
    ? (_x as any).getSkills()
    : {};
  return skills;
}

async function readXVibeScopedRuntimeSkills(app_id: string, env = "default"): Promise<unknown> {
  try {
    const get_module = (_x as any).getModule;
    const module =
      typeof get_module === "function"
        ? get_module.call(_x, "xvibe")
        : undefined;
    if (!module || typeof module._get_runtime_skills !== "function") return undefined;

    const response = await _x.execute({
      _module: "xvibe",
      _op: "get-runtime-skills",
      _params: {
        _app_id: app_id,
        _env: env,
        _mode: "runtime",
      },
    } as any);
    const result = readResult(response);
    return isRecord(result._skills) ? result._skills : undefined;
  } catch {
    return undefined;
  }
}

function mergeRuntimeSkillPayloads(payloads: unknown[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const root_skills: unknown[] = [];
  const root_objects: unknown[] = [];
  const modules: unknown[] = [];

  for (const payload of payloads) {
    const normalized = unwrapRuntimeSkillPayload(payload);
    if (!isRecord(normalized)) continue;
    Object.assign(merged, stripRuntimeSkillCollections(normalized));
    root_skills.push(...readCollection(normalized._skills));
    root_objects.push(...readCollection(normalized._objects));
    modules.push(...readCollection(normalized._modules));
  }

  return {
    ...merged,
    _skills: uniqueRuntimeSkillItems(root_skills),
    _objects: uniqueRuntimeSkillItems(root_objects),
    _modules: uniqueRuntimeSkillItems(modules),
  };
}

function unwrapRuntimeSkillPayload(value: unknown): unknown {
  return isRecord(value) && isRecord(value._skills)
    ? value._skills
    : value;
}

function stripRuntimeSkillCollections(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "_skills" || key === "_objects" || key === "_modules") continue;
    out[key] = item;
  }
  return out;
}

function readCollection(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  return [];
}

function uniqueRuntimeSkillItems(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const key =
      isRecord(item)
        ? String(item._id ?? item._name ?? JSON.stringify(item))
        : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out;
}

function collectRuntimeXUITypesFromPayload(value: unknown): string[] {
  const types = new Set<string>();
  collectRuntimeXUITypesFromPayloadInto(value, types);
  return Array.from(types).sort((a, b) => a.localeCompare(b));
}

function collectRuntimeXUITypesFromPayloadInto(value: unknown, types: Set<string>): void {
  if (!isRecord(value)) return;

  const payload = isRecord(value._skills) ? value._skills : value;
  for (const skill of readCollection(payload._skills)) {
    collectRuntimeXUITypesFromSkill(skill, types);
  }
  for (const skill of readCollection(payload._objects)) {
    collectRuntimeXUITypesFromSkill(skill, types);
  }
  for (const module_item of readCollection(payload._modules)) {
    if (!isRecord(module_item)) continue;
    for (const skill of readCollection(module_item._skills)) {
      collectRuntimeXUITypesFromSkill(skill, types);
    }
    for (const skill of readCollection(module_item._objects)) {
      collectRuntimeXUITypesFromSkill(skill, types);
    }
  }
}

function collectRuntimeXUITypesFromSkill(value: unknown, types: Set<string>): void {
  if (!isRecord(value)) return;

  const exports = isRecord(value._exports) ? value._exports : undefined;
  const exported_types = exports ? readStringArray(exports._xui_objects) : [];
  const explicit_types = [
    ...readStringArray(value._xui_objects),
    ...exported_types,
  ];
  const is_xui_skill = isRuntimeXUISkill(value) || explicit_types.length > 0;

  if (is_xui_skill) {
    addRuntimeXUIType(types, value._id);
  }
  addRuntimeXUIType(types, value._xtype);
  addRuntimeXUIType(types, value._xui_type);
  addRuntimeXUIType(types, value._object_type);

  for (const type of explicit_types) {
    addRuntimeXUIType(types, type);
  }
}

function isRuntimeXUISkill(value: Record<string, unknown>): boolean {
  const type = normalizeLower(value._type);
  if (type === "view-skill" || type === "xui-skill" || type === "xui-object") {
    return true;
  }

  return isRecord(value._design) || readOptionalString(value._category) !== undefined;
}

function addRuntimeXUIType(types: Set<string>, value: unknown): void {
  const type = readOptionalString(value);
  if (type) types.add(type);
}

function summarizeSkills(value: unknown, options: CapabilitySummaryOptions): Record<string, unknown> {
  const skills = sanitizeResult(value);
  const modules = Array.isArray(skills._modules) ? skills._modules : [];
  const components = options._include_components
    ? summarizeComponents(skills, options)
    : [];

  return {
    _runtime: skills._runtime ?? {},
    _runtime_xui_types: options._runtime_xui_types ?? collectRuntimeXUITypesFromPayload(skills),
    _skill_sources: options._skill_sources ?? ["server-runtime"],
    _skills: Array.isArray(skills._skills) ? skills._skills.slice(0, 20) : [],
    _modules: modules.slice(0, 100).map((item) => summarizeModuleSkill(item)),
    _components: components,
    _component_count: components.length,
  };
}

function summarizeModuleSkill(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};

  const name = typeof value._name === "string" ? value._name : "unknown";
  const skills = Array.isArray(value._skills) ? value._skills : [];
  const objects = Array.isArray(value._objects) ? value._objects : [];

  return {
    _name: name,
    _skills: skills.slice(0, 20).map((skill) => {
      if (!isRecord(skill)) return {};

      return {
        _id: skill._id,
        _title: skill._title,
        _type: skill._type,
        _description: skill._description,
        _exports: summarizeSkillExports(skill._exports),
      };
    }),
    _objects: objects.slice(0, 20),
  };
}

function summarizeSkillExports(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const modules = Array.isArray(value._modules) ? value._modules : [];

  return {
    _modules: modules.slice(0, 20).map((item) => {
      if (!isRecord(item)) return {};
      const ops = Array.isArray(item._ops) ? item._ops : [];

      return {
        _name: item._name,
        _scope: item._scope,
        _description: item._description,
        _ops: ops.slice(0, 50),
      };
    }),
  };
}

function summarizeComponents(
  skills: Record<string, unknown>,
  options: CapabilitySummaryOptions,
): Record<string, unknown>[] {
  const category_filter = normalizeLower(options._category);
  const type_filter = normalizeLower(options._type);
  const components = new Map<string, Record<string, unknown>>();
  const modules = Array.isArray(skills._modules) ? skills._modules : [];
  const root_objects = Array.isArray(skills._objects) ? skills._objects : [];

  for (const skill of root_objects) {
    addComponent(components, skill, "runtime", category_filter, type_filter);
  }

  for (const module_item of modules) {
    if (!isRecord(module_item)) continue;
    const module_name = readOptionalString(module_item._name) ?? "unknown";
    const objects = Array.isArray(module_item._objects) ? module_item._objects : [];
    for (const skill of objects) {
      addComponent(components, skill, module_name, category_filter, type_filter);
    }
  }

  return Array.from(components.values())
    .sort((a, b) => String(a._type).localeCompare(String(b._type)))
    .slice(0, 100);
}

function addComponent(
  out: Map<string, Record<string, unknown>>,
  value: unknown,
  module_name: string,
  category_filter: string | undefined,
  type_filter: string | undefined,
): void {
  if (!isRecord(value)) return;
  const type = readComponentType(value);
  if (!type) return;

  const category = readComponentCategory(value);
  if (category_filter && normalizeLower(category) !== category_filter) return;
  if (type_filter && normalizeLower(type) !== type_filter) return;

  out.set(type, {
    _type: type,
    _title: value._title,
    _category: category,
    _purpose: value._description,
    _capabilities: readStringArray(value._capabilities),
    _fields: summarizeFields(value._fields),
    _design: summarizeDesign(value._design),
    _source_module: module_name,
    _skill_type: value._type,
  });
}

function readComponentType(value: Record<string, unknown>): string | undefined {
  const exported = readStringArray(isRecord(value._exports) ? value._exports._xui_objects : undefined);
  return readOptionalString(value._id) ?? exported[0];
}

function readComponentCategory(value: Record<string, unknown>): string | undefined {
  const direct = readOptionalString(value._category);
  if (direct) return direct;
  const design = isRecord(value._design) ? value._design : {};
  const palette = isRecord(design._palette) ? design._palette : {};
  return readOptionalString(palette._category);
}

function summarizeFields(value: unknown): string[] {
  if (!isRecord(value)) return [];
  return Object.keys(value).slice(0, 40);
}

function summarizeDesign(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const children = isRecord(value._children) ? value._children : {};
  const palette = isRecord(value._palette) ? value._palette : {};
  const semantic_children = Array.isArray(value._semantic_children) ? value._semantic_children : [];
  const slots = Array.isArray(value._slots) ? value._slots : [];

  return {
    ...(readOptionalString(palette._category) ? { _palette_category: readOptionalString(palette._category) } : {}),
    ...(Array.isArray(children._accepted_types) ? { _accepted_types: children._accepted_types.slice(0, 40) } : {}),
    ...(semantic_children.length > 0 ? { _semantic_child_count: semantic_children.length } : {}),
    ...(slots.length > 0 ? { _slot_count: slots.length } : {}),
  };
}

function summarizeAppBundle(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const app = isRecord(value._app) ? value._app : {};
  const entities = isRecord(value._entities) ? value._entities : {};

  return {
    _app: summarizeApp(app),
    _entry_view_id: readEntryViewId(app),
    _view_ids: readStringArray(value._view_ids),
    _flow_ids: readStringArray(value._flow_ids),
    _entity_ids: readStringArray(value._entity_ids),
    _entities: Object.values(entities).map((entity) => summarizeEntity(entity)),
  };
}

function summarizeApp(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};

  return {
    _app_id: value._app_id,
    _env: value._env,
    _title: value._title ?? value._name ?? value._app_id,
    _name: value._name,
    _system: value._system === true,
    _entry_view_id: readEntryViewId(value),
    _meta: summarizeMeta(value._meta),
    _config: summarizeAppConfig(value._config),
  };
}

function summarizeMeta(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return {
    _version: value._version,
    _created_at: value._created_at,
    _updated_at: value._updated_at,
    _entry_view_id: value._entry_view_id,
  };
}

function summarizeAppConfig(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const start = isRecord(value._start) ? value._start : {};
  return {
    ...(readOptionalString(start._view_id) ? { _start: { _view_id: start._view_id } } : {}),
    ...(isRecord(value._router) ? { _router: value._router } : {}),
    ...(isRecord(value._regions) ? { _regions: value._regions } : {}),
    ...(isRecord(value._containers) ? { _containers: value._containers } : {}),
  };
}

function summarizeArtifact(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return {
    _id: value._id,
    _type: value._type,
    _title: value._title ?? value._name ?? value._id,
    _description: value._description,
    ...(typeof value._children_count === "number" ? { _children_count: value._children_count } : {}),
    ...(Array.isArray(value._steps) ? { _steps_count: value._steps.length } : {}),
  };
}

function summarizeEntity(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const schema = isRecord(value._schema) ? value._schema : {};

  return {
    _id: value._id,
    _title: value._title ?? value._name ?? value._id,
    _description: value._description,
    _field_count: Object.keys(schema).length,
    _fields: Object.keys(schema).slice(0, 80),
    _schema_meta: summarizeEntitySchemaMeta(schema),
  };
}

function summarizeEntitySchemaMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const required: string[] = [];
  const indexed: string[] = [];
  const unique: string[] = [];

  for (const [field, definition] of Object.entries(schema)) {
    if (!isRecord(definition)) continue;
    if (definition._required === true) required.push(field);
    if (definition._index === true || isRecord(definition._index)) indexed.push(field);
    if (isRecord(definition._index) && definition._index._unique === true) unique.push(field);
  }

  return {
    _required_fields: required.slice(0, 80),
    _indexed_fields: indexed.slice(0, 80),
    _unique_fields: unique.slice(0, 80),
  };
}

function stripEntityRecordData(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const blocked = new Set([
    "_data",
    "data",
    "_records",
    "records",
    "_record",
    "record",
    "_indices",
    "_vectors",
    "_files",
    "_temp",
    "_cache",
  ]);

  for (const [key, item] of Object.entries(value)) {
    if (blocked.has(key)) continue;
    out[key] = item;
  }

  return out;
}

function readResult(value: unknown): Record<string, any> {
  if (isRecord(value) && value._ok === false) {
    const result = isRecord(value._result) ? value._result : {};
    throw new XError(
      readOptionalString(result._code) ?? "E_XMCP_XPELL_COMMAND_FAILED",
      readOptionalString(result._message) ?? "Xpell command failed.",
    );
  }

  if (isRecord(value) && isRecord(value._result)) return value._result as Record<string, any>;
  return {};
}

function throwIfXpellErrorResponse(value: unknown): void {
  if (!isRecord(value) || value._ok !== false) return;

  const payload =
    isRecord(value._error)
      ? value._error
      : isRecord(value._result)
        ? value._result
        : value;
  const details = isRecord(payload._details) ? payload._details : undefined;
  const reason = readOptionalString(value._reason) ?? readOptionalString(payload._reason);
  throw new XError(
    readOptionalString(payload._code) ?? "E_XMCP_XPELL_COMMAND_FAILED",
    readOptionalString(payload._message) ?? "Xpell command failed.",
    {
      _meta: {
        ...(reason ? { _reason: reason } : {}),
        ...(details ?? {}),
      },
    },
  );
}

function readEntryViewId(app: unknown): string | undefined {
  if (!isRecord(app)) return undefined;
  const meta = isRecord(app._meta) ? app._meta : {};
  const config = isRecord(app._config) ? app._config : {};
  const start = isRecord(config._start) ? config._start : {};
  return readOptionalString(meta._entry_view_id) ?? readOptionalString(start._view_id);
}

function requireAdmin(context: XpellMCPToolContext, tool: string): void {
  if (isOAuthMCPAuthContext(context._auth) && !hasOAuthScope(context._auth, "xpell:admin")) {
    throw new XError("E_XMCP_INSUFFICIENT_SCOPE", `${tool} requires xpell:admin scope.`);
  }

  const clearance = typeof context._auth?._clearance_level === "number"
    ? context._auth._clearance_level
    : 0;

  if (clearance < 100) {
    throw new XError("E_XMCP_ADMIN_REQUIRED", `${tool} requires admin clearance.`);
  }
}

function requireAuthenticated(context: XpellMCPToolContext, tool: string): void {
  if (context._auth?._authenticated === true) return;
  throw new XError("E_XMCP_AUTH_REQUIRED", `${tool} requires authenticated MCP bearer auth.`);
}

function requireOAuthScope(context: XpellMCPToolContext, scope: string, tool: string): void {
  if (!isOAuthMCPAuthContext(context._auth)) return;
  if (!hasOAuthScope(context._auth, scope)) {
    throw new XError("E_XMCP_INSUFFICIENT_SCOPE", `${tool} requires ${scope} scope.`);
  }
}

function requireScopeForPermission(
  auth: Record<string, unknown> | undefined,
  permission: XpellMCPPermission,
): void {
  if (!isOAuthMCPAuthContext(auth)) return;

  const required_scope = permission === "runtime:write" ? "xpell:write" : "xpell:read";
  if (!hasOAuthScope(auth, required_scope)) {
    throw new XError("E_XMCP_INSUFFICIENT_SCOPE", `MCP tool requires ${required_scope} scope.`);
  }
}

function isOAuthMCPAuthContext(auth: Record<string, unknown> | undefined): auth is Record<string, unknown> {
  return Boolean(
    auth &&
    (
      typeof auth.client_id === "string" ||
      typeof auth.resource === "string" ||
      typeof auth.aud === "string" ||
      typeof auth.scope === "string"
    ),
  );
}

function hasOAuthScope(auth: Record<string, unknown>, scope: string): boolean {
  const scopes = typeof auth.scope === "string"
    ? auth.scope.split(/\s+/).filter(Boolean)
    : [];
  return scopes.includes(scope);
}

function requireInputString(value: unknown, field: string): string {
  const text = readOptionalString(value);
  if (!text) {
    throw new XError("E_XMCP_INVALID_INPUT", `Missing ${field}.`);
  }
  return text;
}

function readEnv(value: unknown): string {
  return readOptionalString(value) ?? "default";
}

function readArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeLower(value: unknown): string | undefined {
  return readOptionalString(value)?.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
