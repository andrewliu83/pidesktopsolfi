"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const fusion = require("../lib/action-fusion.js");

const root = mkdtempSync(join(tmpdir(), "sol-pi-fusion-"));
const outside = mkdtempSync(join(tmpdir(), "sol-pi-outside-"));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("the fused-call markers and limits are the upstream ones", () => {
  assert.equal(fusion.THEN_RUN_SUCCEEDED, "[then_run:succeeded]");
  assert.equal(fusion.THEN_RUN_FAILED, "[then_run:failed]");
  assert.equal(fusion.THEN_RUN_SKIPPED, "[then_run:skipped]");
  assert.equal(fusion.MAX_STREAM_BYTES, 200 * 1024);
  assert.equal(fusion.MAX_COMMAND_TIMEOUT_MS, 105000);
});

test("credentials are refused by the segment or the file name that gives them away", () => {
  assert.match(fusion.credentialReason("keys/id_rsa"), /looks like a credential file/);
  assert.match(fusion.credentialReason(".env"), /looks like a credential file/);
  assert.match(fusion.credentialReason(".env.local"), /looks like a credential file/);
  assert.match(fusion.credentialReason("certs/server.pem"), /looks like a credential file/);
  assert.match(fusion.credentialReason("deploy/credentials.json"), /looks like a credential file/);
  assert.match(fusion.credentialReason(".ssh/id_ed25519"), /is a credential directory/);
  assert.match(fusion.credentialReason(".aws/credentials"), /is a credential directory/);
  assert.match(fusion.credentialReason(".git/config"), /is a credential directory/);
  assert.equal(fusion.credentialReason("src/app.js"), undefined);
  assert.equal(fusion.credentialReason("src/environment.ts"), undefined);
});

test("a target has to stay inside the project root, and away from credentials", async () => {
  mkdirSync(join(root, "src"), { recursive: true });
  const inside = await fusion.resolveInsideRoot(root, "./src/app.js");
  assert.equal(inside.relativePath, "src/app.js");
  // Containment is checked on the real path, so the answer is under the resolved root.
  const realRoot = realpathSync(root);
  assert.equal(inside.absolutePath, join(realRoot, "src", "app.js"));

  const created = await fusion.resolveInsideRoot(root, "src/deep/new.txt");
  assert.equal(created.relativePath, "src/deep/new.txt");
  assert.ok(created.absolutePath.startsWith(`${realRoot}/`), "a new file must still be resolved inside the root");

  const refused = [
    ["/etc/passwd", /is absolute/],
    ["C:\\Windows\\system32", /is absolute/],
    ["../outside.txt", /escapes the project root/],
    ["src/../../outside.txt", /escapes the project root/],
    [".env", /looks like a credential file/],
    ["", /path is required/],
  ];
  for (const [candidate, pattern] of refused) {
    await assert.rejects(() => fusion.resolveInsideRoot(root, candidate), pattern, candidate);
  }
});

test("a symlink out of the project is refused even though the path looks relative", async () => {
  symlinkSync(outside, join(root, "escape-link"));
  await assert.rejects(
    () => fusion.resolveInsideRoot(root, "escape-link/planted.txt"),
    /resolves outside the project root/,
  );
});

test("the path forms upstream accepts are resolved, then pinned inside the root", async () => {
  const realRoot = realpathSync(root);
  assert.notEqual(realRoot, root, "this test is only meaningful when the temp root is a symlink");

  assert.equal((await fusion.resolveInsideRoot(root, "@src/app.js")).relativePath, "src/app.js");
  assert.equal((await fusion.resolveInsideRoot(root, "@./src/./app.js")).relativePath, "src/app.js");
  assert.equal(
    (await fusion.resolveInsideRoot(root, "src/target\u00a0file.txt")).relativePath,
    "src/target file.txt",
    "the unicode spaces a terminal inserts must be normalised",
  );

  for (const base of [root, realRoot]) {
    const url = pathToFileURL(join(base, "src", "from-url.txt")).href;
    assert.equal((await fusion.resolveInsideRoot(root, url)).relativePath, "src/from-url.txt");
    assert.equal((await fusion.resolveInsideRoot(root, `@${url}`)).relativePath, "src/from-url.txt");
  }

  const refused = [
    [pathToFileURL(join(outside, "planted.txt")).href, /resolves outside the project root/],
    ["file://src/app.js", /not a usable file URL|resolves outside the project root/],
    ["~/notes.txt", /home-directory path/],
  ];
  for (const [candidate, pattern] of refused) {
    await assert.rejects(() => fusion.resolveInsideRoot(root, candidate), pattern, candidate);
  }
});

test("edit semantics are exact, and a silent no-op is impossible", () => {
  assert.equal(fusion.applyEdit("a b c", "b", "B", false), "a B c");
  assert.equal(fusion.applyEdit("b b", "b", "B", true), "B B");

  const refused = [
    [() => fusion.applyEdit("a", "", "x", false), /old_string must be a non-empty string/],
    [() => fusion.applyEdit("a", "a", 7, false), /new_string must be a string/],
    [() => fusion.applyEdit("a", "a", "a", false), /old_string and new_string are identical/],
    [() => fusion.applyEdit("a", "z", "x", false), /old_string was not found/],
    [() => fusion.applyEdit("b b", "b", "B", false), /appears more than once/],
  ];
  for (const [call, pattern] of refused) {
    assert.throws(call, pattern);
  }
});

test("a write creates its directory, replaces atomically and leaves no temporary file", async () => {
  const target = join(root, "fresh", "nested", "file.txt");
  await fusion.writeAtomic(target, "one\n");
  assert.equal(readFileSync(target, "utf8"), "one\n");
  assert.deepEqual(readdirSync(join(root, "fresh", "nested")), ["file.txt"]);

  const written = await fusion.applyMutation(
    { absolutePath: target, relativePath: "fresh/nested/file.txt" },
    { action: "write", content: "two\n" },
  );
  assert.match(written.summary, /Wrote fresh\/nested\/file\.txt/);
  assert.match(written.summary, /replaced 4 bytes/);

  await assert.rejects(
    () => fusion.applyMutation({ absolutePath: target, relativePath: "fresh/nested/file.txt" }, { action: "write", content: "two\n" }),
    /already has exactly this content/,
  );

  const edited = await fusion.applyMutation(
    { absolutePath: target, relativePath: "fresh/nested/file.txt" },
    { action: "edit", old_string: "two", new_string: "three" },
  );
  assert.match(edited.summary, /Edited fresh\/nested\/file\.txt \(4 → 6 bytes\)/);
  assert.equal(readFileSync(target, "utf8"), "three\n");

  await assert.rejects(
    () => fusion.applyMutation({ absolutePath: join(root, "ghost.txt"), relativePath: "ghost.txt" }, { action: "edit", old_string: "a", new_string: "b" }),
    /does not exist; use action "write"/,
  );
});

test("a command reports its exit code, its output and its own failure", async () => {
  const ok = await fusion.runCommand('node -e "console.log(7*6)"', { cwd: root });
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout.trim(), "42");
  assert.equal(ok.truncated, false);
  assert.equal(ok.timedOut, false);
  assert.equal(ok.spawnError, null);

  const failing = await fusion.runCommand('node -e "process.exit(3)"', { cwd: root });
  assert.equal(failing.code, 3);
  assert.equal(failing.timedOut, false);

  const noisy = await fusion.runCommand(
    'node -e "for (let i = 0; i < 60000; i += 1) console.log(\'x\'.repeat(8))"',
    { cwd: root },
  );
  assert.equal(noisy.truncated, true, "60000 lines must trip the cap");
  assert.ok(Buffer.byteLength(noisy.stdout, "utf8") <= fusion.MAX_STREAM_BYTES);
});

test("a command that overruns its timeout is killed and reported", async () => {
  const started = Date.now();
  const result = await fusion.runCommand('node -e "setTimeout(() => {}, 4000)"', {
    cwd: root,
    timeoutSeconds: 0.4,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3500, "the call must not wait for the command");
});

test("two calls on one file never overlap; two files may", async () => {
  const fileA = join(root, "queue-a.txt");
  const fileB = join(root, "queue-b.txt");

  // The queue is keyed per (resolved) path, so what it guarantees is that the
  // spans of two calls on one file never interleave. Which of the two acquires
  // the file first is not part of the contract.
  const sameFile = [];
  let running = 0;
  let peak = 0;
  const track = (file, label) =>
    fusion.withFusedFileQueue(file, async () => {
      running += 1;
      peak = Math.max(peak, running);
      sameFile.push(`${label}-start`);
      await delay(20);
      sameFile.push(`${label}-end`);
      running -= 1;
    });

  await Promise.all([track(fileA, "a"), track(fileA, "b")]);

  assert.equal(peak, 1, "two calls on one file must never run at the same time");
  assert.equal(sameFile.length, 4);
  assert.equal(
    sameFile[0].slice(0, -"-start".length),
    sameFile[1].slice(0, -"-end".length),
    `the first call must finish before the second starts: ${sameFile.join(", ")}`,
  );

  let parallel = 0;
  let parallelPeak = 0;
  const trackParallel = (file) =>
    fusion.withFusedFileQueue(file, async () => {
      parallel += 1;
      parallelPeak = Math.max(parallelPeak, parallel);
      await delay(20);
      parallel -= 1;
    });

  await Promise.all([trackParallel(fileA), trackParallel(fileB)]);
  assert.equal(parallelPeak, 2, "different files must not block each other");
});

test("the fused call keeps the mutation when the command fails, and reports both", async () => {
  const target = join(root, "fused.txt");

  const succeeded = await fusion.executeMutationThenRun({
    absolutePath: target,
    relativePath: "fused.txt",
    mutation: () => fusion.applyMutation({ absolutePath: target, relativePath: "fused.txt" }, { action: "write", content: "kept\n" }),
    thenRun: { command: 'node -e "process.stdout.write(String(6*7))"' },
    cwd: root,
  });
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.exitCode, 0);
  assert.equal(succeeded.output, "42");
  assert.deepEqual(succeeded.notes, []);

  const failed = await fusion.executeMutationThenRun({
    absolutePath: target,
    relativePath: "fused.txt",
    mutation: () => fusion.applyMutation({ absolutePath: target, relativePath: "fused.txt" }, { action: "write", content: "still kept\n" }),
    thenRun: { command: 'node -e "process.exit(9)"' },
    cwd: root,
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.exitCode, 9);
  assert.equal(readFileSync(target, "utf8"), "still kept\n", "the edit stands even when its validation fails");

  const timedOut = await fusion.executeMutationThenRun({
    absolutePath: target,
    relativePath: "fused.txt",
    mutation: () => fusion.applyMutation({ absolutePath: target, relativePath: "fused.txt" }, { action: "write", content: "x\n" }),
    thenRun: { command: 'node -e "setTimeout(() => {}, 4000)"', timeout: 0.4 },
    cwd: root,
  });
  assert.equal(timedOut.status, "failed");
  assert.ok(timedOut.notes.some((note) => note.includes("timed out")), "the timeout must be stated");
});

test("a mutation that never landed skips the command and says so", async () => {
  const marker = join(root, "command-ran.txt");
  await assert.rejects(
    () =>
      fusion.executeMutationThenRun({
        absolutePath: join(root, "never.txt"),
        relativePath: "never.txt",
        mutation: () => {
          throw new Error("mutation exploded");
        },
        thenRun: { command: `node -e "require('node:fs').writeFileSync('${marker}','ran')"` },
        cwd: root,
      }),
    (error) => error.message.includes("mutation exploded") && error.message.includes("[then_run:skipped]"),
  );
  assert.equal(existsSync(marker), false, "the command must not run after a failed mutation");
  assert.match(fusion.THEN_RUN_SKIPPED, /skipped/);
});
