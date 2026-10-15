"use strict";
// SPDX-License-Identifier: MIT
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fusion = require("../lib/action-fusion.js");

async function inFixture(run) {
  const root = mkdtempSync(join(tmpdir(), "sol-pi command "));
  try { await run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
async function waitFor(predicate, label) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    await delay(25);
  }
}

test("a quoted executable and script path preserve arguments and a nonzero exit", async () => {
  await inFixture(async root => {
    const script = join(root, "script with spaces.cjs");
    writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.stderr.write("diagnostic"); process.exitCode = 7;');
    const result = await fusion.runCommand(`"${process.execPath}" "${script}" "two words" "a&b"`, { cwd: root });
    assert.equal(result.code, 7, JSON.stringify(result));
    assert.deepEqual(JSON.parse(result.stdout), ["two words", "a&b"]);
    assert.equal(result.stderr, "diagnostic");
  });
});

test("a shell spawn failure retains its diagnostic", async () => {
  await inFixture(async root => {
    const result = await fusion.runCommand("echo should-not-run", { cwd: join(root, "missing") });
    assert.equal(result.code, null);
    assert.match(result.spawnError, /ENOENT/);
  });
});

test("an already-aborted call never starts its command", async () => {
  await inFixture(async root => {
    const controller = new AbortController();
    controller.abort();
    const result = await fusion.runCommand('node -e "process.stdout.write(\'must not run\')"', { cwd: root, signal: controller.signal });
    assert.equal(result.stdout, "");
    assert.match(result.spawnError, /aborted before start/);
    assert.equal(result.code, null);
  });
});

for (const mode of ["abort", "timeout"]) {
  test(`${mode} stops descendants as well as the shell`, { timeout: 12000 }, async () => {
    await inFixture(async root => {
      const heartbeat = join(root, "heartbeat.txt");
      const ready = join(root, "ready");
      const worker = join(root, "worker.cjs");
      const parent = join(root, "parent.cjs");
      writeFileSync(worker, `const fs = require('node:fs'); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 30);`);
      writeFileSync(parent, `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, [${JSON.stringify(worker)}], {stdio:'inherit'}); require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(child.pid)); setInterval(() => {}, 100);`);
      const controller = new AbortController();
      const started = Date.now();
      const running = fusion.runCommand(`"${process.execPath}" "${parent}"`, {
        cwd: root, signal: controller.signal, timeoutSeconds: mode === "timeout" ? 2 : 8,
      });
      try {
        await waitFor(() => existsSync(ready) && existsSync(heartbeat), "grandchild heartbeat");
        if (mode === "abort") controller.abort();
        const result = await running;
        assert.ok(result.code !== 0 || result.signal, JSON.stringify(result));
        assert.equal(result.timedOut, mode === "timeout");
        assert.ok(Date.now() - started < 6000, "inherited output pipes must close promptly");
        await delay(150);
        const stopped = readFileSync(heartbeat, "utf8");
        await delay(200);
        assert.equal(readFileSync(heartbeat, "utf8"), stopped, "grandchild must not survive termination");
      } finally {
        controller.abort();
        await running;
      }
    });
  });
}
