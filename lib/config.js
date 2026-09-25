"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * SoL-Pi configuration for PI-Desktop.
 *
 * Upstream reads `sol-pi.json` from the project or the agent directory. The host
 * owns plugin storage here, so the same keys live in the plugin's settings and
 * the same defaults apply, with one deliberate divergence from upstream. The two
 * switches that can only remove text the model has already seen (packing) or only
 * record what a turn cost (measurement) ship on; the two that can spend quota or
 * put new text in front of the model ship off. A bad value still fails loudly
 * (the load succeeds, the mechanism reports the refusal) instead of silently
 * falling back to a plausible default.
 */

const { SETTINGS } = require("./metadata.js");

const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;
const DEFAULT_KEEP_RECENT_TOKENS = 20000;
// Upstream builds this as ["openai", "codex"].join("-"); PI-Desktop maps the
// "openai-codex" alias onto its Codex/Responses wire API, so the upstream default
// is also a real PI-Desktop provider id.
const DEFAULT_REDUCER_PROVIDER = "openai-codex";
const DEFAULT_REDUCER_MODEL = "gpt-5.6-luna";

const FEATURE_KEYS = [
  "actionFusion",
  "observationPack",
  "evidencePreservingReducer",
  "onlineContextCompact",
];

/**
 * Boolean settings: the four mechanisms plus the per-turn measurement, which is
 * not a mechanism - it never touches the conversation - but is stored, validated
 * and shown through exactly the same path.
 */
const BOOLEAN_KEYS = [...FEATURE_KEYS, "turnMeasurement"];
const STRING_KEYS = ["evidencePreservingReducerProvider", "evidencePreservingReducerModel"];
const NUMBER_KEYS = ["cacheWriteReadRatio", "keepRecentTokens"];

function declaredDefaults() {
  const defaults = {};
  for (const setting of SETTINGS) defaults[setting.key] = setting.default;
  return defaults;
}

/** The config the plugin uses when nothing was ever stored. */
function defaultConfig() {
  return Object.freeze({
    ...declaredDefaults(),
    cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    evidencePreservingReducerProvider: DEFAULT_REDUCER_PROVIDER,
    evidencePreservingReducerModel: DEFAULT_REDUCER_MODEL,
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one stored settings object into a usable config.
 *
 * Returns `{ ok: true, config }` or `{ ok: false, error }`. Feature flags that
 * are simply absent take their declared default; a flag that is present but not
 * a boolean is an error, because guessing there would silently enable a
 * mechanism the user never asked for.
 */
function resolveConfig(stored) {
  const base = defaultConfig();
  if (stored === undefined || stored === null) return { ok: true, config: base };
  if (!isRecord(stored)) {
    return { ok: false, error: "SoL-Pi settings are not a JSON object; no mechanism was changed." };
  }

  const config = { ...base };
  for (const key of BOOLEAN_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
    if (typeof stored[key] !== "boolean") {
      return { ok: false, error: `SoL-Pi setting "${key}" must be a boolean.` };
    }
    config[key] = stored[key];
  }
  for (const key of STRING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
    const value = stored[key];
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, error: `SoL-Pi setting "${key}" must be a non-empty string.` };
    }
    config[key] = value.trim();
  }
  for (const key of NUMBER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(stored, key)) continue;
    const value = stored[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { ok: false, error: `SoL-Pi setting "${key}" must be a finite non-negative number.` };
    }
    config[key] = value;
  }
  if (!Number.isSafeInteger(config.keepRecentTokens) || config.keepRecentTokens < 1) {
    return { ok: false, error: "SoL-Pi keepRecentTokens must be a positive integer." };
  }
  return { ok: true, config: Object.freeze(config) };
}

/** Read the plugin's settings through the host and resolve them. */
async function readConfig(host) {
  const stored = await host.plugin.getSettings();
  return resolveConfig(stored);
}

/**
 * The config for one tool call, or a thrown refusal that names the setting to
 * change. `mechanism` is the upstream feature key.
 */
function requireMechanism(config, mechanism) {
  if (!config || config[mechanism] !== true) {
    const label = SETTINGS.find((setting) => setting.key === mechanism)?.title ?? mechanism;
    throw Object.assign(
      new Error(
        `${mechanism} is disabled. Turn on "${label}" in the SoL-Pi panel (or the plugin's settings) before using this tool.`,
      ),
      { code: "MECHANISM_DISABLED", mechanism },
    );
  }
  return config;
}

/** The conservative starting point upstream documents: the two local mechanisms only. */
function localPreset() {
  return {
    actionFusion: true,
    observationPack: true,
    evidencePreservingReducer: false,
    onlineContextCompact: false,
    turnMeasurement: true,
  };
}

function disabledPreset() {
  return {
    actionFusion: false,
    observationPack: false,
    evidencePreservingReducer: false,
    onlineContextCompact: false,
    turnMeasurement: false,
  };
}

/** Names of the mechanisms that are currently on, for the panel and tool output. */
function enabledMechanisms(config) {
  return FEATURE_KEYS.filter((key) => config?.[key] === true);
}

module.exports = {
  FEATURE_KEYS,
  STRING_KEYS,
  NUMBER_KEYS,
  DEFAULT_CACHE_WRITE_READ_RATIO,
  DEFAULT_KEEP_RECENT_TOKENS,
  DEFAULT_REDUCER_PROVIDER,
  DEFAULT_REDUCER_MODEL,
  defaultConfig,
  resolveConfig,
  readConfig,
  requireMechanism,
  localPreset,
  disabledPreset,
  enabledMechanisms,
  BOOLEAN_KEYS,
};