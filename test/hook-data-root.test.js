"use strict";
// SPDX-License-Identifier: MIT
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const hooks = require("../hooks/agent-hooks.js");
const paths = require("../lib/paths.js");

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "sol-pi-hook-root-"));
  try { await run(root); } finally { await rm(root, {recursive:true, force:true}); }
}

test("a fresh plugin never mistakes the host's existing sessions for plugin data", async () => {
  await fixture(async root => {
    await mkdir(join(root, "sessions")); // Normal host layout; plugin not used yet.
    const expected = join(root, "plugins", "data", "local.sol-pi");
    const env = {PI_DESKTOP_DATA_DIR:root};
    const cache = {};
    assert.equal(await hooks.resolveDataDir(env, cache), expected);
    assert.equal(cache.dataDir, expected);
    await mkdir(join(expected, "sessions"), {recursive:true});
    assert.equal(await hooks.resolveDataDir(env, cache), expected);
    assert.deepEqual(paths.dataDirCandidates(env), [expected]);
  });
});

test("hook settings come from the same directory as tools, never host settings", async () => {
  await fixture(async root => {
    await mkdir(join(root, "sessions"));
    await writeFile(join(root, "settings.json"), JSON.stringify({observationPack:true}));
    const expected = join(root, "plugins", "data", "local.sol-pi");
    await mkdir(expected, {recursive:true});
    await writeFile(join(expected, "settings.json"), JSON.stringify({observationPack:false,turnMeasurement:false}));
    const actual = await hooks.resolveDataDir({PI_DESKTOP_DATA_DIR:root}, {});
    const settings = await hooks.readConfig(actual);
    assert.equal(settings.ok, true);
    assert.equal(settings.config.observationPack, false);
    assert.equal(settings.config.turnMeasurement, false);
  });
});

test("missing host data root is refused instead of guessing a user directory", async () => {
  assert.deepEqual(paths.dataDirCandidates({}), []);
  await assert.rejects(hooks.resolveDataDir({}, {}), {code:"NO_DATA_DIR"});
});
