"use strict";
// SPDX-License-Identifier: MIT
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const fusion = require("../lib/action-fusion.js");

test("Windows background launch returns promptly after its shell exits", {
  skip: process.platform !== "win32", timeout: 12000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "sol-pi detached "));
  const ready = join(root, "worker.pid");
  const parent = join(root, "parent.cjs");
  const worker = join(root, "worker.cjs");
  writeFileSync(worker, "setInterval(() => {}, 100);");
  writeFileSync(parent, `const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(worker)}],{stdio:'inherit'}); child.unref(); require('node:fs').writeFileSync(${JSON.stringify(ready)},String(child.pid));`);
  const started = Date.now();
  try {
    const result = await fusion.runCommand(`"${process.execPath}" "${parent}"`, { cwd: root, timeoutSeconds: 1 });
    if (result.timedOut) {
      assert.match(result.spawnError, /cleanup could not be confirmed/);
    } else {
      assert.equal(result.code, 0);
      assert.equal(result.spawnError, null);
    }
    assert.ok(Date.now() - started < 6000, "an exited shell must not leave the queue hung indefinitely");
    assert.ok(existsSync(ready), "the worker really started before the shell exited");
  } finally {
    // This case deliberately leaves an orphan outside the live taskkill tree.
    // The tool reports the limitation; the test owns and cleans up its worker.
    if (existsSync(ready)) {
      try { process.kill(Number(readFileSync(ready, "utf8"))); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    await delay(100);
    rmSync(root, { recursive:true, force:true });
  }
});

// A deterministic pipe-lifetime regression independent of Windows handle
// inheritance details. The shell exits, but its stdout never emits close.
test("a timed-out shell with stuck pipes has a hard shutdown deadline", {timeout:8000}, async () => {
  const childProcess = require("node:child_process");
  const { EventEmitter } = require("node:events");
  const { PassThrough } = require("node:stream");
  const originalSpawn = childProcess.spawn;
  const modulePath = require.resolve("../lib/action-fusion.js");
  const shell = new EventEmitter();
  shell.pid = 2147483647; // no real process is targeted by the POSIX fallback
  shell.stdout = new PassThrough();
  shell.stderr = new PassThrough();
  shell.kill = () => false;
  let spawns = 0;
  childProcess.spawn = () => {
    if (spawns++ === 0) { queueMicrotask(() => shell.emit("exit", 0, null)); return shell; }
    const killer = new EventEmitter();
    queueMicrotask(() => killer.emit("exit", 128));
    return killer;
  };
  delete require.cache[modulePath];
  const keepAlive = setInterval(() => {}, 100);
  try {
    const isolated = require(modulePath);
    const started = Date.now();
    const result = await isolated.runCommand("unused", {timeoutSeconds:0.05});
    assert.equal(result.timedOut, true);
    assert.match(result.spawnError, /cleanup could not be confirmed/);
    assert.ok(Date.now() - started < 5000);
    assert.equal(shell.stdout.destroyed, true);
    assert.equal(shell.stderr.destroyed, true);
  } finally {
    clearInterval(keepAlive);
    childProcess.spawn = originalSpawn;
    delete require.cache[modulePath];
    shell.stdout.destroy(); shell.stderr.destroy();
  }
});
