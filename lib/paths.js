"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * Where SoL-Pi's archives live.
 *
 * Upstream writes `<session-directory>/sol-pi/<session-id>/`. PI-Desktop hands a
 * plugin its own data directory (`pi.plugin.getDataPath()`) and the session id of
 * the tool call that is running, so the same per-session layout is rebuilt under
 * that data directory. A session id that is absent (a command or the panel) or
 * that carries characters the host sanitizes differently gets a safe bucket name
 * with a short hash suffix, so two sessions can never collide into one archive.
 */

const { createHash } = require("node:crypto");
const { join } = require("node:path");

const UNSAFE_SEGMENT = /[^a-zA-Z0-9._-]/g;
const MAX_SEGMENT = 64;

/** A filesystem-safe, collision-resistant bucket for one session id. */
function sessionBucket(sessionId) {
  const raw = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!raw) return "shared";
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  const safe = raw.replace(UNSAFE_SEGMENT, "_").slice(0, MAX_SEGMENT) || "session";
  return `${safe}-${digest}`;
}

/**
 * Root for everything this session archives.
 *
 * `dataPath` comes from the host; without it nothing is written, and the caller
 * is told why rather than silently losing the archive.
 */
function sessionRoot(dataPath, sessionId) {
  if (typeof dataPath !== "string" || !dataPath.trim()) {
    throw Object.assign(new Error("SoL-Pi needs the plugin data directory to archive anything."), {
      code: "NO_DATA_DIR",
    });
  }
  return join(dataPath, "sessions", sessionBucket(sessionId));
}

function observationDir(root) {
  return join(root, "observation-pack");
}

function observationPath(root, id) {
  return join(observationDir(root), "objects", `${id}.txt`);
}

function observationLedgerPath(root) {
  return join(observationDir(root), "ledger.jsonl");
}

function reducerRoot(root) {
  return join(root, "evidence-preserving-reducer");
}

/**
 * Archive path for one log body, addressed by its own content hash. The first
 * two hex characters are a directory shard so a long session does not put tens of
 * thousands of objects in one directory.
 */
function reducerObjectPath(root, hash) {
  return join(reducerRoot(root), "objects", hash.slice(0, 2), `${hash}.txt`);
}

function reducerJournalPath(root) {
  return join(reducerRoot(root), "journal.jsonl");
}

function planPath(root) {
  return join(root, "online-context-compact", "plan.json");
}

function compactionBriefPath(root) {
  return join(root, "online-context-compact", "compaction-brief.md");
}

module.exports = {
  sessionBucket,
  sessionRoot,
  observationDir,
  observationPath,
  observationLedgerPath,
  reducerRoot,
  reducerObjectPath,
  reducerJournalPath,
  planPath,
  compactionBriefPath,
};