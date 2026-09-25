"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 * Ported from NVlabs/SoL-Pi `src/sol-pi/extensions/action-fusion/` (MIT):
 * file-queue.ts and then-run.ts.
 *
 * Action Fusion - fuse a file mutation and its follow-up command into one turn.
 *
 * Upstream replaces the built-in `edit` and `write` tools with versions that take
 * an optional `then_run` object. PI-Desktop's built-ins cannot be replaced, so the
 * port registers `fused_edit`, which performs the same two steps under the same
 * rules: the mutation is applied first, a file-hash guard proves nothing changed
 * underneath the fused call, the command runs only then, and the result carries
 * the same `[then_run:…]` markers - so a failed mutation skips the command
 * instead of running it against an unchanged file.
 */

const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { mkdir, readFile, realpath, rename, writeFile } = require("node:fs/promises");
const { homedir } = require("node:os");
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { fileURLToPath } = require("node:url");

const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";
const THEN_RUN_SKIPPED = "[then_run:skipped]";

/** Per-stream capture cap, so one noisy command cannot flood the model context. */
const MAX_STREAM_BYTES = 200 * 1024;
/** The host ends a plugin tool call at 110s; stay clearly inside that budget. */
const MAX_COMMAND_TIMEOUT_MS = 105000;

const queueTails = new Map();
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;
const WINDOWS_SHELL_DRIVE = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i;

/** Credential paths any mutation must refuse, on top of root containment. */
const CREDENTIAL_SEGMENTS = new Set([".ssh", ".aws", ".git", ".gnupg", ".kube"]);
const CREDENTIAL_FILE = /^(?:\.env(?:\..*)?|.*\.pem|.*\.key|id_rsa.*|.*credentials.*|.*\.p12|.*\.pfx)$/i;

function normalizeToolPath(filePath) {
  const normalized = String(filePath ?? "").replace(UNICODE_SPACES, " ");
  return normalized.startsWith("@") ? normalized.slice(1) : normalized;
}

/**
 * Git Bash, MSYS, Cygwin, and WSL hand paths like `/c/src/app.ts`. On Windows
 * those must become native drive paths before the queue and the hash guard
 * address the file the mutation actually wrote.
 */
function normalizeWindowsShellPath(filePath) {
  if (process.platform !== "win32") return filePath;
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) {
    return filePath;
  }
  const match = WINDOWS_SHELL_DRIVE.exec(filePath);
  if (!match?.[1]) return filePath;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/** Resolve a caller-supplied path the way a shell and the mutation tool both see it. */
function resolveToolPath(cwd, filePath) {
  const stripped = normalizeWindowsShellPath(normalizeToolPath(filePath));
  const expanded = stripped.startsWith("file://") ? fileURLToPath(stripped) : stripped;
  if (expanded === "~") return homedir();
  if (expanded.startsWith("~/") || (process.platform === "win32" && expanded.startsWith("~\\"))) {
    return resolve(homedir(), expanded.slice(2));
  }
  return resolve(cwd, expanded);
}

function isMissingPathError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function canonicalQueueKey(filePath) {
  const resolvedPath = resolve(filePath);
  let current = resolvedPath;
  const missingSegments = [];

  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return resolvedPath;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Serialize fused operations for one canonical file path. This queue belongs to
 * SoL-Pi and never nests the host's own tool queue.
 */
async function withFusedFileQueue(filePath, work) {
  const key = await canonicalQueueKey(filePath);
  const previous = queueTails.get(key) ?? Promise.resolve();
  let release;
  const owned = new Promise((resolveOwned) => {
    release = resolveOwned;
  });
  const tail = previous.then(() => owned);
  queueTails.set(key, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queueTails.get(key) === tail) queueTails.delete(key);
  }
}

async function fileSha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Prove the file still holds what the mutation produced before a command is
 * allowed to act on it. Any interference fails the check, and a failed check
 * skips the command rather than running it against surprise content.
 */
async function assertUnchangedBeforeCommand(path, yieldForInterference) {
  const yieldFn = yieldForInterference ?? (() => new Promise((r) => setImmediate(r)));
  try {
    const mutationHash = await fileSha256(path);
    await yieldFn();
    const commandHash = await fileSha256(path);
    if (mutationHash !== commandHash) {
      throw new Error("target content changed after the fused mutation");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${THEN_RUN_SKIPPED} ${message}; the command was not run.`);
  }
}

/* ------------------------------------------------------------------ safety */

function credentialReason(relativePath) {
  const segments = relativePath.split(/[\\/]+/).filter(Boolean);
  for (const segment of segments.slice(0, -1)) {
    if (CREDENTIAL_SEGMENTS.has(segment.toLowerCase())) {
      return `refused: "${segment}/" is a credential directory`;
    }
  }
  const name = segments.at(-1) ?? "";
  if (CREDENTIAL_SEGMENTS.has(name.toLowerCase())) return `refused: "${name}" is a credential path`;
  if (CREDENTIAL_FILE.test(name)) return `refused: "${name}" looks like a credential file`;
  return undefined;
}

/**
 * Resolve one target inside the project root, refusing escapes and credentials.
 *
 * The check is done on the real path of the deepest existing ancestor, so a
 * symlink pointing outside the project cannot smuggle a write there.
 */
async function resolveInsideRoot(root, relativePath) {
  if (typeof root !== "string" || !root.trim()) {
    throw new Error("The project root is unavailable; no file was changed.");
  }
  const raw = String(relativePath ?? "").trim();
  if (!raw) throw new Error("path is required.");

  // Upstream Action Fusion accepts the forms an agent actually hands over: an
  // `@`-prefixed path, a `file://` URL, the unicode spaces a terminal inserts.
  // They are resolved first and then forced back inside the project root, so the
  // accepted syntax is wider than the writable area, never wider than it.
  const stripped = normalizeToolPath(raw);
  const isFileUrl = /^file:\/\//i.test(stripped);
  const absoluteLike =
    /^[a-zA-Z]:[\\/]/.test(stripped) || stripped.startsWith("/") || stripped.startsWith("\\");
  if (absoluteLike && !isFileUrl) {
    throw new Error(`refused: "${raw}" is absolute; give a project-relative path`);
  }
  if (!isFileUrl && (stripped === "~" || stripped.startsWith("~/") || stripped.startsWith("~\\"))) {
    throw new Error(`refused: "${raw}" is a home-directory path; give a project-relative path`);
  }

  let normalized;
  if (isFileUrl) {
    let absolute;
    try {
      absolute = fileURLToPath(stripped);
    } catch {
      throw new Error(`refused: "${raw}" is not a usable file URL`);
    }
    // The same project can be named by its literal root or by its resolved one
    // (macOS reports /var where the real path is /private/var), so both spellings
    // are accepted. Anything that is inside neither is refused; the containment
    // walk below still re-checks the resolved path of the deepest existing
    // ancestor, so a symlink inside the project cannot smuggle a write out.
    const target = resolve(absolute);
    let asRelative = null;
    for (const base of [resolve(root), await realpath(root)]) {
      const candidate = relative(base, target);
      if (candidate && !candidate.startsWith("..") && !isAbsolute(candidate)) {
        asRelative = candidate;
        break;
      }
    }
    if (asRelative === null) {
      throw new Error(`refused: "${raw}" resolves outside the project root`);
    }
    normalized = asRelative.split(/[\\/]+/).filter(Boolean);
  } else {
    normalized = normalizeWindowsShellPath(stripped)
      .split(/[\\/]+/)
      .filter((part) => part && part !== ".");
    if (normalized.includes("..")) {
      throw new Error(`refused: "${raw}" escapes the project root`);
    }
  }
  const credential = credentialReason(normalized.join("/"));
  if (credential) throw new Error(credential);

  const target = resolve(root, ...normalized);
  const rootReal = await realpath(root);
  let existing = target;
  const missing = [];
  while (true) {
    try {
      const real = await realpath(existing);
      const insideBase = resolve(real, ...missing);
      if (insideBase !== rootReal && !insideBase.startsWith(rootReal + sep)) {
        throw new Error(`refused: "${raw}" resolves outside the project root`);
      }
      return { absolutePath: insideBase, relativePath: normalized.join("/") };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(existing);
      if (parent === existing) {
        throw new Error(`refused: "${raw}" could not be resolved inside the project root`);
      }
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

/* --------------------------------------------------------------- mutation */

/**
 * Edit semantics of the built-in tool, as a pure function: an exact match that
 * must be unique unless `replaceAll` says otherwise, and an explicit error
 * instead of a silent no-op.
 */
function applyEdit(text, oldString, newString, replaceAll) {
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new Error("edit: old_string must be a non-empty string.");
  }
  if (typeof newString !== "string") throw new Error("edit: new_string must be a string.");
  if (oldString === newString) throw new Error("edit: old_string and new_string are identical.");
  const first = text.indexOf(oldString);
  if (first < 0) throw new Error("edit: old_string was not found in the file.");
  if (!replaceAll) {
    const second = text.indexOf(oldString, first + oldString.length);
    if (second >= 0) {
      throw new Error(
        "edit: old_string appears more than once; include more context or pass replace_all.",
      );
    }
    return text.slice(0, first) + newString + text.slice(first + oldString.length);
  }
  return text.split(oldString).join(newString);
}

/** Write through a temporary file in the same directory, then rename. */
async function writeAtomic(path, content) {
  // A `write` may be the first file in a directory that does not exist yet, so
  // the parent is created here instead of failing with an ENOENT that names a
  // temporary file the caller never asked for.
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${basename(path)}.sol-pi-${process.pid}.tmp`);
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function applyMutation(target, input) {
  const action = input.action;
  if (action === "write") {
    if (typeof input.content !== "string") throw new Error("write: content must be a string.");
    let before = null;
    try {
      before = await readFile(target.absolutePath, "utf8");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    if (before !== null && before === input.content) {
      throw new Error("write: the file already has exactly this content.");
    }
    await writeAtomic(target.absolutePath, input.content);
    return {
      summary: `Wrote ${target.relativePath} (${Buffer.byteLength(input.content, "utf8")} bytes${
        before === null ? ", new file" : `, replaced ${Buffer.byteLength(before, "utf8")} bytes`
      }).`,
    };
  }
  if (action !== "edit") {
    throw new Error('action must be "edit" or "write".');
  }
  let before;
  try {
    before = await readFile(target.absolutePath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new Error(
        `edit: ${target.relativePath} does not exist; use action "write" to create it.`,
      );
    }
    throw error;
  }
  const after = applyEdit(before, input.old_string, input.new_string, input.replace_all === true);
  await writeAtomic(target.absolutePath, after);
  return {
    summary: `Edited ${target.relativePath} (${Buffer.byteLength(before, "utf8")} → ${Buffer.byteLength(
      after,
      "utf8",
    )} bytes).`,
  };
}

/* ------------------------------------------------------------ then-run step */

function shellInvocation(command) {
  if (process.platform === "win32") {
    return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  const shell = process.env.SHELL || "/bin/sh";
  return { file: shell, args: ["-lc", command] };
}

/**
 * Run the follow-up command in the project root, bounded in both directions:
 * output is capped per stream and the call is killed before the host's own
 * 110s tool deadline. Returns the exit facts; it never throws for a non-zero
 * exit, because a failing command keeps the mutation.
 */
function runCommand(command, options = {}) {
  const cwd = options.cwd;
  const timeoutMs = Math.min(
    MAX_COMMAND_TIMEOUT_MS,
    typeof options.timeoutSeconds === "number" && options.timeoutSeconds > 0
      ? Math.round(options.timeoutSeconds * 1000)
      : MAX_COMMAND_TIMEOUT_MS,
  );
  const { file, args } = shellInvocation(command);

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({
        code: null,
        signal: null,
        spawnError: error instanceof Error ? error.message : String(error),
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: false,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const capture = (chunk, target) => {
      const text = chunk.toString("utf8");
      if (target === "out") {
        if (Buffer.byteLength(stdout, "utf8") >= MAX_STREAM_BYTES) {
          truncated = true;
          return;
        }
        stdout += text;
        if (Buffer.byteLength(stdout, "utf8") > MAX_STREAM_BYTES) {
          stdout = Buffer.from(stdout, "utf8").subarray(0, MAX_STREAM_BYTES).toString("utf8");
          truncated = true;
        }
        return;
      }
      if (Buffer.byteLength(stderr, "utf8") >= MAX_STREAM_BYTES) {
        truncated = true;
        return;
      }
      stderr += text;
      if (Buffer.byteLength(stderr, "utf8") > MAX_STREAM_BYTES) {
        stderr = Buffer.from(stderr, "utf8").subarray(0, MAX_STREAM_BYTES).toString("utf8");
        truncated = true;
      }
    };

    child.stdout?.on("data", (chunk) => capture(chunk, "out"));
    child.stderr?.on("data", (chunk) => capture(chunk, "err"));

    const kill = (signal) => {
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, signal, stdout, stderr, truncated, timedOut, spawnError: null });
    };

    child.on("error", (error) => {
      finish(null, null);
      void error;
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/**
 * Apply a file mutation and, when the model asked for one, run its follow-up
 * command before returning a single observation.
 *
 * Both steps run inside one SoL-Pi queue slot for the target path, so another
 * fused mutation of the same file cannot interleave.
 */
async function executeMutationThenRun({ absolutePath, relativePath, mutation, thenRun, cwd, signal }) {
  return withFusedFileQueue(absolutePath, async () => {
    let mutated;
    try {
      mutated = await mutation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (thenRun !== undefined) {
        throw new Error(
          `${message}\n\n${THEN_RUN_SKIPPED} The file mutation did not complete successfully; the command was not run.`,
        );
      }
      throw error;
    }

    if (thenRun === undefined) {
      return { summary: mutated.summary, output: null, status: "none" };
    }

    await assertUnchangedBeforeCommand(absolutePath);
    const result = await runCommand(thenRun.command, {
      cwd,
      signal,
      timeoutSeconds: thenRun.timeout,
    });

    const body = [result.stdout, result.stderr].filter((part) => part && part.length > 0).join("\n");
    const notes = [];
    if (result.timedOut) notes.push(`command timed out after ${thenRun.timeout ?? MAX_COMMAND_TIMEOUT_MS / 1000}s and was killed`);
    if (result.truncated) notes.push(`output was cut at ${MAX_STREAM_BYTES} bytes per stream`);
    if (result.spawnError) notes.push(`command could not start: ${result.spawnError}`);

    const failed = result.spawnError !== null || result.timedOut || (result.code ?? 1) !== 0;
    return {
      summary: mutated.summary,
      status: failed ? "failed" : "succeeded",
      exitCode: result.code,
      signal: result.signal,
      output: body,
      notes,
      path: relativePath,
    };
  });
}

module.exports = {
  THEN_RUN_SUCCEEDED,
  THEN_RUN_FAILED,
  THEN_RUN_SKIPPED,
  MAX_STREAM_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  normalizeToolPath,
  normalizeWindowsShellPath,
  resolveToolPath,
  canonicalQueueKey,
  withFusedFileQueue,
  fileSha256,
  assertUnchangedBeforeCommand,
  credentialReason,
  resolveInsideRoot,
  applyEdit,
  writeAtomic,
  applyMutation,
  shellInvocation,
  runCommand,
  executeMutationThenRun,
};
