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

// The two switches that ship on can only act on text the model has already been
// shown: packing removes a replay, measurement records a cost. They inject nothing
// and spend nothing, which is exactly why they are the ones enabled by default.
const SHIPPED_ON = ["observationPack"];

test("exactly the switches that cost nothing are on in the shipped defaults", () => {
  const defaults = config.defaultConfig();
  for (const key of config.FEATURE_KEYS) {
    assert.equal(defaults[key], SHIPPED_ON.includes(key), `${key} does not match the shipped posture`);
  }
  assert.equal(defaults.turnMeasurement, true, "the per-turn measurement ships on");
  assert.equal(defaults.actionFusion, false, "the write-and-run tool stays opt-in");
  assert.equal(defaults.evidencePreservingReducer, false, "the mechanism that spends quota stays off");
  assert.equal(defaults.onlineContextCompact, false, "the mechanism that injects a plan stays off");
  assert.equal(defaults.cacheWriteReadRatio, 12.5);
  assert.equal(defaults.keepRecentTokens, 20000);
  assert.equal(defaults.evidencePreservingReducerProvider, "openai-codex");
  assert.equal(defaults.evidencePreservingReducerModel, "gpt-5.6-luna");
});

test("resolveConfig accepts nothing, an empty object and the upstream key names", () => {
  for (const stored of [undefined, null, {}]) {
    const resolved = config.resolveConfig(stored);
    assert.equal(resolved.ok, true);
    // Nothing stored means the shipped posture, not "everything off": packing is
    // the one mechanism that is on until the user says otherwise.
    assert.deepEqual(config.enabledMechanisms(resolved.config), ["observationPack"]);
    assert.equal(resolved.config.turnMeasurement, true);
  }
  const off = config.resolveConfig({ observationPack: false });
  assert.equal(off.ok, true);
  assert.deepEqual(config.enabledMechanisms(off.config), []);
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
  for (const key of config.FEATURE_KEYS.filter((name) => config.defaultConfig()[name] !== true)) {
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
  assert.deepEqual(config.disabledPreset(), { ...ALL_OFF, turnMeasurement: false });
  assert.deepEqual(config.localPreset(), {
    ...ALL_OFF,
    actionFusion: true,
    observationPack: true,
    turnMeasurement: true,
  });
  assert.equal(config.localPreset().evidencePreservingReducer, false);
  assert.equal(config.localPreset().onlineContextCompact, false);
});

test("the per-turn measurement is a setting, not a mechanism", () => {
  assert.equal(config.FEATURE_KEYS.includes("turnMeasurement"), false, "a measurement is not a mechanism");
  assert.ok(config.BOOLEAN_KEYS.includes("turnMeasurement"), "it is still validated as a boolean");
  assert.equal(config.resolveConfig({ turnMeasurement: "on" }).ok, false, "a non-boolean must be refused");
  const off = config.resolveConfig({ observationPack: false, turnMeasurement: false }).config;
  assert.equal(off.turnMeasurement, false);
  assert.deepEqual(config.enabledMechanisms(off), []);
});
