"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * The parts of the plugin surface PI-Desktop reads before any tool is called:
 * the generated manifest, the permission set, the settings the user sees, and the
 * files the manifest promises. Everything here must stay true without a host.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");

const metadata = require("../lib/metadata.js");

const root = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const LEGAL_SETTING_TYPES = ["string", "number", "boolean", "select", "json", "shortcut"];

test("manifest.json is exactly what lib/metadata.js generates", () => {
  assert.deepEqual(manifest, metadata.buildManifest());
});

test("identity, entry points and provenance", () => {
  assert.equal(manifest.id, "local.sol-pi");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description && manifest.description.length > 40, "a real description is required");
  assert.equal(manifest.ui.panel, "views/index.html");
  assert.equal(manifest.main, "main.js");
  assert.equal(metadata.UPSTREAM, "https://github.com/NVlabs/SoL-Pi");
});

test("the permission set is pinned, and it is the narrow one", () => {
  assert.deepEqual(
    [...manifest.permissions].sort(),
    [
      "agent.complete",
      "agent.prompt.inject",
      "agent.tool.register",
      "clipboard.write",
      "models.list",
      "session.read",
      "ui.panel",
      "ui.view",
    ],
    "a new permission must be a deliberate decision, not drift",
  );
  assert.equal(
    manifest.permissions.includes("notify"),
    false,
    "notify is not needed: the host gates notifications, not ui.showToast, on it",
  );
  for (const forbidden of ["net.fetch", "fs.read", "fs.write", "fs.delete", "desktop.control", "browser.cdp"]) {
    assert.equal(manifest.permissions.includes(forbidden), false, `${forbidden} must not be requested`);
  }
});

test("all four mechanisms are exposed, off by default, under the upstream keys", () => {
  const settings = new Map(manifest.contributes.settings.map((setting) => [setting.key, setting]));
  for (const key of ["actionFusion", "observationPack", "evidencePreservingReducer", "onlineContextCompact"]) {
    const setting = settings.get(key);
    assert.ok(setting, `${key} must be a setting the user can turn on`);
    assert.equal(setting.type, "boolean");
    assert.equal(setting.default, false, `${key} must ship off`);
    assert.ok(setting.title.trim().length > 10, `${key} needs a title that says what it does`);
  }
  assert.equal(settings.get("cacheWriteReadRatio").default, 12.5);
  assert.equal(settings.get("keepRecentTokens").default, 20000);
  assert.equal(settings.get("evidencePreservingReducerProvider").default, "openai-codex");
  assert.equal(settings.get("evidencePreservingReducerModel").default, "gpt-5.6-luna");
});

test("every setting is host-legal", () => {
  for (const setting of manifest.contributes.settings) {
    assert.match(setting.key, /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/, `key ${setting.key}`);
    assert.ok(LEGAL_SETTING_TYPES.includes(setting.type), `type ${setting.type} for ${setting.key}`);
    assert.ok(setting.title && setting.title.trim(), `${setting.key} needs a title`);
  }
});

test("the view and the panel are declared and self-contained", () => {
  assert.equal(manifest.contributes.views.length, 1);
  const view = manifest.contributes.views[0];
  assert.match(view.id, /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
  assert.ok(view.title, "a view needs a title");
  for (const relative of [manifest.ui.panel, view.entry]) {
    assert.ok(existsSync(join(root, relative)), `${relative} is declared but missing`);
  }

  const html = readFileSync(join(root, manifest.ui.panel), "utf8");
  assert.equal(/https?:\/\//.test(html), false, "the panel must not need the network");
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, "the panel must not use an inline script");
  assert.equal(/\son[a-z]+\s*=/i.test(html), false, "the panel must not use an inline event handler");
});

test("every declared skill exists, has frontmatter and a usable description", () => {
  assert.ok(manifest.contributes.skills.length >= 1);
  for (const relative of manifest.contributes.skills) {
    const path = join(root, relative);
    assert.ok(existsSync(path), `${relative} is declared but missing`);
    const raw = readFileSync(path, "utf8");
    assert.ok(raw.length < 128 * 1024, `${relative} exceeds the host's 128 KiB skill limit`);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    assert.ok(frontmatter, `${relative} needs frontmatter`);
    const name = /^name:\s*(.+)$/m.exec(frontmatter[1])?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(frontmatter[1])?.[1]?.trim();
    assert.ok(name, `${relative} needs a name`);
    assert.ok(description && description.length <= 240, `${relative} needs a description under 240 chars`);
    assert.ok(raw.length > frontmatter[0].length + 200, `${relative} needs a real body`);
  }
});

test("the six tools and four commands are exactly the declared ones", () => {
  assert.deepEqual(
    manifest.contributes.agentTools.map((tool) => tool.name),
    ["fused_edit", "obs_pack", "obs_recall", "reduce_evidence", "plan_update", "compact_check"],
  );
  assert.deepEqual(
    manifest.contributes.commands.map((command) => command.id),
    ["solPi.open", "solPi.enableLocal", "solPi.disableAll", "solPi.compactBrief"],
  );
});
