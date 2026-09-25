"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * SoL-Pi for PI-Desktop — plugin entry point.
 *
 * PI-Desktop's plugin host process sets `globalThis.pi` and then requires this
 * module, so the API arrives as a global and the lifecycle is three exported
 * functions: `onLoad`, `onUnload` and `onPanelInvoke`. Nothing else about the
 * host is assumed here; every call goes through the members listed in
 * `REQUIRED_HOST_MEMBERS` below, which are checked before anything is used, so a
 * missing or renamed host API fails at load with a readable message instead of
 * at the first tool call.
 */

const { TOOL_DESCRIPTORS } = require("./lib/tool-descriptors.js");
const metadata = require("./lib/metadata.js");
const configLib = require("./lib/config.js");
const hostLib = require("./lib/host.js");
const tools = require("./lib/tools.js");

/** Every host member this plugin calls, as `path` + the accessor. */
const REQUIRED_HOST_MEMBERS = [
  ["plugin.getDataPath", (pi) => pi.plugin?.getDataPath],
  ["plugin.getSettings", (pi) => pi.plugin?.getSettings],
  ["plugin.setSettings", (pi) => pi.plugin?.setSettings],
  ["plugin.getManifest", (pi) => pi.plugin?.getManifest],
  ["workspace.get", (pi) => pi.workspace?.get],
  ["agent.registerTool", (pi) => pi.agent?.registerTool],
  ["agent.unregisterTool", (pi) => pi.agent?.unregisterTool],
  ["agent.complete", (pi) => pi.agent?.complete],
  ["models.list", (pi) => pi.models?.list],
  ["session.getLlmContext", (pi) => pi.session?.getLlmContext],
  ["commands.register", (pi) => pi.commands?.register],
  ["commands.unregister", (pi) => pi.commands?.unregister],
  ["ui.openPanel", (pi) => pi.ui?.openPanel],
  ["ui.showToast", (pi) => pi.ui?.showToast],
];

const registeredTools = [];
const registeredCommands = [];

function host() {
  const pi = globalThis.pi;
  if (!pi || typeof pi !== "object") {
    throw new Error(
      "SoL-Pi must run inside PI-Desktop: the plugin host API (globalThis.pi) was not provided.",
    );
  }
  const missing = REQUIRED_HOST_MEMBERS.filter(([, accessor]) => typeof accessor(pi) !== "function").map(
    ([path]) => path,
  );
  if (missing.length) {
    throw new Error(
      `This PI-Desktop version is missing host APIs SoL-Pi needs: ${missing.join(", ")}. ` +
        "SoL-Pi needs an app that provides the plugin host API from 0.15.0 on.",
    );
  }
  return pi;
}

/**
 * Fail the load if the manifest on disk and the metadata module disagree.
 *
 * `manifest.json` is generated from `lib/metadata.js`; this check is what makes
 * a half-finished rename impossible to ship, because the plugin refuses to load
 * instead of registering a tool the manifest never declared.
 */
function assertManifestAgreement(pi) {
  const shipped = pi.plugin.getManifest();
  const expected = metadata.buildManifest();
  const drift = [];

  const compare = (label, left, right) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      drift.push(`${label}: manifest ${JSON.stringify(left)} vs metadata ${JSON.stringify(right)}`);
    }
  };

  compare("id", shipped?.id, expected.id);
  compare("main", shipped?.main ?? "main.js", expected.main);
  compare("version", shipped?.version, expected.version);

  const asSet = (values) => [...new Set((Array.isArray(values) ? values : []).map(String))].sort();
  compare("permissions", asSet(shipped?.permissions), asSet(expected.permissions));

  const names = asSet(TOOL_DESCRIPTORS.map((tool) => tool.name));
  compare(
    "contributes.agentTools",
    asSet((shipped?.contributes?.agentTools ?? []).map((tool) => tool?.name)),
    names,
  );
  compare(
    "contributes.commands",
    asSet((shipped?.contributes?.commands ?? []).map((command) => command?.id)),
    asSet(expected.contributes.commands.map((command) => command.id)),
  );
  compare(
    "contributes.views",
    asSet((shipped?.contributes?.views ?? []).map((view) => `${view?.id}:${view?.entry}`)),
    asSet(expected.contributes.views.map((view) => `${view.id}:${view.entry}`)),
  );
  compare(
    "contributes.skills",
    asSet(shipped?.contributes?.skills),
    asSet(expected.contributes.skills),
  );
  compare(
    "contributes.settings",
    asSet(
      (shipped?.contributes?.settings ?? []).map(
        (setting) => `${setting?.key}:${setting?.type}:${JSON.stringify(setting?.default)}`,
      ),
    ),
    asSet(
      expected.contributes.settings.map(
        (setting) => `${setting.key}:${setting.type}:${JSON.stringify(setting.default)}`,
      ),
    ),
  );

  if (drift.length) {
    throw new Error(
      `SoL-Pi's manifest.json is stale — regenerate it with "node scripts/sync-manifest.mjs".\n${drift.join(
        "\n",
      )}`,
    );
  }
}

async function registerTools(pi) {
  const handlers = tools.createHandlers(pi);
  for (const descriptor of TOOL_DESCRIPTORS) {
    const execute = handlers[descriptor.name];
    if (typeof execute !== "function") {
      throw new Error(`SoL-Pi has no handler for its own tool "${descriptor.name}".`);
    }
    await pi.agent.registerTool({
      name: descriptor.name,
      description: descriptor.description,
      risk: descriptor.risk,
      schema: descriptor.schema,
      planSafeActions: descriptor.planSafeActions,
      execute,
    });
    registeredTools.push(descriptor.name);
  }
}

/** Friendly labels for the preset toasts, in the language the panel uses. */
function mechanismSummary(config) {
  const on = configLib.enabledMechanisms(config);
  return on.length ? on.join(", ") : "none";
}

/** Friendly names for the switches a preset sets, including the free ones. */
const FRIENDLY_SWITCHES = {
  actionFusion: "action fusion",
  observationPack: "observation packing",
  evidencePreservingReducer: "the evidence-preserving reducer",
  onlineContextCompact: "online context compaction",
  turnMeasurement: "per-turn measurement",
};

function presetList(preset) {
  const on = [...configLib.enabledMechanisms(preset)];
  if (preset.turnMeasurement === true) on.push("turnMeasurement");
  return on.map((key) => FRIENDLY_SWITCHES[key] ?? key).join(", ");
}

async function registerCommands(pi) {
  const runs = {
    async "solPi.open"() {
      await pi.ui.openPanel({ title: metadata.NAME });
    },
    async "solPi.enableLocal"() {
      const preset = configLib.localPreset();
      await pi.plugin.setSettings(preset);
      await pi.ui.showToast(
        `SoL-Pi: ${presetList(preset)} on. The reducer and the compaction mechanism stay off.`,
        "info",
      );
    },
    async "solPi.disableAll"() {
      // Built from the preset it applies, so the sentence cannot drift from what
      // the switches actually did.
      const preset = configLib.disabledPreset();
      await pi.plugin.setSettings(preset);
      await pi.ui.showToast(
        `SoL-Pi: ${presetList(preset) || "no mechanism is"} on — nothing is packed and no turn is recorded.`,
        "info",
      );
    },
    async "solPi.compactBrief"() {
      const state = await tools.panelState(pi);
      await pi.ui.openPanel({ title: metadata.NAME });
      await pi.ui.showToast(
        state.brief
          ? `SoL-Pi: showing the last compaction brief (${state.brief.length} chars).`
          : "SoL-Pi: no compaction brief yet — ask the agent to run plugin_local_sol_pi_compact_check.",
        state.brief ? "info" : "warn",
      );
    },
  };

  for (const command of metadata.COMMANDS) {
    const run = runs[command.id];
    if (typeof run !== "function") {
      throw new Error(`SoL-Pi declares the command "${command.id}" but has no implementation for it.`);
    }
    await pi.commands.register({
      id: command.id,
      title: command.title,
      keywords: command.keywords,
      category: command.category,
      run,
    });
    registeredCommands.push(command.id);
  }
}

async function onLoad() {
  const pi = host();
  assertManifestAgreement(pi);
  hostLib.resetCache();
  try {
    await registerTools(pi);
    await registerCommands(pi);
  } catch (error) {
    // Leave nothing half-registered: a plugin that failed to load must not keep
    // a tool the agent can still call.
    await unregisterAll(pi);
    throw error;
  }
}

async function unregisterAll(pi) {
  while (registeredTools.length) {
    const name = registeredTools.pop();
    try {
      await pi.agent.unregisterTool(name);
    } catch {
      /* the host is going away; nothing useful left to do about one tool */
    }
  }
  while (registeredCommands.length) {
    const id = registeredCommands.pop();
    try {
      await pi.commands.unregister(id);
    } catch {
      /* same */
    }
  }
}

async function onUnload() {
  const pi = globalThis.pi;
  if (pi && typeof pi === "object") await unregisterAll(pi);
}

/** Panel and view channel handler: `window.pluginBridge.invoke(channel, payload)`. */
async function onPanelInvoke(channel, payload) {
  const pi = host();
  return await tools.onPanelInvoke(pi, String(channel ?? ""), payload ?? {});
}

module.exports = {
  onLoad,
  onUnload,
  onPanelInvoke,
  // Exported for the offline gate, which exercises these without a host.
  assertManifestAgreement,
  mechanismSummary,
  REQUIRED_HOST_MEMBERS,
};
