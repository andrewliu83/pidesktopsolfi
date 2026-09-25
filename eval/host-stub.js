"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * A strict stand-in for the PI-Desktop plugin host API used by the offline gate.
 *
 * It models the real contract rather than a convenient one:
 *
 *   - every namespace is a Proxy that THROWS on a member the host does not
 *     document, so an invented API name (`pi.agent.run`, `pi.fs.writeText` from a
 *     plugin that never declared `fs.write`) fails the gate instead of silently
 *     working here and breaking in the app;
 *   - `session.getLlmContext` refuses outside a tool call, exactly as the host
 *     does ("session context is only available during tool execution"), and the
 *     projection caps each tool result the way `PLUGIN_TOOL_RESULT_MAX_CHARS` does;
 *   - `agent.complete` enforces the host's own guard rails: `provider/model` keys,
 *     32 KiB of system prompt, 200,000 message characters, and at most 8 calls per
 *     60 seconds;
 *   - `agent.registerTool` re-checks the descriptor rules the host checks
 *     (name pattern, non-empty description, `planSafeActions` inside the action
 *     enum) and refuses plugin tools in plan mode unless the action is listed —
 *     and it drops `planSafeActions` the way the real 0.15.x bridge does.
 */

const { mkdirSync, readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

const TOOL_RESULT_MAX_CHARS = 8000;
const COMPLETE_SYSTEM_MAX_CHARS = 32 * 1024;
const COMPLETE_MESSAGE_MAX_CHARS = 200000;
const COMPLETES_PER_WINDOW = 8;
const COMPLETE_WINDOW_MS = 60000;

function denyNamespace(name, table) {
  return new Proxy(table, {
    get(target, key) {
      if (typeof key === "symbol") return target[key];
      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        throw new Error(
          `host API not documented: pi.${name}.${String(key)} — PI-Desktop 0.15.x has no such call`,
        );
      }
      return target[key];
    },
    has(target, key) {
      return Object.prototype.hasOwnProperty.call(target, key);
    },
  });
}

function actionEnumOf(schema) {
  const action = schema?.properties?.action;
  return Array.isArray(action?.enum) ? action.enum : null;
}

/**
 * Build one host instance.
 *
 * `options.projectRoot` is the directory the fused-edit tool is allowed to write
 * in; `options.manifest` is what `pi.plugin.getManifest()` returns; `options.dataPath`
 * is the plugin data directory.
 */
function createHostStub(options = {}) {
  const dataPath = options.dataPath;
  const projectRoot = options.projectRoot;
  const manifest = options.manifest ?? {};
  const installedAt = options.installedAt ?? new Date().toISOString();

  if (!dataPath || !projectRoot) {
    throw new Error("createHostStub needs both dataPath and projectRoot");
  }
  mkdirSync(dataPath, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  const state = {
    settings: { ...(options.settings ?? {}) },
    tools: new Map(),
    commands: new Map(),
    toasts: [],
    panels: [],
    notices: [],
    clipboard: [],
    calls: [],
    completeCalls: [],
    completeWindow: { start: 0, count: 0 },
    inFlight: null,
    complete: options.complete ?? null,
    sessionContext: options.sessionContext ?? { messages: [], truncated: false, modelKey: null },
    models: options.models ?? [
      { key: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", contextWindow: 200000 },
      { key: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4", contextWindow: 200000 },
    ],
  };

  const record = (api, args) => {
    state.calls.push({ api, args, at: Date.now() });
  };

  const plugin = denyNamespace("plugin", {
    getId: () => manifest.id ?? "local.sol-pi",
    getManifest: () => manifest,
    getSettings: async () => {
      record("plugin.getSettings");
      return structuredClone(state.settings);
    },
    setSettings: async (partial) => {
      record("plugin.setSettings", partial);
      state.settings = { ...state.settings, ...(partial ?? {}) };
      writeFileSync(join(dataPath, "settings.json"), JSON.stringify(state.settings, null, 2));
    },
    getDataPath: async () => {
      record("plugin.getDataPath");
      return dataPath;
    },
  });

  const workspace = denyNamespace("workspace", {
    get: async () => {
      record("workspace.get");
      if (state.workspaceInfo !== undefined) return state.workspaceInfo;
      return {
        path: projectRoot,
        name: projectRoot.split("/").filter(Boolean).at(-1),
        projectId: "stub-project",
        roots: [{ path: projectRoot, kind: "primary" }],
      };
    },
  });

  const agent = denyNamespace("agent", {
    registerTool: async (tool) => {
      record("agent.registerTool", { name: tool?.name });
      const name = String(tool?.name ?? "");
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
        throw new Error(`INVALID_ARGUMENT: tool name ${JSON.stringify(name)} is not host-legal`);
      }
      if (typeof tool?.description !== "string" || !tool.description.trim()) {
        throw new Error(`INVALID_ARGUMENT: tool ${name} needs a description`);
      }
      if (typeof tool?.execute !== "function") {
        throw new Error(`INVALID_ARGUMENT: tool ${name} needs an execute function`);
      }
      if (!tool?.schema || typeof tool.schema !== "object") {
        throw new Error(`INVALID_ARGUMENT: tool ${name} needs an object schema`);
      }
      const enumValues = actionEnumOf(tool.schema);
      for (const action of Array.isArray(tool.planSafeActions) ? tool.planSafeActions : []) {
        if (enumValues && !enumValues.includes(action)) {
          throw new Error(`INVALID_ARGUMENT: tool ${name} plan-safe action ${action} is not in the enum`);
        }
      }
      if (state.tools.has(name)) throw new Error(`INVALID_ARGUMENT: duplicate tool ${name}`);
      // The 0.15.x child bridge forwards name/description/risk/schema only, so
      // planSafeActions never reaches the host. Recorded here so the gate can
      // prove the plugin does not depend on it.
      state.tools.set(name, {
        name,
        description: tool.description,
        risk: tool.risk,
        schema: tool.schema,
        planSafeActions: [],
        execute: tool.execute,
      });
    },
    unregisterTool: async (name) => {
      record("agent.unregisterTool", { name });
      state.tools.delete(String(name));
    },
    complete: async (input) => {
      record("agent.complete", { modelKey: input?.modelKey });
      const modelKey = String(input?.modelKey ?? "");
      if (!modelKey.includes("/")) {
        throw new Error("INVALID_ARGUMENT: modelKey must be providerId/modelId");
      }
      const system = typeof input?.system === "string" ? input.system : "";
      if (system.length > COMPLETE_SYSTEM_MAX_CHARS) {
        throw new Error("INVALID_ARGUMENT: system prompt exceeds 32 KiB");
      }
      const messages = Array.isArray(input?.messages) ? input.messages : [];
      const chars = messages.reduce(
        (sum, message) => sum + String(message?.content ?? "").length,
        0,
      );
      if (chars > COMPLETE_MESSAGE_MAX_CHARS) {
        throw new Error("INVALID_ARGUMENT: completion input exceeds 200000 characters");
      }
      const now = Date.now();
      if (now - state.completeWindow.start >= COMPLETE_WINDOW_MS) {
        state.completeWindow = { start: now, count: 0 };
      }
      state.completeWindow.count += 1;
      if (state.completeWindow.count > COMPLETES_PER_WINDOW) {
        throw new Error("RATE_LIMITED: too many completions in this window");
      }
      if (typeof state.complete !== "function") {
        throw new Error("UNSUPPORTED: the offline gate did not configure a completion");
      }
      state.completeCalls.push(input);
      return await state.complete(input);
    },
  });

  const models = denyNamespace("models", {
    list: async () => {
      record("models.list");
      return structuredClone(state.models);
    },
  });

  const session = denyNamespace("session", {
    /**
     * The one session lookup this plugin makes: which project folder a session
     * belongs to. `state.sessionRecord` overrides it - `null` means the session
     * records no project path, an `Error` means the lookup itself failed.
     */
    get: async (input) => {
      record("session.get", { id: input?.id });
      if (state.sessionRecord instanceof Error) throw state.sessionRecord;
      const id = typeof input?.id === "string" ? input.id.trim() : "";
      // A lookup without an id cannot name a session, so it cannot name that
      // session's project either - the host answers "no such session", not the
      // current folder. A plugin that forgets the id therefore fails here instead
      // of quietly resolving to whatever project happens to be open.
      if (!id) return { session: null };
      if (state.sessionRecord === null) return { session: { id, projectPath: null } };
      if (state.sessionRecord !== undefined) return state.sessionRecord;
      return { session: { id, projectPath: projectRoot, title: "stub session" } };
    },
    getLlmContext: async () => {
      record("session.getLlmContext");
      if (!state.inFlight) {
        throw new Error("INVALID_ARGUMENT: session context is only available during tool execution");
      }
      const projected = (state.sessionContext.messages ?? []).map((message) => {
        const content = String(message?.content ?? "");
        const capped =
          message?.role === "tool" && content.length > TOOL_RESULT_MAX_CHARS
            ? `${content.slice(0, TOOL_RESULT_MAX_CHARS)}…`
            : content;
        return {
          role: message?.role ?? "user",
          content: capped,
          ...(message?.toolName ? { toolName: message.toolName } : {}),
        };
      });
      return { messages: projected, truncated: state.sessionContext.truncated === true };
    },
  });

  const commands = denyNamespace("commands", {
    register: async (command) => {
      record("commands.register", { id: command?.id });
      if (!command?.id || typeof command.run !== "function") {
        throw new Error("INVALID_ARGUMENT: command needs an id and a run function");
      }
      if (state.commands.has(command.id)) throw new Error(`INVALID_ARGUMENT: duplicate command ${command.id}`);
      state.commands.set(command.id, command);
    },
    unregister: async (id) => {
      record("commands.unregister", { id });
      state.commands.delete(String(id));
    },
  });

  const ui = denyNamespace("ui", {
    openPanel: async (options) => {
      record("ui.openPanel", options);
      state.panels.push(options ?? {});
    },
    closePanel: async () => {
      record("ui.closePanel");
    },
    showToast: async (message, level) => {
      record("ui.showToast", { message, level });
      state.toasts.push({ message: String(message ?? ""), level: level ?? null });
    },
    notify: async (input) => {
      record("ui.notify", input);
      state.notices.push(input ?? {});
    },
    getNotificationPermission: async () => "granted",
    showNativeNotification: async (input) => {
      state.notices.push(input ?? {});
    },
  });

  const clipboard = denyNamespace("clipboard", {
    writeText: async (text) => {
      record("clipboard.writeText");
      state.clipboard.push(String(text ?? ""));
    },
    readText: async () => {
      throw new Error("PERMISSION_DENIED: SoL-Pi never declared clipboard.read");
    },
  });

  const pi = new Proxy(
    {
      plugin,
      workspace,
      agent,
      models,
      session,
      commands,
      ui,
      clipboard,
      app: denyNamespace("app", {
        getVersion: async () => "0.15.7",
        getLocale: async () => "en",
        getAppearance: async () => ({ theme: "dark" }),
      }),
      events: denyNamespace("events", {
        on: () => undefined,
        off: () => undefined,
      }),
      pluginMeta: { installedAt },
    },
    {
      get(target, key) {
        if (typeof key === "symbol") return target[key];
        if (!Object.prototype.hasOwnProperty.call(target, key)) {
          throw new Error(
            `host API not documented: pi.${String(key)} — SoL-Pi must not touch it`,
          );
        }
        return target[key];
      },
    },
  );

  /** Run one registered tool the way the host does: as an in-flight invocation. */
  async function invokeTool(name, args, ctx = {}) {
    const tool = state.tools.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    const invocation = {
      sessionId: ctx.sessionId ?? "stub-session",
      turnId: ctx.turnId ?? "stub-turn",
      mode: ctx.mode ?? "normal",
      modelKey: ctx.modelKey ?? "openai/gpt-5.6-luna",
      signal: ctx.signal ?? new AbortController().signal,
    };
    if (invocation.mode === "plan" || invocation.mode === "goal") {
      const allowed = tool.planSafeActions;
      const action = args && typeof args === "object" ? args.action : undefined;
      if (!allowed.length || !allowed.includes(action)) {
        throw new Error(
          `PERMISSION_DENIED: plugin tool ${name} action ${JSON.stringify(action)} is not allowed in ${invocation.mode} mode`,
        );
      }
    }
    state.inFlight = { sessionId: invocation.sessionId, toolName: name };
    try {
      return await tool.execute(args, invocation);
    } finally {
      state.inFlight = null;
    }
  }

  /** Run one registered command the way the host does (no tool in flight). */
  async function invokeCommand(id) {
    const command = state.commands.get(id);
    if (!command) throw new Error(`command not registered: ${id}`);
    return await command.run();
  }

  return { pi, state, invokeTool, invokeCommand, dataPath, projectRoot, manifest };
}

/** The manifest the host would load from a plugin directory. */
function readManifest(pluginRoot) {
  const path = join(pluginRoot, "manifest.json");
  if (!existsSync(path)) throw new Error(`manifest.json is missing from ${pluginRoot}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

module.exports = { createHostStub, readManifest };
