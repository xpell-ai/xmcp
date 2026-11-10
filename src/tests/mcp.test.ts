import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { _x, XError, XModule, type XCommand, type XpellSkill } from "@xpell/core";
import {
  MCPModule,
  MCP_OPS,
  DefaultMCPToolRegistry,
  createXpellMCPProtectedResourceMetadata,
  createXpellMCPRequestHandler,
  createXpellMCPWWWAuthenticateChallenge,
  getXpellMCPRuntimeReadiness,
  markXpellMCPRuntimeReady,
  markXpellMCPRuntimeStarting,
  getXpellMCPProtectedResourceMetadataPath,
  mountXpellMCPRoute,
  normalizeMCPSettings,
  sanitizeResult,
} from "../index.js";

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

const DEFAULT_TOOL_NAMES = [
  "xpell_server_status",
  "xpell_get_capabilities",
  "xpell_list_apps",
  "xpell_get_app",
  "xpell_list_views",
  "xpell_get_view",
  "xpell_list_flows",
  "xpell_get_flow",
  "xpell_list_entities",
  "xpell_get_entity_schema",
  "xpell_apply_view_edit",
  "xpell_apply_semantic_view_edit",
  "xpell_create_data_feature",
];

const DEFAULT_TOOL_NAMES_WITHOUT_XVIBE = DEFAULT_TOOL_NAMES.filter((name) =>
  name !== "xpell_apply_semantic_view_edit" &&
  name !== "xpell_create_data_feature"
);
const DEFAULT_TOOL_NAMES_WITHOUT_DATA_FEATURE = DEFAULT_TOOL_NAMES.filter((name) =>
  name !== "xpell_create_data_feature"
);

class TestXAuthModule extends XModule {
  constructor() {
    super({ _name: "xauth" });
  }

  async _authorize_req(xcmd: XCommand) {
    const token = xcmd._params?._token;

    if (token === "valid-token") {
      return {
        _authenticated: true,
        _auth_type: "jwt",
        _user_id: "test-user",
        _account_id: "test-account",
        _clearance_level: 100,
        _token_purpose: "mcp",
        _audience: "mcp",
        _permissions: ["runtime:read", "runtime:write"],
      };
    }

    if (token === "admin-token-without-permissions") {
      return {
        _authenticated: true,
        _auth_type: "jwt",
        _user_id: "admin-user",
        _account_id: "test-account",
        _clearance_level: 100,
        _token_purpose: "mcp",
        _audience: "mcp",
      };
    }

    if (token === "low-token") {
      return {
        _authenticated: true,
        _auth_type: "jwt",
        _user_id: "low-user",
        _account_id: "test-account",
        _clearance_level: 50,
        _token_purpose: "mcp",
        _audience: "mcp",
        _permissions: ["runtime:read", "runtime:write"],
      };
    }

    if (token === "read-only-token") {
      return {
        _authenticated: true,
        _auth_type: "jwt",
        _user_id: "read-only-user",
        _account_id: "test-account",
        _clearance_level: 100,
        _token_purpose: "mcp",
        _audience: "mcp",
        _permissions: ["runtime:read"],
      };
    }

    if (token === "browser-session-token") {
      return {
        _authenticated: true,
        _auth_type: "jwt",
        _user_id: "browser-user",
        _account_id: "test-account",
        _clearance_level: 100,
        _token_purpose: "session",
        _audience: "browser",
        _permissions: ["runtime:read", "runtime:write"],
      };
    }

    if (token === "oauth-read-token") {
      return {
        _authenticated: true,
        _auth_type: "jwt",
        _user_id: "oauth-read-user",
        _account_id: "test-account",
        _clearance_level: 50,
        _token_purpose: "mcp",
        _audience: "mcp",
        client_id: "https://client.example/metadata.json",
        resource: "http://localhost:3000/mcp",
        scope: "xpell:read",
      };
    }

    if (token === "oauth-write-token") {
      return {
        _authenticated: true,
        _auth_type: "jwt",
        _user_id: "oauth-write-user",
        _account_id: "test-account",
        _clearance_level: 50,
        _token_purpose: "mcp",
        _audience: "mcp",
        client_id: "https://client.example/metadata.json",
        resource: "http://localhost:3000/mcp",
        scope: "xpell:read xpell:write",
      };
    }

    return {
      _authenticated: false,
      _auth_type: "unknown",
    };
  }
}

const TEST_SKILL: XpellSkill = {
  _id: "test-capability",
  _title: "Test Capability",
  _version: "1.0.0",
  _active: true,
  _type: "server-module-api",
  _description: "Test module capability used by @xpell/mcp tests.",
};

const TEST_COMPONENT_SKILL: XpellSkill & { _category: string; _capabilities: string[] } = {
  _id: "xgallery",
  _title: "XGallery",
  _version: "1.0.0",
  _active: true,
  _type: "view-skill",
  _category: "collection-presentation",
  _capabilities: ["layout", "appearance", "spacing"],
  _description: "Collection gallery/card grid component for record presentation.",
  _fields: {
    _items: "Collection binding.",
    _item: "Item rendering template.",
  },
  _design: {
    _palette: {
      _category: "collection-presentation",
    },
    _children: {
      _accepted_types: ["text", "button", "image"],
    },
    _semantic_children: [
      {
        _id: "title",
        _label: "Title",
        _style_path: "_item._styles._title._style",
      },
    ],
  },
};

const TEST_RUNTIME_XUI_SKILLS: any[] = [
  {
    _id: "xpage",
    _title: "XPage",
    _version: "1.0.0",
    _active: true,
    _type: "view-skill",
    _description: "Page component.",
    _design: {
      _inspector: {
        _fields: [
          { _key: "_width", _label: "Width", _options: ["full", "readable"] },
        ],
      },
    },
  } as any,
  {
    _id: "label",
    _title: "Label",
    _version: "1.0.0",
    _active: true,
    _type: "view-skill",
    _description: "Text label component.",
  } as any,
  {
    _id: "badge",
    _title: "Badge",
    _version: "1.0.0",
    _active: true,
    _type: "view-skill",
    _description: "Status badge component.",
  },
  {
    _id: "xsection",
    _title: "XSection",
    _version: "1.0.0",
    _active: true,
    _type: "view-skill",
    _description: "Dashboard section component.",
    _design: {
      _inspector: {
        _fields: [
          { _key: "_title", _label: "Title" },
          { _key: "_density", _label: "Density", _options: ["regular", "compact"] },
        ],
      },
    },
  } as any,
  {
    _id: "xlist",
    _title: "XList",
    _version: "1.0.0",
    _active: true,
    _type: "view-skill",
    _description: "List component.",
  },
  {
    _id: "xkanban",
    _title: "XKanban",
    _version: "1.0.0",
    _active: true,
    _type: "view-skill",
    _description: "Kanban board component.",
  },
  {
    _id: "xtimeline",
    _title: "XTimeline",
    _version: "1.0.0",
    _active: true,
    _type: "view-skill",
    _description: "Timeline component.",
  },
  {
    _id: "xcalendar",
    _title: "XCalendar",
    _version: "1.0.0",
    _active: true,
    _type: "view-skill",
    _description: "Calendar component.",
  },
];

const SCOPED_PACKAGE_RUNTIME_SKILLS = {
  _runtime: {
    _engine_id: "client-runtime",
    _version: "test",
  },
  _modules: [
    {
      _name: "xui",
      _objects: [
        {
          _id: "xgallery",
          _title: "XGallery",
          _type: "view-skill",
          _category: "collection-presentation",
          _design: {
            _palette: {
              _category: "collection-presentation",
            },
          },
        },
        {
          _id: "xlist",
          _title: "XList",
          _type: "view-skill",
          _category: "collection-presentation",
        },
        {
          _id: "xpage",
          _title: "XPage",
          _type: "view-skill",
          _category: "composition",
        },
      ],
    },
  ],
};

class TestCapabilityModule extends XModule {
  static _skill = TEST_SKILL;

  constructor() {
    super({ _name: "test-capability-module" });
  }

  getObjectSkills() {
    return [TEST_COMPONENT_SKILL, ...TEST_RUNTIME_XUI_SKILLS];
  }
}

class TestServerXVMModule extends XModule {
  private readonly app = {
    _app_id: "1p9",
    _env: "default",
    _title: "Inspection App",
    _system: false,
    _meta: {
      _version: 3,
      _entry_view_id: "main",
      _created_at: "2026-08-01T00:00:00.000Z",
      _updated_at: "2026-08-20T00:00:00.000Z",
    },
    _config: {
      _start: {
        _view_id: "main",
      },
      _router: {
        _mode: "hash",
      },
    },
    _source_path: "/Users/example/secret/app.json",
  };

  private readonly views = {
    main: {
      _id: "main",
      _type: "xpage",
      _title: "Main",
      _width: "full",
      _children: [
        {
          _id: "headline",
          _type: "text",
          _text: "Customers",
          _style: {
            fontSize: "24px",
          },
        },
        {
          _id: "open-form",
          _type: "button",
          _text: "New customer",
          _flow: "create_customer",
        },
        {
          _id: "main-section",
          _type: "xsection",
          _title: "Main",
          _density: "regular",
        },
        {
          _id: "xgallery",
          _type: "xgallery",
          _item: {
            _title: "$row.name",
          },
        },
      ],
    },
    detail: {
      _id: "detail",
      _type: "view",
      _title: "Detail",
      _children: [],
    },
  };

  private readonly flows = {
    create_customer: {
      _id: "create_customer",
      _type: "flow",
      _title: "Create Customer",
      _description: "Creates a customer record from form data.",
      _steps: [
        {
          _id: "validate",
          _command: {
            _module: "entity-manager",
            _op: "add",
            _params: {
              _entity: "customer",
            },
          },
        },
      ],
    },
  };

  private readonly entities = {
    customer: {
      _id: "customer",
      _title: "Customer",
      _description: "Customer profile schema.",
      _schema: {
        name: {
          _type: "String",
          _required: true,
          _index: {
            _unique: true,
          },
        },
        email: {
          _type: "String",
          _index: true,
        },
        status: {
          _type: "String",
          _default: "active",
        },
      },
      _data: [
        {
          _id: "record-1",
          name: "Do not leak",
          email: "secret@example.com",
        },
      ],
      records: [
        {
          _id: "record-2",
          name: "Do not leak either",
        },
      ],
    },
  };

  constructor() {
    super({ _name: "server-xvm" });
  }

  async _list_apps(xcmd: XCommand) {
    const env = xcmd._params?._env;
    const apps = !env || env === "default" ? [this.app] : [];
    return {
      _ok: true,
      _result: {
        _app_ids: apps.map((app) => app._app_id),
        _apps: apps,
      },
    };
  }

  async _get_app(xcmd: XCommand) {
    this.assertApp(xcmd);
    return {
      _ok: true,
      _result: {
        _app: this.app,
        _view_ids: Object.keys(this.views),
        _flow_ids: Object.keys(this.flows),
        _entity_ids: Object.keys(this.entities),
        _entities: this.entities,
      },
    };
  }

  async _list_views(xcmd: XCommand) {
    this.assertApp(xcmd);
    return {
      _ok: true,
      _result: {
        _views: Object.values(this.views).map((view) => ({
          _id: view._id,
          _type: view._type,
          _title: view._title,
          _children_count: view._children.length,
        })),
      },
    };
  }

  async _get_view(xcmd: XCommand) {
    this.assertApp(xcmd);
    const view_id = xcmd._params?._view_id;
    const view = this.views[view_id as keyof typeof this.views];
    if (!view) throw new XError("E_XVM_VIEW_NOT_FOUND", `View not found: ${view_id}`);

    return {
      _ok: true,
      _result: {
        _app_id: "1p9",
        _env: "default",
        _version: this.app._meta._version,
        _view: view,
      },
    };
  }

  async _list_flows(xcmd: XCommand) {
    this.assertApp(xcmd);
    return {
      _ok: true,
      _result: {
        _flows: Object.values(this.flows).map((flow) => ({
          _id: flow._id,
          _type: flow._type,
          _title: flow._title,
          _description: flow._description,
        })),
      },
    };
  }

  async _get_flow(xcmd: XCommand) {
    this.assertApp(xcmd);
    const flow_id = xcmd._params?._flow_id;
    const flow = this.flows[flow_id as keyof typeof this.flows];
    if (!flow) throw new XError("E_XVM_FLOW_NOT_FOUND", `Flow not found: ${flow_id}`);

    return {
      _ok: true,
      _result: {
        _app_id: "1p9",
        _env: "default",
        _version: this.app._meta._version,
        _flow: flow,
      },
    };
  }

  private assertApp(xcmd: XCommand): void {
    if (xcmd._params?._app_id !== "1p9" || (xcmd._params?._env ?? "default") !== "default") {
      throw new XError("E_XVM_APP_NOT_FOUND", `App not found: ${String(xcmd._params?._app_id)}`);
    }
  }
}

class TestXVibeModule extends XModule {
  static lastParams: Record<string, unknown> | undefined;
  static lastSemanticParams: Record<string, unknown> | undefined;
  static lastDataFeatureParams: Record<string, unknown> | undefined;
  static runtimeSkillSnapshots = new Map<string, Record<string, any>>();

  constructor() {
    super({ _name: "xvibe" });
  }

  async _plan_semantic_view_edit(xcmd: XCommand) {
    const params: Record<string, any> = isRecord(xcmd._params) ? xcmd._params : {};
    TestXVibeModule.lastSemanticParams = params;
    const target: Record<string, any> = isRecord(params._target) ? params._target : {};
    const changes = Array.isArray(params._changes) ? params._changes : [];

    if (target._label === "Ambiguous") {
      return xvibeSemanticFailure("target_ambiguous", "Semantic target is ambiguous.", {
        _needs_disambiguation: true,
        _candidates: [
          { _id: "title-a", _type: "label", _title: "Title" },
          { _id: "title-b", _type: "label", _title: "Title" },
        ],
      });
    }
    if (changes.some((change) => isRecord(change) && change._semantic_property === "unsupported")) {
      return xvibeSemanticFailure("semantic_property_unsupported", "Semantic property is unsupported.", {
        _semantic_property: "unsupported",
      });
    }
    if (changes.some((change) => isRecord(change) && change._value === "invalid-option")) {
      return xvibeSemanticFailure("invalid_option", "Semantic option is invalid.", {
        _semantic_property: "width",
        _value: "invalid-option",
        _options: ["full", "readable"],
      });
    }

    const plan = this.semanticPlan(params, target, changes);
    if (params._apply === true) {
      await this.applySemanticPlan(plan);
      return {
        _ok: true,
        _artifact_type: "mutation-plan",
        _plan: plan,
        _applied: true,
        _apply_result: {
          _ok: true,
          _status: "done",
          _completed_steps: plan._steps.length,
          _failed_steps: 0,
        },
      };
    }

    return {
      _ok: true,
      _artifact_type: "mutation-plan",
      _plan: plan,
      _applied: false,
    };
  }

  async _sync_skills(xcmd: XCommand) {
    const params: Record<string, any> = isRecord(xcmd._params) ? xcmd._params : {};
    const appId = typeof params._app_id === "string" ? params._app_id : "unknown";
    const env = typeof params._env === "string" ? params._env : "default";
    const mode = typeof params._mode === "string" ? params._mode : "runtime";
    const skills = isRecord(params._skills) ? params._skills : {};
    const snapshot = {
      _app_id: appId,
      _env: env,
      _mode: mode,
      _skills: skills,
      _skills_count: Array.isArray(skills._modules) ? skills._modules.length : 0,
      _synced_at: new Date(0).toISOString(),
    };
    TestXVibeModule.runtimeSkillSnapshots.set(this.runtimeSkillScope(appId, env, mode), snapshot);
    return {
      _ok: true,
      _result: {
        _synced: true,
        _scope: this.runtimeSkillScope(appId, env, mode),
      },
    };
  }

  async _get_runtime_skills(xcmd: XCommand) {
    const params: Record<string, any> = isRecord(xcmd._params) ? xcmd._params : {};
    const appId = typeof params._app_id === "string" ? params._app_id : "unknown";
    const env = typeof params._env === "string" ? params._env : "default";
    const mode = typeof params._mode === "string" ? params._mode : "runtime";
    const snapshot = TestXVibeModule.runtimeSkillSnapshots.get(this.runtimeSkillScope(appId, env, mode));
    return {
      _ok: true,
      _result: {
        _app_id: appId,
        _env: env,
        _mode: mode,
        _found: Boolean(snapshot),
        _skills: snapshot?._skills ?? null,
        _skills_count: snapshot?._skills_count ?? 0,
        ...(snapshot?._synced_at ? { _synced_at: snapshot._synced_at } : {}),
      },
    };
  }

  async _apply_view_edit(xcmd: XCommand) {
    const params = isRecord(xcmd._params) ? xcmd._params : {};
    TestXVibeModule.lastParams = params;
    const viewResponse = await _x.execute({
      _module: "server-xvm",
      _op: "get_view",
      _params: {
        _app_id: params._app_id,
        _env: params._env,
        _view_id: params._view_id,
      },
    } as any);
    const view = (viewResponse as any)?._result?._view;
    if (!isRecord(view)) {
      return xvibeFailure("E_XVIBE_APPLY_VIEW_EDIT_VIEW_NOT_FOUND", "View not found.");
    }

    const action = params._edit_action;
    if (action === "add-child") return this.addChild(view, params);
    if (action === "set-property") return this.setProperty(view, params);
    if (action === "set-style") return this.setStyle(view, params);
    if (action === "set-styles") return this.setStyles(view, params);
    if (action === "remove-style") return this.removeStyle(view, params);
    if (action === "move-object") return this.moveObject(view, params);
    if (action === "remove-object") return this.removeObject(view, params);

    return xvibeFailure("E_XVIBE_UNSUPPORTED_EDIT_ACTION", "Unsupported edit action.");
  }

  private semanticPlan(
    params: Record<string, unknown>,
    target: Record<string, unknown>,
    changes: unknown[],
  ): Record<string, any> {
    const targetId =
      target._id === "xgallery"
        ? "xgallery"
        : target._type === "xpage"
          ? "main"
          : "main-section";
    const steps = changes.map((change, index) => {
      const semanticProperty =
        isRecord(change) && typeof change._semantic_property === "string"
          ? change._semantic_property
          : "";
      const value =
        isRecord(change) ? change._value : undefined;
      const stylePath =
        target._semantic_child === "title" && semanticProperty === "font-size"
          ? "_item._styles._title._style"
          : undefined;
      const primitiveParams = stylePath
        ? {
          _app_id: params._app_id,
          _env: params._env,
          _view_id: params._view_id,
          _edit_action: "set-style",
          _target_id: targetId,
          _style_object_path: stylePath,
          _style_property: semanticProperty,
          _style_value: value,
        }
        : {
          _app_id: params._app_id,
          _env: params._env,
          _view_id: params._view_id,
          _edit_action: "set-property",
          _target_id: targetId,
          _property_name: `_${semanticProperty}`,
          _property_value: value,
        };

      return {
        _id: `semantic-step-${index + 1}`,
        _title: `Set ${semanticProperty}`,
        _status: "planned",
        _resolution_state: "deterministic",
        _primitive: {
          _module: "xvibe",
          _op: "apply-view-edit",
          _params: primitiveParams,
        },
      };
    });

    return {
      _type: "mutation-plan",
      _title: "Semantic View Edit",
      _goal: "Apply deterministic semantic view edits.",
      _summary: "XVibe planned deterministic semantic view edits.",
      _steps: steps,
      _estimated_mutations: steps.length,
      _executable_steps: steps.length,
      _unsupported_steps: 0,
      _can_apply: true,
      _status: "planned",
    };
  }

  private runtimeSkillScope(appId: string, env: string, mode: string) {
    return `${env}::${appId}::${mode}`;
  }

  private async applySemanticPlan(plan: Record<string, any>) {
    const firstParams = plan._steps?.[0]?._primitive?._params;
    if (!isRecord(firstParams)) return;
    const viewResponse = await _x.execute({
      _module: "server-xvm",
      _op: "get_view",
      _params: {
        _app_id: firstParams._app_id,
        _env: firstParams._env,
        _view_id: firstParams._view_id,
      },
    } as any);
    const view = (viewResponse as any)?._result?._view;
    if (!isRecord(view)) return;

    for (const step of Array.isArray(plan._steps) ? plan._steps : []) {
      const params = step?._primitive?._params;
      if (!isRecord(params)) continue;
      const target = findObject(view, String(params._target_id));
      if (!target) continue;

      if (params._edit_action === "set-property" && typeof params._property_name === "string") {
        target[params._property_name] = params._property_value;
      }

      if (params._edit_action === "set-style" && typeof params._style_property === "string") {
        target._style = isRecord(target._style) ? target._style : {};
        target._style[params._style_property] = params._style_value;
      }
    }
  }

  private addChild(view: Record<string, any>, params: Record<string, unknown>) {
    const target = findObject(view, String(params._target_id));
    if (!target) return xvibeFailure("E_XVIBE_TARGET_NOT_FOUND", "Target not found.");
    if (!isRecord(params._child)) return xvibeFailure("E_XVIBE_INVALID_CHILD", "Invalid child.");
    const child = params._child as Record<string, any>;
    const childType = typeof child._type === "string" ? child._type : "";
    const runtimeTypes = Array.isArray(params._runtime_xui_types) ? params._runtime_xui_types : [];
    if (!runtimeTypes.includes(childType)) {
      return xvibeFailure("E_XVIBE_UNSUPPORTED_XUI_TYPE", "Unsupported XUI object type in view edit payload.");
    }
    if (typeof child._id === "string" && findObject(view, child._id)) {
      return xvibeFailure("E_XVIBE_DUPLICATE_ID", `Duplicate id: ${child._id}`);
    }
    target._children = Array.isArray(target._children) ? target._children : [];
    target._children.push(child);
    return xvibeSuccess("add-child", view, {
      _target_id: target._id,
      _child_id: child._id,
      _child_type: child._type,
    });
  }

  private setProperty(view: Record<string, any>, params: Record<string, unknown>) {
    const target = findObject(view, String(params._target_id));
    if (!target) return xvibeFailure("E_XVIBE_TARGET_NOT_FOUND", "Target not found.");
    const propertyName = typeof params._property_name === "string" ? params._property_name : "";
    if (!propertyName) return xvibeFailure("E_XVIBE_INVALID_PROPERTY", "Invalid property path.");
    target[propertyName] = params._property_value;
    return xvibeSuccess("set-property", view, { _target_id: target._id, _property_name: propertyName });
  }

  private setStyle(view: Record<string, any>, params: Record<string, unknown>) {
    const target = findObject(view, String(params._target_id));
    if (!target) return xvibeFailure("E_XVIBE_TARGET_NOT_FOUND", "Target not found.");
    const property = typeof params._style_property === "string" ? params._style_property : "";
    if (!property) return xvibeFailure("E_XVIBE_INVALID_STYLE_PATH", "Invalid style path.");
    target._style = isRecord(target._style) ? target._style : {};
    target._style[property] = params._style_value;
    return xvibeSuccess("set-style", view, { _target_id: target._id, _style_property: property });
  }

  private setStyles(view: Record<string, any>, params: Record<string, unknown>) {
    const target = findObject(view, String(params._target_id));
    if (!target) return xvibeFailure("E_XVIBE_TARGET_NOT_FOUND", "Target not found.");
    if (!isRecord(params._styles)) return xvibeFailure("E_XVIBE_INVALID_STYLE_PATH", "Invalid style path.");
    target._style = isRecord(target._style) ? target._style : {};
    Object.assign(target._style, params._styles);
    return xvibeSuccess("set-styles", view, { _target_id: target._id, _styles_applied: params._styles });
  }

  private removeStyle(view: Record<string, any>, params: Record<string, unknown>) {
    const target = findObject(view, String(params._target_id));
    if (!target) return xvibeFailure("E_XVIBE_TARGET_NOT_FOUND", "Target not found.");
    const property = typeof params._style_property === "string" ? params._style_property : "";
    if (!property || !isRecord(target._style)) {
      return xvibeFailure("E_XVIBE_INVALID_STYLE_PATH", "Invalid style path.");
    }
    delete target._style[property];
    return xvibeSuccess("remove-style", view, { _target_id: target._id, _style_property: property });
  }

  private moveObject(view: Record<string, any>, params: Record<string, unknown>) {
    const targetId = String(params._target_id);
    const beforeId = typeof params._before_id === "string" ? params._before_id : undefined;
    const afterId = typeof params._after_id === "string" ? params._after_id : undefined;
    if (Boolean(beforeId) === Boolean(afterId)) {
      return xvibeFailure("E_XVIBE_INVALID_MOVE", "Invalid move.");
    }
    const targetLocation = findObjectParent(view, targetId);
    if (!targetLocation) return xvibeFailure("E_XVIBE_TARGET_NOT_FOUND", "Target not found.");
    const anchorLocation = findObjectParent(view, beforeId ?? afterId ?? "");
    if (!anchorLocation) return xvibeFailure("E_XVIBE_INVALID_MOVE", "Invalid move.");
    const [item] = targetLocation.parent._children.splice(targetLocation.index, 1);
    const nextAnchorLocation = findObjectParent(view, beforeId ?? afterId ?? "");
    if (!nextAnchorLocation) return xvibeFailure("E_XVIBE_INVALID_MOVE", "Invalid move.");
    const insertIndex = beforeId ? nextAnchorLocation.index : nextAnchorLocation.index + 1;
    nextAnchorLocation.parent._children.splice(insertIndex, 0, item);
    return xvibeSuccess("move-object", view, {
      _target_id: targetId,
      ...(beforeId ? { _before_id: beforeId } : {}),
      ...(afterId ? { _after_id: afterId } : {}),
    });
  }

  private removeObject(view: Record<string, any>, params: Record<string, unknown>) {
    const targetLocation = findObjectParent(view, String(params._target_id));
    if (!targetLocation) return xvibeFailure("E_XVIBE_TARGET_NOT_FOUND", "Target not found.");
    const [removed] = targetLocation.parent._children.splice(targetLocation.index, 1);
    return xvibeSuccess("remove-object", view, {
      _target_id: removed?._id,
      _removed_type: removed?._type,
    });
  }
}

class TestXVibeDataFeatureModule extends TestXVibeModule {
  async _data_feature(xcmd: XCommand) {
    const params: Record<string, any> = isRecord(xcmd._params) ? xcmd._params : {};
    TestXVibeModule.lastDataFeatureParams = params;
    const fields = Array.isArray(params._fields) ? params._fields : [];
    const fieldIds = fields
      .map((field) => isRecord(field) ? field._field_id : undefined)
      .filter((field): field is string => typeof field === "string");
    const duplicateField = fieldIds.find((fieldId, index) => fieldIds.indexOf(fieldId) !== index);
    if (duplicateField) {
      return xvibeDataFeatureFailure("duplicate_field_id", "Duplicate field id.", {
        _field_id: duplicateField,
      });
    }
    const unsupportedField = fields.find((field) =>
      isRecord(field) &&
      !["String", "Number", "Boolean", "Date"].includes(String(field._type))
    );
    if (unsupportedField) {
      return xvibeDataFeatureFailure("unsupported_field_type", "Unsupported field type.", {
        _field_id: unsupportedField._field_id,
        _type: unsupportedField._type,
      });
    }
    if (params._entity_id === "conflict") {
      return xvibeDataFeatureFailure("artifact_conflict", "Data Feature apply blocked by existing artifact conflicts.", {
        _conflicts: [
          {
            _reason: "artifact_conflict",
            _artifact_type: "entity",
            _artifact_id: "conflict",
            _node_id: "entity:conflict",
          },
        ],
      });
    }

    const entityId = String(params._entity_id);
    const graph = {
      _nodes: [
        { _id: `entity:${entityId}`, _artifact_type: "entity", _artifact_id: entityId, _exists: false },
        { _id: `flow:create-${entityId}`, _artifact_type: "flow", _artifact_id: `create-${entityId}`, _exists: false },
        { _id: `flow:update-${entityId}`, _artifact_type: "flow", _artifact_id: `update-${entityId}`, _exists: false },
        { _id: `flow:delete-${entityId}`, _artifact_type: "flow", _artifact_id: `delete-${entityId}`, _exists: false },
        { _id: `form:create-${entityId}`, _artifact_type: "form", _artifact_id: `create-${entityId}`, _exists: false },
        {
          _id: `view:${entityId}-list`,
          _artifact_type: "view",
          _artifact_id: `${entityId}-list`,
          _exists: false,
          _children: [
            { _id: `table:${entityId}-list`, _artifact_type: "table", _artifact_id: `${entityId}-list`, _exists: false },
          ],
        },
      ],
      _summary: {
        _total: 7,
        _existing: 0,
        _missing: 7,
      },
    };
    const plan = {
      _ok: true,
      _op: "data-feature",
      _app_id: params._app_id,
      _env: params._env,
      _feature_name: params._feature_name,
      _entity_id: entityId,
      _apply: false,
      _graph: graph,
      _artifacts: [
        { _artifact_type: "entity", _artifact_id: entityId, _role: "entity", _status: "created" },
        { _artifact_type: "flow", _artifact_id: `create-${entityId}`, _role: "create_flow", _status: "created" },
        { _artifact_type: "flow", _artifact_id: `update-${entityId}`, _role: "update_flow", _status: "created" },
        { _artifact_type: "flow", _artifact_id: `delete-${entityId}`, _role: "delete_flow", _status: "created" },
        { _artifact_type: "view", _artifact_id: `create-${entityId}`, _role: "create_form", _status: "created" },
        { _artifact_type: "view", _artifact_id: `${entityId}-list`, _role: "list_view", _status: "created" },
      ],
      _conflicts: [],
      _can_apply: true,
    };
    if (params._entity_id === "partial") {
      return {
        ...plan,
        _apply: true,
        _execution_status: "partial_failed",
        _reason: "partial_failed",
        _completed_nodes: [{ _id: "entity:partial", _artifact_type: "entity", _artifact_id: "partial", _status: "created" }],
        _skipped_existing_nodes: [],
        _failed_node: {
          _id: "table:partial-list",
          _artifact_type: "table",
          _artifact_id: "partial-list",
          _status: "failed",
        },
        _missing_artifacts: [{ _id: "table:partial-list", _artifact_type: "table", _artifact_id: "partial-list", _status: "failed" }],
        _summary: { _existing: 0, _created: 1, _skipped: 0, _failed: 1 },
      };
    }
    if (params._apply === true) {
      return {
        ...plan,
        _apply: true,
        _execution_status: "completed",
        _completed_nodes: graph._nodes.map((node) => ({
          _id: node._id,
          _artifact_type: node._artifact_type,
          _artifact_id: node._artifact_id,
          _status: "created",
        })),
        _skipped_existing_nodes: [],
        _missing_artifacts: [],
        _summary: { _existing: 0, _created: 6, _skipped: 0, _failed: 0 },
      };
    }
    return plan;
  }
}

test("@xpell/mcp package does not depend on XVibe", async () => {
  const pkg = JSON.parse(await readFile(path.resolve("package.json"), "utf-8"));
  assert.equal(pkg.dependencies?.["@xpell/vibe"], undefined);
  assert.equal(pkg.dependencies?.xvibe, undefined);
});

test("MCP and XVibe runtime type discovery do not hardcode XDashboard package types", async () => {
  const mcpSource = await readFile(path.resolve("src/MCPToolRegistry.ts"), "utf-8");
  const xvibeRegistrySource = await readFile(
    path.resolve("../xvibe/src/XVIBE/StructuredEditing/XUITypeRegistry.ts"),
    "utf-8",
  );

  for (const source of [mcpSource, xvibeRegistrySource]) {
    assert.equal(source.includes("\"xgallery\""), false);
    assert.equal(source.includes("\"xlist\""), false);
    assert.equal(source.includes("\"xpage\""), false);
  }
});

test("MCP disabled handler is unavailable by default", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler();
  const response = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
    token: "valid-token",
  });

  assert.equal(response.status, 404);
  assert.match(response.text, /E_XMCP_DISABLED/);
});

test("MCP route mounts only when enabled", () => {
  const disabledApp = new FakeApp();
  const disabled = mountXpellMCPRoute(disabledApp, {
    _settings: { enabled: false },
  });

  assert.equal(disabled._mounted, false);
  assert.equal(disabledApp.routes.length, 1);
  assert.equal(disabledApp.routes[0]?._path, "/mcp");

  const enabledApp = new FakeApp();
  const enabled = mountXpellMCPRoute(enabledApp, {
    _settings: {
      enabled: true,
      path: "/mcp",
      require_auth: true,
    },
  });

  assert.equal(enabled._mounted, true);
  assert.equal(enabled._path, "/mcp");
  assert.equal(enabled._require_auth, true);
  assert.equal(enabledApp.routes[0]?._path, "/mcp");
});

test("MCP module does not expose token issuance operations", () => {
  assert.equal(MCP_OPS["issue-token"], undefined);
});

test("MCP status reports mounted route state as the runtime truth", async () => {
  await resetRuntime();
  const disabledApp = new FakeApp();
  mountXpellMCPRoute(disabledApp, {
    _settings: {
      enabled: false,
      path: "/mcp",
      require_auth: true,
    },
  });

  let module = new MCPModule();
  let status = module._status();

  assert.equal(status._enabled, false);
  assert.equal(status._mounted, false);
  assert.equal(status._path, "/mcp");
  assert.equal(status._transport, "streamable-http");
  assert.equal(status._require_auth, true);
  assert.equal(status._mcp._enabled, false);
  assert.equal(status._mcp._mounted, false);

  const enabledApp = new FakeApp();
  mountXpellMCPRoute(enabledApp, {
    _settings: {
      enabled: true,
      path: "/mcp",
      require_auth: true,
    },
  });

  module = new MCPModule();
  status = module._status();

  assert.equal(status._enabled, true);
  assert.equal(status._mounted, true);
  assert.equal(status._path, "/mcp");
  assert.equal(status._transport, "streamable-http");
  assert.equal(status._require_auth, true);
  assert.equal(status._mcp._enabled, true);
  assert.equal(status._mcp._mounted, true);
  assert.equal(status._mcp._path, "/mcp");
});

test("MCP auth rejects missing and invalid bearer tokens", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const missing = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
  });
  assert.equal(missing.status, 401);
  assert.match(missing.text, /E_XMCP_AUTH_REQUIRED/);
  assert.equal(
    missing.headers["WWW-Authenticate"],
    "Bearer resource_metadata=\"http://localhost:3000/.well-known/oauth-protected-resource/mcp\", scope=\"xpell:read xpell:write xpell:admin\"",
  );

  const invalid = await callMCP(handler, {
    body: rpc(2, "tools/list", {}),
    token: "invalid-token",
    headers: {
      cookie: "xauth_session=browser-cookie-secret",
    },
  });
  assert.equal(invalid.status, 401);
  assert.match(invalid.text, /E_XMCP_INVALID_AUTH/);
  const invalid_serialized = JSON.stringify({
    headers: invalid.headers,
    text: invalid.text,
  });
  assert.equal(invalid_serialized.includes("invalid-token"), false);
  assert.equal(invalid_serialized.includes("browser-cookie-secret"), false);
});

test("MCP pre-ready requests require auth and do not expose partial tools", async () => {
  await resetRuntime();
  markXpellMCPRuntimeStarting("test_runtime_loading");
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const missing = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
  });
  assert.equal(missing.status, 401);
  assert.match(missing.text, /E_XMCP_AUTH_REQUIRED/);

  const listed = await callMCP(handler, {
    body: rpc(2, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(listed.status, 503);
  assert.equal(listed.headers["Retry-After"], "1");
  const body = JSON.parse(listed.text);
  assert.equal(body._ok, false);
  assert.equal(body._error._code, "E_XMCP_RUNTIME_NOT_READY");
  assert.equal(body._error._retryable, true);
  assert.equal(JSON.stringify(body).includes("xpell_apply_semantic_view_edit"), false);
  assert.equal(JSON.stringify(body).includes("tools"), false);
});

test("MCP startup race returns 503 before readiness and complete tools after module graph loads", async () => {
  await resetRuntime({ xvibe: false });
  markXpellMCPRuntimeStarting("test_runtime_loading");
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const early = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(early.status, 503);
  assert.match(early.text, /E_XMCP_RUNTIME_NOT_READY/);
  assert.equal(early.text.includes("xpell_apply_semantic_view_edit"), false);
  assert.equal(early.text.includes("xpell_create_data_feature"), false);

  await _x.loadModuleAsync(new TestXVibeDataFeatureModule());
  markXpellMCPRuntimeReady("test_runtime_ready");

  const listed = await callMCP(handler, {
    body: rpc(2, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(listed.status, 200);
  const toolNames = parseMCPResponse(listed.text).result.tools.map((tool: any) => tool.name);
  assert.deepEqual(toolNames, DEFAULT_TOOL_NAMES);
});

test("MCP OAuth protected resource metadata advertises canonical resource and scopes", async () => {
  const settings = normalizeMCPSettings({
    enabled: true,
    require_auth: true,
    path: "/mcp",
  });

  const metadata = createXpellMCPProtectedResourceMetadata(settings, {
    headers: {
      host: "xpell.example.com",
      "x-forwarded-proto": "https",
    },
  });

  assert.equal(getXpellMCPProtectedResourceMetadataPath(settings.path), "/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.resource, "https://xpell.example.com/mcp");
  assert.deepEqual(metadata.authorization_servers, ["https://xpell.example.com"]);
  assert.deepEqual(metadata.scopes_supported, ["xpell:read", "xpell:write", "xpell:admin"]);
  assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
});

test("MCP OAuth challenge derives path-specific protected resource metadata URL", async () => {
  const settings = normalizeMCPSettings({
    enabled: true,
    require_auth: true,
    path: "/mcp",
  });

  assert.equal(
    createXpellMCPWWWAuthenticateChallenge(settings, {
      headers: {
        host: "xpell.example.com",
        "x-forwarded-proto": "https",
      },
    }),
    "Bearer resource_metadata=\"https://xpell.example.com/.well-known/oauth-protected-resource/mcp\", scope=\"xpell:read xpell:write xpell:admin\"",
  );
});

test("MCP auth rejects browser session JWT contexts as MCP bearer credentials", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const response = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
    token: "browser-session-token",
  });

  assert.equal(response.status, 401);
  assert.match(response.text, /E_XMCP_INVALID_AUTH/);
});

test("MCP tool discovery and tool calls work with valid auth", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const listed = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(listed.status, 200);
  const tools = parseMCPResponse(listed.text).result.tools;
  const toolNames = tools.map((tool: any) => tool.name);
  assert.deepEqual(toolNames, DEFAULT_TOOL_NAMES);
  assert.equal(toolNames.includes("execute"), false);

  const status = await callMCP(handler, {
    body: rpc(2, "tools/call", {
      name: "xpell_server_status",
      arguments: {},
    }),
    token: "valid-token",
  });
  assert.equal(status.status, 200);
  const statusContent = parseStructuredContent(status.text);
  assert.equal(statusContent._ok, true);
  assert.equal(statusContent._xpell_available, true);
  assert.equal(statusContent._mcp._package, "@xpell/mcp");

  const capabilities = await callMCP(handler, {
    body: rpc(3, "tools/call", {
      name: "xpell_get_capabilities",
      arguments: {},
    }),
    token: "valid-token",
  });
  assert.equal(capabilities.status, 200);
  const capabilityContent = parseStructuredContent(capabilities.text);
  const modules = capabilityContent._xpell_capabilities._modules;
  assert.ok(modules.some((mod: any) => mod._name === "test-capability-module"));
  assert.ok(
    capabilityContent._xpell_capabilities._components.some((component: any) =>
      component._type === "xgallery" &&
      component._category === "collection-presentation"
    ),
  );
});

test("MCP Phase 2 read tools inspect app artifacts through server-xvm without leaking paths or records", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const listApps = await callTool(handler, "xpell_list_apps", {
    env: "default",
  });
  assert.equal(listApps._ok, true);
  assert.deepEqual(listApps._result._app_ids, ["1p9"]);
  assert.equal(listApps._result._apps[0]._app_id, "1p9");

  const app = await callTool(handler, "xpell_get_app", {
    app_id: "1p9",
    env: "default",
  });
  assert.equal(app._result._entry_view_id, "main");
  assert.deepEqual(app._result._view_ids, ["main", "detail"]);
  assert.deepEqual(app._result._flow_ids, ["create_customer"]);
  assert.deepEqual(app._result._entity_ids, ["customer"]);

  const views = await callTool(handler, "xpell_list_views", {
    app_id: "1p9",
    env: "default",
  });
  assert.equal(views._result._entry_view_id, "main");
  assert.equal(views._result._views.find((view: any) => view._id === "main")._is_entry, true);

  const view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  assert.equal(view._result._view._id, "main");
  assert.equal(view._result._view._children[1]._type, "button");
  assert.equal(view._result._view._children[1]._flow, "create_customer");

  const flows = await callTool(handler, "xpell_list_flows", {
    app_id: "1p9",
    env: "default",
  });
  assert.deepEqual(flows._result._flows.map((flow: any) => flow._id), ["create_customer"]);

  const flow = await callTool(handler, "xpell_get_flow", {
    app_id: "1p9",
    env: "default",
    flow_id: "create_customer",
  });
  assert.equal(flow._result._flow._steps[0]._command._module, "entity-manager");

  const entities = await callTool(handler, "xpell_list_entities", {
    app_id: "1p9",
    env: "default",
  });
  assert.equal(entities._result._entities[0]._id, "customer");
  assert.equal(entities._result._entities[0]._field_count, 3);
  assert.deepEqual(entities._result._entities[0]._schema_meta._required_fields, ["name"]);

  const entity = await callTool(handler, "xpell_get_entity_schema", {
    app_id: "1p9",
    env: "default",
    entity_id: "customer",
  });
  assert.equal(entity._result._entity._schema.name._required, true);

  const combined = JSON.stringify({
    listApps,
    app,
    views,
    view,
    flows,
    flow,
    entities,
    entity,
  });
  assert.equal(combined.includes("/Users/example"), false);
  assert.equal(combined.includes("Do not leak"), false);
  assert.equal(combined.includes("secret@example.com"), false);
  assert.equal(combined.includes("_data"), false);
  assert.equal(combined.includes("records"), false);
});

test("MCP Phase 2 read tools return useful errors and preserve admin read boundary", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const lowClearance = await callMCP(handler, {
    body: rpc(1, "tools/call", {
      name: "xpell_list_apps",
      arguments: {
        env: "default",
      },
    }),
    token: "low-token",
  });
  assert.equal(lowClearance.status, 200);
  const lowClearanceResponse = parseMCPResponse(lowClearance.text);
  assert.equal(lowClearanceResponse.result.isError, true);
  assert.equal(lowClearanceResponse.result.structuredContent._error._code, "E_XMCP_ADMIN_REQUIRED");

  const missingView = await callMCP(handler, {
    body: rpc(2, "tools/call", {
      name: "xpell_get_view",
      arguments: {
        app_id: "1p9",
        env: "default",
        view_id: "missing",
      },
    }),
    token: "valid-token",
  });
  assert.equal(missingView.status, 200);
  const missingViewResponse = parseMCPResponse(missingView.text);
  assert.equal(missingViewResponse.result.isError, true);
  assert.equal(missingViewResponse.result.structuredContent._error._code, "E_XVM_VIEW_NOT_FOUND");

  const missingEntity = await callMCP(handler, {
    body: rpc(3, "tools/call", {
      name: "xpell_get_entity_schema",
      arguments: {
        app_id: "1p9",
        env: "default",
        entity_id: "missing",
      },
    }),
    token: "valid-token",
  });
  assert.equal(missingEntity.status, 200);
  const missingEntityResponse = parseMCPResponse(missingEntity.text);
  assert.equal(missingEntityResponse.result.isError, true);
  assert.equal(missingEntityResponse.result.structuredContent._error._code, "E_XVM_ENTITY_NOT_FOUND");
});

test("MCP Phase 3 apply-view-edit requires auth and admin clearance", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });
  const args = {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "add-child",
    target_id: "main",
    child: {
      _id: "auth-label",
      _type: "label",
      _text: "Auth",
    },
  };

  const unauthenticated = await callMCP(handler, {
    body: rpc(1, "tools/call", {
      name: "xpell_apply_view_edit",
      arguments: args,
    }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.text, /E_XMCP_AUTH_REQUIRED/);

  const lowClearance = await callMCP(handler, {
    body: rpc(2, "tools/call", {
      name: "xpell_apply_view_edit",
      arguments: args,
    }),
    token: "low-token",
  });
  assert.equal(lowClearance.status, 200);
  const lowClearanceResponse = parseMCPResponse(lowClearance.text);
  assert.equal(lowClearanceResponse.result.isError, true);
  assert.equal(lowClearanceResponse.result.structuredContent._error._code, "E_XMCP_ADMIN_REQUIRED");

  const adminWithoutPermissionClaims = await callMCP(handler, {
    body: rpc(3, "tools/call", {
      name: "xpell_apply_view_edit",
      arguments: args,
    }),
    token: "admin-token-without-permissions",
  });
  assert.equal(adminWithoutPermissionClaims.status, 200);
  const adminWithoutPermissionClaimsResponse = parseMCPResponse(adminWithoutPermissionClaims.text);
  assert.equal(adminWithoutPermissionClaimsResponse.result.isError, undefined);
});

test("MCP Phase 3 apply-view-edit delegates deterministic mutations to XVibe", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const listed = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(listed.status, 200);
  const tools = parseMCPResponse(listed.text).result.tools;
  const applyTool = tools.find((tool: any) => tool.name === "xpell_apply_view_edit");
  assert.ok(applyTool);
  assert.equal(applyTool.annotations.readOnlyHint, false);

  const addLabel = await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "add-child",
    target_id: "main",
    child: {
      _id: "codex-demo-label",
      _type: "label",
      _text: "Hello from Codex",
    },
  });
  assert.equal(addLabel._ok, true);
  assert.equal(addLabel._mutation._action, "add-child");
  assert.equal(addLabel._mutation._child_type, "label");
  assert.deepEqual(TestXVibeModule.lastParams?._runtime_xui_types, [
    "badge",
    "label",
    "xcalendar",
    "xgallery",
    "xkanban",
    "xlist",
    "xpage",
    "xsection",
    "xtimeline",
  ]);

  let view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  let added = findObject(view._result._view, "codex-demo-label");
  assert.equal(added?._type, "label");
  assert.equal(added?._text, "Hello from Codex");

  await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "set-property",
    target_id: "codex-demo-label",
    property_name: "_text",
    property_value: "Updated by Codex",
  });
  view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  added = findObject(view._result._view, "codex-demo-label");
  assert.equal(added?._text, "Updated by Codex");

  await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "set-style",
    target_id: "codex-demo-label",
    style_property: "font-size",
    style_value: "24px",
  });
  await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "set-styles",
    target_id: "codex-demo-label",
    styles: {
      color: "red",
      margin: "8px",
    },
  });
  await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "remove-style",
    target_id: "codex-demo-label",
    style_property: "margin",
  });
  view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  added = findObject(view._result._view, "codex-demo-label");
  assert.equal(added?._style["font-size"], "24px");
  assert.equal(added?._style.color, "red");
  assert.equal(added?._style.margin, undefined);

  await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "add-child",
    target_id: "main",
    child: {
      _id: "codex-gallery",
      _type: "xgallery",
      _items: [],
    },
  });
  await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "move-object",
    target_id: "codex-gallery",
    target_type: "xgallery",
    before_id: "headline",
  });
  await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "remove-object",
    target_id: "open-form",
  });
  view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  const children = view._result._view._children;
  assert.equal(children[0]._id, "codex-gallery");
  assert.equal(children[0]._type, "xgallery");
  assert.equal(findObject(view._result._view, "open-form"), undefined);
});

test("MCP apply-view-edit and capabilities use effective scoped runtime XUI types", async () => {
  await resetRuntime({ capability: false });
  await _x.execute({
    _module: "xvibe",
    _op: "sync-skills",
    _params: {
      _app_id: "1p9",
      _env: "default",
      _mode: "runtime",
      _skills: SCOPED_PACKAGE_RUNTIME_SKILLS,
    },
  } as any);

  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const capabilities = await callTool(handler, "xpell_get_capabilities", {
    app_id: "1p9",
    env: "default",
    include_components: true,
  });
  const runtimeTypes = capabilities._xpell_capabilities._runtime_xui_types;
  assert.ok(runtimeTypes.includes("xgallery"));
  assert.ok(runtimeTypes.includes("xlist"));
  assert.ok(runtimeTypes.includes("xpage"));
  assert.ok(capabilities._xpell_capabilities._skill_sources.includes("server-runtime"));
  assert.ok(capabilities._xpell_capabilities._skill_sources.includes("xvibe-scoped-runtime-skills"));
  assert.ok(
    capabilities._xpell_capabilities._components.some((component: any) =>
      component._type === "xgallery" &&
      component._category === "collection-presentation"
    ),
  );

  const otherAppCapabilities = await callTool(handler, "xpell_get_capabilities", {
    app_id: "other-app",
    env: "default",
    include_components: true,
    type: "xgallery",
  });
  assert.equal(otherAppCapabilities._xpell_capabilities._component_count, 0);
  assert.equal(otherAppCapabilities._xpell_capabilities._runtime_xui_types.includes("xgallery"), false);

  const addGallery = await callTool(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "add-child",
    target_id: "main",
    child: {
      _id: "scoped-gallery",
      _type: "xgallery",
      _items: [],
    },
  });
  assert.equal(addGallery._ok, true);
  assert.equal(addGallery._mutation._child_type, "xgallery");
  assert.ok((TestXVibeModule.lastParams?._runtime_xui_types as any[]).includes("xgallery"));
  assert.ok((TestXVibeModule.lastParams?._runtime_xui_types as any[]).includes("xlist"));
  assert.ok((TestXVibeModule.lastParams?._runtime_xui_types as any[]).includes("xpage"));

  const view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  assert.equal(findObject(view._result._view, "scoped-gallery")?._type, "xgallery");

  const unsupported = await callToolExpectError(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "add-child",
    target_id: "main",
    child: {
      _id: "made-up-widget",
      _type: "made-up-widget",
    },
  });
  assert.equal(unsupported._error._code, "E_XVIBE_UNSUPPORTED_XUI_TYPE");
});

test("MCP Phase 3 apply-view-edit preserves precise XVibe failures", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const unsupportedType = await callToolExpectError(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "add-child",
    target_id: "main",
    child: {
      _id: "bad-widget",
      _type: "unknown-widget",
    },
  });
  assert.equal(unsupportedType._error._code, "E_XVIBE_UNSUPPORTED_XUI_TYPE");

  const duplicate = await callToolExpectError(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "add-child",
    target_id: "main",
    child: {
      _id: "headline",
      _type: "label",
      _text: "Should not overwrite",
    },
  });
  assert.equal(duplicate._error._code, "E_XVIBE_DUPLICATE_ID");
  const view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  assert.equal(findObject(view._result._view, "headline")?._text, "Customers");

  const targetNotFound = await callToolExpectError(handler, "xpell_apply_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    edit_action: "add-child",
    target_id: "missing-target",
    child: {
      _id: "orphan-label",
      _type: "label",
      _text: "No target",
    },
  });
  assert.equal(targetNotFound._error._code, "E_XVIBE_TARGET_NOT_FOUND");
});

test("MCP semantic view-edit tool is available only when XVibe planner op exists", async () => {
  await resetRuntime({ xvibe: false });
  let handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  let listed = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(listed.status, 200);
  let toolNames = parseMCPResponse(listed.text).result.tools.map((tool: any) => tool.name);
  assert.deepEqual(toolNames, DEFAULT_TOOL_NAMES_WITHOUT_XVIBE);

  let capabilities = await callTool(handler, "xpell_get_capabilities", {});
  assert.equal(capabilities._semantic_view_edit._available, false);
  assert.equal(capabilities._mcp_tools.some((tool: any) => tool._name === "xpell_apply_semantic_view_edit"), false);

  await resetRuntime();
  handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });
  listed = await callMCP(handler, {
    body: rpc(2, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(listed.status, 200);
  const listedTools = parseMCPResponse(listed.text).result.tools;
  toolNames = listedTools.map((tool: any) => tool.name);
  assert.deepEqual(toolNames, DEFAULT_TOOL_NAMES);
  const semanticTool = listedTools.find((tool: any) => tool.name === "xpell_apply_semantic_view_edit");
  assert.equal(semanticTool.annotations.readOnlyHint, false);
  assert.equal(semanticTool.annotations.destructiveHint, true);

  capabilities = await callTool(handler, "xpell_get_capabilities", {});
  assert.equal(capabilities._semantic_view_edit._available, true);
  assert.equal(capabilities._semantic_view_edit._tool, "xpell_apply_semantic_view_edit");
  assert.equal(capabilities._semantic_view_edit._xvibe_op, "plan-semantic-view-edit");
  assert.equal(
    capabilities._mcp_tools.find((tool: any) => tool._name === "xpell_apply_semantic_view_edit")._permission,
    "runtime:write",
  );
});

test("MCP data-feature tool is available only when XVibe data-feature op exists", async () => {
  await resetRuntime({ dataFeature: false });
  let handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  let listed = await callMCP(handler, {
    body: rpc(1, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(listed.status, 200);
  let toolNames = parseMCPResponse(listed.text).result.tools.map((tool: any) => tool.name);
  assert.deepEqual(toolNames, DEFAULT_TOOL_NAMES_WITHOUT_DATA_FEATURE);

  let capabilities = await callTool(handler, "xpell_get_capabilities", {});
  assert.equal(capabilities._data_feature._available, false);
  assert.equal(capabilities._mcp_tools.some((tool: any) => tool._name === "xpell_create_data_feature"), false);

  await resetRuntime();
  handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });
  listed = await callMCP(handler, {
    body: rpc(2, "tools/list", {}),
    token: "valid-token",
  });
  assert.equal(listed.status, 200);
  const listedTools = parseMCPResponse(listed.text).result.tools;
  toolNames = listedTools.map((tool: any) => tool.name);
  assert.deepEqual(toolNames, DEFAULT_TOOL_NAMES);
  const dataFeatureTool = listedTools.find((tool: any) => tool.name === "xpell_create_data_feature");
  assert.equal(dataFeatureTool.annotations.readOnlyHint, true);
  assert.equal(dataFeatureTool.annotations.destructiveHint, true);

  capabilities = await callTool(handler, "xpell_get_capabilities", {});
  assert.equal(capabilities._data_feature._available, true);
  assert.equal(capabilities._data_feature._tool, "xpell_create_data_feature");
  assert.equal(capabilities._data_feature._xvibe_op, "data-feature");
  assert.equal(
    capabilities._mcp_tools.find((tool: any) => tool._name === "xpell_create_data_feature")._permission,
    "runtime:read",
  );
});

test("MCP data-feature uses OAuth read for plan and write for apply", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });
  const args = {
    app_id: "mycrm",
    env: "default",
    feature_name: "Customer",
    entity_id: "customer",
    fields: [
      { id: "name", type: "String", required: true },
      { id: "email", type: "String", required: true },
      { id: "status", type: "String", required: false },
    ],
  };

  const unauthenticated = await callMCP(handler, {
    body: rpc(1, "tools/call", {
      name: "xpell_create_data_feature",
      arguments: args,
    }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.text, /E_XMCP_AUTH_REQUIRED/);

  const oauthPlan = await callMCP(handler, {
    body: rpc(2, "tools/call", {
      name: "xpell_create_data_feature",
      arguments: args,
    }),
    token: "oauth-read-token",
  });
  assert.equal(oauthPlan.status, 200);
  const oauthPlanResponse = parseMCPResponse(oauthPlan.text);
  assert.equal(oauthPlanResponse.result.isError, undefined);
  assert.equal(oauthPlanResponse.result.structuredContent._apply, false);

  const oauthApplyWithoutWrite = await callMCP(handler, {
    body: rpc(3, "tools/call", {
      name: "xpell_create_data_feature",
      arguments: {
        ...args,
        apply: true,
      },
    }),
    token: "oauth-read-token",
  });
  assert.equal(oauthApplyWithoutWrite.status, 200);
  const oauthApplyWithoutWriteResponse = parseMCPResponse(oauthApplyWithoutWrite.text);
  assert.equal(oauthApplyWithoutWriteResponse.result.isError, true);
  assert.equal(
    oauthApplyWithoutWriteResponse.result.structuredContent._error._code,
    "E_XMCP_INSUFFICIENT_SCOPE",
  );

  const oauthApply = await callMCP(handler, {
    body: rpc(4, "tools/call", {
      name: "xpell_create_data_feature",
      arguments: {
        ...args,
        apply: true,
      },
    }),
    token: "oauth-write-token",
  });
  assert.equal(oauthApply.status, 200);
  const oauthApplyResponse = parseMCPResponse(oauthApply.text);
  assert.equal(oauthApplyResponse.result.isError, undefined);
  assert.equal(oauthApplyResponse.result.structuredContent._apply, true);
  assert.equal(oauthApplyResponse.result.structuredContent._execution_status, "completed");

  const legacyApply = await callMCP(handler, {
    body: rpc(5, "tools/call", {
      name: "xpell_create_data_feature",
      arguments: {
        ...args,
        apply: true,
      },
    }),
    token: "valid-token",
  });
  assert.equal(legacyApply.status, 200);
  const legacyApplyResponse = parseMCPResponse(legacyApply.text);
  assert.equal(legacyApplyResponse.result.isError, undefined);
});

test("MCP data-feature maps public input to XVibe data-feature params", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const plan = await callTool(handler, "xpell_create_data_feature", {
    app_id: "mycrm",
    env: "default",
    feature_name: "Customer",
    entity_id: "customer",
    fields: [
      { id: "name", type: "String", required: true },
      { id: "email", type: "String", required: true },
      { id: "status", type: "String", required: false },
    ],
    apply: false,
  });

  assert.equal(plan._ok, true);
  assert.equal(plan._op, "data-feature");
  assert.equal(plan._apply, false);
  assert.equal(plan._can_apply, true);
  assert.deepEqual(
    plan._artifacts.map((artifact: any) => artifact._artifact_id),
    [
      "customer",
      "create-customer",
      "update-customer",
      "delete-customer",
      "create-customer",
      "customer-list",
    ],
  );
  assert.deepEqual(TestXVibeModule.lastDataFeatureParams, {
    _app_id: "mycrm",
    _env: "default",
    _feature_name: "Customer",
    _entity_id: "customer",
    _fields: [
      { _field_id: "name", _type: "String", _required: true },
      { _field_id: "email", _type: "String", _required: true },
      { _field_id: "status", _type: "String", _required: false },
    ],
    _apply: false,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(TestXVibeModule.lastDataFeatureParams ?? {}, "_prompt"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(TestXVibeModule.lastDataFeatureParams ?? {}, "_graph_type"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(TestXVibeModule.lastDataFeatureParams ?? {}, "_execution_graph"), false);

  const applied = await callTool(handler, "xpell_create_data_feature", {
    app_id: "mycrm",
    feature_name: "Customer",
    entity_id: "customer",
    fields: [
      { id: "name", type: "String", required: true },
      { id: "email", type: "String", required: true },
      { id: "status", type: "String", required: false },
    ],
    apply: true,
  });
  assert.equal(applied._ok, true);
  assert.equal(applied._apply, true);
  assert.equal(applied._execution_status, "completed");
  assert.equal(TestXVibeModule.lastDataFeatureParams?._env, "default");
  assert.equal(TestXVibeModule.lastDataFeatureParams?._apply, true);
});

test("MCP data-feature rejects free-text and unsupported schema fields before XVibe", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  let response = await callMCP(handler, {
    body: rpc(1, "tools/call", {
      name: "xpell_create_data_feature",
      arguments: {
        app_id: "mycrm",
        env: "default",
        feature_name: "Customer",
        entity_id: "customer",
        instruction: "Create a Customer CRUD feature",
        fields: [
          { id: "name", type: "String", required: true },
        ],
      },
    }),
    token: "valid-token",
  });
  assert.equal(response.status, 200);
  let parsed = parseMCPResponse(response.text);
  assert.equal(parsed.result.isError, true);
  assert.equal(TestXVibeModule.lastDataFeatureParams, undefined);

  response = await callMCP(handler, {
    body: rpc(2, "tools/call", {
      name: "xpell_create_data_feature",
      arguments: {
        app_id: "mycrm",
        env: "default",
        feature_name: "Customer",
        entity_id: "customer",
        fields: [
          { id: "name", type: "Object", required: true },
        ],
      },
    }),
    token: "valid-token",
  });
  assert.equal(response.status, 200);
  parsed = parseMCPResponse(response.text);
  assert.equal(parsed.result.isError, true);
  assert.equal(TestXVibeModule.lastDataFeatureParams, undefined);
});

test("MCP data-feature preserves XVibe structured duplicate, conflict, and partial results", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const duplicate = await callToolExpectError(handler, "xpell_create_data_feature", {
    app_id: "mycrm",
    env: "default",
    feature_name: "Customer",
    entity_id: "customer",
    fields: [
      { id: "name", type: "String", required: true },
      { id: "name", type: "String", required: false },
    ],
  });
  assert.equal(duplicate._error._code, "E_XVIBE_DATA_FEATURE_DUPLICATE_FIELD_ID");
  assert.equal(duplicate._error._details._reason, "duplicate_field_id");
  assert.equal(duplicate._error._details._field_id, "name");

  const conflict = await callToolExpectError(handler, "xpell_create_data_feature", {
    app_id: "mycrm",
    env: "default",
    feature_name: "Conflict",
    entity_id: "conflict",
    fields: [
      { id: "name", type: "String", required: true },
    ],
    apply: true,
  });
  assert.equal(conflict._error._code, "E_XVIBE_DATA_FEATURE_ARTIFACT_CONFLICT");
  assert.equal(conflict._error._details._reason, "artifact_conflict");
  assert.equal(conflict._error._details._conflicts[0]._artifact_type, "entity");

  const partial = await callTool(handler, "xpell_create_data_feature", {
    app_id: "mycrm",
    env: "default",
    feature_name: "Partial",
    entity_id: "partial",
    fields: [
      { id: "name", type: "String", required: true },
    ],
    apply: true,
  });
  assert.equal(partial._ok, true);
  assert.equal(partial._execution_status, "partial_failed");
  assert.equal(partial._reason, "partial_failed");
  assert.equal(partial._failed_node._id, "table:partial-list");
});

test("MCP data-feature does not duplicate CRUD generation or expose execution graph controls", async () => {
  const source = await readFile(path.resolve("src/MCPToolRegistry.ts"), "utf-8");
  assert.equal(source.includes("\"execute-execution-graph\""), false);
  assert.equal(source.includes("_graph_type"), false);
  assert.equal(source.includes("_execution_graph"), false);
  assert.equal(source.includes("artifact_selection"), false);
  assert.equal(source.includes("create-customer"), false);
});

test("MCP semantic view-edit aligns authorization with deterministic view edits", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });
  const args = {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    apply: false,
    target: {
      label: "Main",
      type: "xsection",
    },
    changes: [
      { semantic_property: "density", value: "compact" },
    ],
  };

  const unauthenticated = await callMCP(handler, {
    body: rpc(1, "tools/call", {
      name: "xpell_apply_semantic_view_edit",
      arguments: args,
    }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.text, /E_XMCP_AUTH_REQUIRED/);

  const planWithoutPermissionClaims = await callMCP(handler, {
    body: rpc(2, "tools/call", {
      name: "xpell_apply_semantic_view_edit",
      arguments: args,
    }),
    token: "admin-token-without-permissions",
  });
  assert.equal(planWithoutPermissionClaims.status, 200);
  const planWithoutPermissionClaimsResponse = parseMCPResponse(planWithoutPermissionClaims.text);
  assert.equal(planWithoutPermissionClaimsResponse.result.isError, undefined);
  assert.equal(planWithoutPermissionClaimsResponse.result.structuredContent._applied, false);

  let view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  assert.equal(findObject(view._result._view, "main-section")?._density, "regular");

  const applyWithoutPermissionClaims = await callMCP(handler, {
    body: rpc(3, "tools/call", {
      name: "xpell_apply_semantic_view_edit",
      arguments: {
        ...args,
        apply: true,
        target: {
          type: "xpage",
        },
        changes: [
          { semantic_property: "width", value: "readable" },
        ],
      },
    }),
    token: "admin-token-without-permissions",
  });
  assert.equal(applyWithoutPermissionClaims.status, 200);
  const applyWithoutPermissionClaimsResponse = parseMCPResponse(applyWithoutPermissionClaims.text);
  assert.equal(applyWithoutPermissionClaimsResponse.result.isError, undefined);
  assert.equal(applyWithoutPermissionClaimsResponse.result.structuredContent._applied, true);

  view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  assert.equal(findObject(view._result._view, "main")?._width, "readable");

  const lowClearance = await callMCP(handler, {
    body: rpc(4, "tools/call", {
      name: "xpell_apply_semantic_view_edit",
      arguments: {
        ...args,
        apply: true,
      },
    }),
    token: "low-token",
  });
  assert.equal(lowClearance.status, 200);
  const lowClearanceResponse = parseMCPResponse(lowClearance.text);
  assert.equal(lowClearanceResponse.result.isError, true);
  assert.equal(lowClearanceResponse.result.structuredContent._error._code, "E_XMCP_ADMIN_REQUIRED");
});

test("MCP semantic view-edit forwards structured plan-only requests to XVibe", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const mainPlan = await callTool(handler, "xpell_apply_semantic_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    target: {
      label: "Main",
      type: "xsection",
    },
    changes: [
      { semantic_property: "density", value: "compact" },
      { semantic_property: "title", value: "Active Records" },
    ],
  });
  assert.equal(mainPlan._ok, true);
  assert.equal(mainPlan._applied, false);
  assert.equal(mainPlan._plan._type, "mutation-plan");
  assert.equal(mainPlan._plan._steps[0]._primitive._op, "apply-view-edit");
  assert.equal(mainPlan._plan._steps[0]._primitive._params._property_name, "_density");
  assert.equal(mainPlan._plan._steps[1]._primitive._params._property_name, "_title");
  assert.deepEqual(TestXVibeModule.lastSemanticParams, {
    _app_id: "1p9",
    _env: "default",
    _view_id: "main",
    _target: {
      _label: "Main",
      _type: "xsection",
    },
    _changes: [
      { _semantic_property: "density", _value: "compact" },
      { _semantic_property: "title", _value: "Active Records" },
    ],
    _apply: false,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(TestXVibeModule.lastSemanticParams ?? {}, "_property_name"), false);
  let view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  assert.equal(findObject(view._result._view, "main-section")?._title, "Main");
  assert.equal(findObject(view._result._view, "main-section")?._density, "regular");

  const pagePlan = await callTool(handler, "xpell_apply_semantic_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    target: {
      type: "xpage",
    },
    changes: [
      { semantic_property: "width", value: "readable" },
    ],
    apply: false,
  });
  assert.equal(pagePlan._plan._steps[0]._primitive._params._target_id, "main");
  assert.equal(pagePlan._plan._steps[0]._primitive._params._property_name, "_width");
  assert.equal(pagePlan._plan._steps[0]._primitive._params._property_value, "readable");

  const galleryStylePlan = await callTool(handler, "xpell_apply_semantic_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    target: {
      id: "xgallery",
      semantic_child: "title",
    },
    changes: [
      { semantic_property: "font-size", value: "20px" },
    ],
  });
  const galleryParams = galleryStylePlan._plan._steps[0]._primitive._params;
  assert.equal(galleryParams._edit_action, "set-style");
  assert.equal(galleryParams._target_id, "xgallery");
  assert.equal(galleryParams._style_object_path, "_item._styles._title._style");
  assert.equal(galleryParams._style_property, "font-size");
  assert.equal(galleryParams._style_value, "20px");
});

test("MCP semantic view-edit apply=true forwards apply mode to XVibe without local execution", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const applied = await callTool(handler, "xpell_apply_semantic_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    apply: true,
    target: {
      label: "Main",
      type: "xsection",
    },
    changes: [
      { semantic_property: "density", value: "compact" },
      { semantic_property: "title", value: "Active Records" },
    ],
  });
  assert.equal(applied._ok, true);
  assert.equal(applied._applied, true);
  assert.equal(applied._apply_result._ok, true);
  assert.equal(TestXVibeModule.lastSemanticParams?._apply, true);
  assert.equal(TestXVibeModule.lastParams, undefined);

  const view = await callTool(handler, "xpell_get_view", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
  });
  assert.equal(findObject(view._result._view, "main-section")?._title, "Active Records");
  assert.equal(findObject(view._result._view, "main-section")?._density, "compact");
});

test("MCP semantic view-edit preserves XVibe semantic failures", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const ambiguous = await callToolExpectError(handler, "xpell_apply_semantic_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    target: {
      label: "Ambiguous",
      type: "label",
    },
    changes: [
      { semantic_property: "title", value: "Records" },
    ],
  });
  assert.equal(ambiguous._error._code, "E_XVIBE_SEMANTIC_VIEW_EDIT_TARGET_AMBIGUOUS");
  assert.equal(ambiguous._error._details._reason, "target_ambiguous");
  assert.equal(ambiguous._error._details._needs_disambiguation, true);
  assert.equal(ambiguous._error._details._candidates.length, 2);

  const invalidOption = await callToolExpectError(handler, "xpell_apply_semantic_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    target: {
      type: "xpage",
    },
    changes: [
      { semantic_property: "width", value: "invalid-option" },
    ],
  });
  assert.equal(invalidOption._error._code, "E_XVIBE_SEMANTIC_VIEW_EDIT_INVALID_OPTION");
  assert.deepEqual(invalidOption._error._details._options, ["full", "readable"]);

  const unsupported = await callToolExpectError(handler, "xpell_apply_semantic_view_edit", {
    app_id: "1p9",
    env: "default",
    view_id: "main",
    target: {
      label: "Main",
      type: "xsection",
    },
    changes: [
      { semantic_property: "unsupported", value: "anything" },
    ],
  });
  assert.equal(unsupported._error._code, "E_XVIBE_SEMANTIC_VIEW_EDIT_SEMANTIC_PROPERTY_UNSUPPORTED");
  assert.equal(unsupported._error._details._semantic_property, "unsupported");
});

test("MCP semantic view-edit rejects free-text instruction input", async () => {
  await resetRuntime();
  const handler = createXpellMCPRequestHandler({
    _settings: {
      enabled: true,
      require_auth: true,
      path: "/mcp",
    },
  });

  const response = await callMCP(handler, {
    body: rpc(1, "tools/call", {
      name: "xpell_apply_semantic_view_edit",
      arguments: {
        app_id: "1p9",
        env: "default",
        view_id: "main",
        instruction: "Make Main compact",
        target: {
          label: "Main",
          type: "xsection",
        },
        changes: [
          { semantic_property: "density", value: "compact" },
        ],
      },
    }),
    token: "valid-token",
  });
  assert.equal(response.status, 200);
  const parsed = parseMCPResponse(response.text);
  assert.equal(parsed.result.isError, true);
  assert.equal(TestXVibeModule.lastSemanticParams, undefined);
});

test("MCP result sanitizer strips secrets, auth headers, stacks, and absolute paths", () => {
  const sanitized = sanitizeResult({
    ok: true,
    token: "eyJaaaaaaaaaaa.bbbbbbbbbbbbb.ccccccccccccc",
    nested: {
      authorization: "Bearer abc.def.ghi",
      message: "Failed at /Users/example/project/file.ts",
      stack: "secret stack",
    },
  });

  assert.equal(sanitized.token, "[redacted]");
  assert.equal((sanitized.nested as any).authorization, "[redacted]");
  assert.equal((sanitized.nested as any).stack, undefined);
  assert.match((sanitized.nested as any).message, /\[redacted-path\]/);
});

test("MCP registry exposes only curated tools", async () => {
  await resetRuntime();
  const names = DefaultMCPToolRegistry.listTools().map((tool) => tool._name);
  assert.deepEqual(names, DEFAULT_TOOL_NAMES);
  assert.equal(names.some((name) => name.includes("execute")), false);
});

async function resetRuntime(options: { capability?: boolean; xvibe?: boolean; dataFeature?: boolean } = {}): Promise<void> {
  (_x as any)._modules = {};
  markXpellMCPRuntimeStarting("test_runtime_reset");
  TestXVibeModule.lastParams = undefined;
  TestXVibeModule.lastSemanticParams = undefined;
  TestXVibeModule.lastDataFeatureParams = undefined;
  TestXVibeModule.runtimeSkillSnapshots.clear();
  await _x.loadModuleAsync(new TestXAuthModule());
  await _x.loadModuleAsync(new MCPModule());
  await _x.loadModuleAsync(new TestServerXVMModule());
  if (options.capability !== false) {
    await _x.loadModuleAsync(new TestCapabilityModule());
  }
  if (options.xvibe !== false) {
    await _x.loadModuleAsync(
      options.dataFeature === false
        ? new TestXVibeModule()
        : new TestXVibeDataFeatureModule(),
    );
  }
  markXpellMCPRuntimeReady("test_runtime_ready");
  assert.equal(getXpellMCPRuntimeReadiness()._ready, true);
}

function rpc(id: number, method: string, params: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };
}

async function callMCP(
  handler: ReturnType<typeof createXpellMCPRequestHandler>,
  input: {
    body: unknown;
    token?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const req = new MockRequest(JSON.stringify(input.body), {
    host: "localhost:3000",
    ...JSON_HEADERS,
    ...(input.headers ?? {}),
    ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
  });
  const res = new MockResponse();

  await handler(req as any, res as any);
  await res.done;

  return {
    status: res.status,
    headers: res.headers,
    text: Buffer.concat(res.chunks).toString("utf-8"),
  };
}

function parseMCPResponse(text: string): any {
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));

  assert.ok(dataLine, "expected SSE data line");
  return JSON.parse(dataLine.slice("data: ".length));
}

function parseStructuredContent(text: string): any {
  return parseMCPResponse(text).result.structuredContent;
}

async function callTool(
  handler: ReturnType<typeof createXpellMCPRequestHandler>,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const response = await callMCP(handler, {
    body: rpc(Date.now(), "tools/call", {
      name,
      arguments: args,
    }),
    token: "valid-token",
  });
  assert.equal(response.status, 200);
  const parsed = parseMCPResponse(response.text);
  assert.equal(parsed.result.isError, undefined);
  return parsed.result.structuredContent;
}

async function callToolExpectError(
  handler: ReturnType<typeof createXpellMCPRequestHandler>,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const response = await callMCP(handler, {
    body: rpc(Date.now(), "tools/call", {
      name,
      arguments: args,
    }),
    token: "valid-token",
  });
  assert.equal(response.status, 200);
  const parsed = parseMCPResponse(response.text);
  assert.equal(parsed.result.isError, true);
  return parsed.result.structuredContent;
}

function xvibeSuccess(action: string, view: Record<string, any>, mutation: Record<string, unknown>) {
  const result = {
    _ok: true,
    _artifact_type: "view",
    _artifact_id: view._id,
    _view_id: view._id,
    _source_view_id: view._id,
    _persisted_view_id: view._id,
    _deterministic: true,
    _edit_action: action,
    _mutation_action: action,
    _mutation: {
      _type: "deterministic-view-edit",
      _action: action,
      ...mutation,
    },
    ...mutation,
  };

  return {
    ...result,
    _result: result,
  };
}

function xvibeFailure(code: string, message: string) {
  return {
    _ok: false,
    _error: {
      _code: code,
      _message: message,
    },
  };
}

function xvibeSemanticFailure(reason: string, message: string, details: Record<string, unknown>) {
  return {
    _ok: false,
    _reason: reason,
    _error: {
      _code: `E_XVIBE_SEMANTIC_VIEW_EDIT_${reason.toUpperCase()}`,
      _message: message,
      _details: {
        _reason: reason,
        ...details,
      },
    },
  };
}

function xvibeDataFeatureFailure(reason: string, message: string, details: Record<string, unknown>) {
  return {
    _ok: false,
    _reason: reason,
    _error: {
      _code: `E_XVIBE_DATA_FEATURE_${reason.toUpperCase()}`,
      _reason: reason,
      _message: message,
      _details: details,
    },
  };
}

function findObject(value: unknown, id: string): Record<string, any> | undefined {
  if (!isRecord(value)) return undefined;
  if (value._id === id) return value as Record<string, any>;
  const children = Array.isArray(value._children) ? value._children : [];
  for (const child of children) {
    const found = findObject(child, id);
    if (found) return found;
  }
  return undefined;
}

function findObjectParent(
  root: Record<string, any>,
  id: string,
): { parent: Record<string, any>; index: number } | undefined {
  const children = Array.isArray(root._children) ? root._children : [];
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];
    if (isRecord(child) && child._id === id) {
      return { parent: root, index };
    }
    if (isRecord(child)) {
      const found = findObjectParent(child as Record<string, any>, id);
      if (found) return found;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

class MockRequest implements AsyncIterable<Buffer> {
  method = "POST";
  url = "/mcp";
  socket = { remoteAddress: "127.0.0.1" };

  constructor(
    private readonly body: string,
    public readonly headers: Record<string, string>,
  ) { }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
    yield Buffer.from(this.body);
  }
}

class MockResponse extends EventEmitter {
  status = 200;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];
  destroyed = false;
  done: Promise<void>;
  private resolveDone!: () => void;

  constructor() {
    super();
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  writeHead(statusCode: number, headers?: Record<string, string>) {
    this.status = statusCode;
    this.headers = headers ?? {};
  }

  write(chunk: string | Uint8Array) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(chunk?: string | Uint8Array) {
    if (chunk) this.write(chunk);
    this.resolveDone();
    this.emit("close");
  }
}

class FakeApp {
  routes: Array<{ _path: string; _handler: unknown }> = [];

  all(path: string, handler: unknown) {
    this.routes.push({ _path: path, _handler: handler });
  }
}
