#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Portable verification: no npm dependencies or shell glob expansion required.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
let steps = 0;
function run(label, command, args) {
  steps += 1;
  console.log(`\n── ${label}`);
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) {
    failures += 1;
    console.error(`FAILED: ${label}${result.error ? `: ${result.error.message}` : ""}`);
  }
}
const files = ["main.js"];
for (const directory of ["lib", "hooks", "eval", "views", "scripts"]) {
  for (const name of readdirSync(join(root, directory))) {
    if (/\.(?:js|mjs)$/.test(name)) files.push(`${directory}/${name}`);
  }
}
steps += 1;
let syntaxFailed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    syntaxFailed = true;
    console.error(`${file}: ${result.error?.message ?? result.stderr}`);
  }
}
if (syntaxFailed) failures += 1;
console.log(`── Syntax: ${files.length} source files ${syntaxFailed ? "FAILED" : "parse"}`);
run("Manifest matches metadata", process.execPath, ["scripts/sync-manifest.mjs", "--check"]);
const tests = readdirSync(join(root, "test")).filter(name => name.endsWith(".test.js")).sort();
run("Unit tests", process.execPath, ["--test", ...tests.map(name => `test/${name}`)]);
run("Offline host gate", process.execPath, ["eval/offline-check.js"]);
if (process.argv.includes("--mutations")) {
  const gitBash = process.platform === "win32"
    ? join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe") : "";
  const bash = process.env.SOL_PI_TEST_BASH || (gitBash && existsSync(gitBash) ? gitBash : "bash");
  run("Mutation gate (requires Bash, tar, grep and sed)", bash, ["eval/mutation-check.sh"]);
}
console.log(`\n── Summary: ${failures ? `${failures} of ${steps} steps failed` : `all ${steps} steps passed`}`);
process.exitCode = failures ? 1 : 0;
