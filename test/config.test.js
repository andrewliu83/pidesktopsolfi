"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const config = require("../lib/config.js");

const ALL_OFF = {
  actionFusion: false,
  observationPack: false,
  evidencePreservingReducer: false,
  onlineContextCompact: false,
};

test("every mechanism is off in the shipped defaults", () => {
  const defaults = config.defaultConfig();
  for (const [key, value] of Object.entries(ALL_OFF)) {
    assert.equal(defaults[key], value, `${key} must default to off`);
  }
  assert.equal(defaults.cacheWriteReadRatio, 12.5);
  assert.equal(defaults.keepRecentTokens, 20000);
  assert.equal(defaults.evidencePreservingReducerProvider, "openai-codex");
  assert.equal(defaults.evidencePreservingReducerModel, "gpt-5.6-luna");
});

test("resolveConfig accepts nothing, an empty object and the upstream key names", () => {
  for (const stored of [undefined, null, {}]) {
    const resolved = config.resolveConfig(stored);
    assert.equal(resolved.ok, true);
    assert.deepEqual(config.enabledMechanisms(resolved.config), []);
  }
  const on = config.resolveConfig({ actionFusion: true, observationPack: true });
  assert.equal(on.ok, true);
  assert.deepEqual(config.enabledMechanisms(on.config).sort(), ["actionFusion", "observationPack"]);
});

test("an unknown settings key is ignored rather than fatal", () => {
  const resolved = config.resolveConfig({ actionFusion: true, somethingElse: 42 });
  assert.equal(resolved.ok, true);
  assert.equal(Object.prototype.hasOwnProperty.call(resolved.config, "somethingElse"), false);
});

test("resolveConfig names the offending setting instead of guessing at it", () => {
  const cases = [
    [{ actionFusion: "yes" }, /"actionFusion" must be a boolean/],
    [{ observationPack: 1 }, /"observationPack" must be a boolean/],
    [{ evidencePreservingReducerProvider: "   " }, /must be a non-empty string/],
    [{ evidencePreservingReducerModel: 7 }, /must be a non-empty string/],
    [{ cacheWriteReadRatio: -1 }, /finite non-negative number/],
    [{ cacheWriteReadRatio: "1" }, /finite non-negative number/],
    [{ keepRecentTokens: 0 }, /positive integer/],
    [{ keepRecentTokens: 12.5 }, /positive integer/],
    ["not-an-object", /not a JSON object/],
  ];
  for (const [stored, pattern] of cases) {
    const resolved = config.resolveConfig(stored);
    assert.equal(resolved.ok, false, `${JSON.stringify(stored)} must be rejected`);
    assert.match(resolved.error, pattern);
  }
});

test("requireMechanism refuses with the documented code and names the setting", () => {
  const off = config.defaultConfig();
  for (const key of config.FEATURE_KEYS) {
    assert.throws(
      () => config.requireMechanism(off, key),
      (error) =>
        error.code === "MECHANISM_DISABLED" &&
        error.mechanism === key &&
        error.message.includes(key),
      `${key} must refuse while it is off`,
    );
  }
  const on = config.resolveConfig({ actionFusion: true }).config;
  assert.equal(config.requireMechanism(on, "actionFusion"), on);
});

test("presets: the local one never turns on the mechanism that spends quota", () => {
  assert.deepEqual(config.disabledPreset(), ALL_OFF);
  assert.deepEqual(config.localPreset(), { ...ALL_OFF, actionFusion: true, observationPack: true });
});
