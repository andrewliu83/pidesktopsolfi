"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 * Ported from NVlabs/SoL-Pi `src/sol-pi/extensions/observation-pack/observation.ts` (MIT).
 *
 * ObservationPack - keep a large tool result reachable without replaying it.
 *
 * Upstream rewrites the provider projection: a large tool result is sent in full
 * for its first two requests, then replaced by a short stable placeholder, while
 * the original bytes stay archived by observation id and the agent pulls exact
 * pages back with the `obs_recall` tool.
 *
 * PI-Desktop exposes no context hook, so the port keeps every rule that decides
 * *what* an observation is - the 10 KiB threshold, the id derivation, the
 * content-addressed store with its integrity checks, the exact placeholder text
 * and the byte/line paging - and moves the trigger to the agent (`obs_pack`) and
 * to a scan of the live session context. No byte of this module depends on the
 * projection layer, so the archive format and the paging contract are identical.
 */

const { createHash } = require("node:crypto");
const { constants } = require("node:fs");
const { lstat, mkdir, open } = require("node:fs/promises");
const { dirname, join } = require("node:path");

/** Only tool results larger than this participate. */
const THRESHOLD_BYTES = 10 * 1024;
/** Provider requests that still carry the full payload before the placeholder takes over. */
const FULL_SENDS = 2;
/** Placeholder excerpt budget, split evenly between head and tail, whole lines only. */
const PLACEHOLDER_EXCERPT_BYTES = 1024;

const CHARS_PER_TOKEN = 4;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;
const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

/**
 * Receipts from the evidence-preserving reducer are already a reduction of a long
 * log. Packing them again would replace verified evidence with an excerpt.
 */
const EVIDENCE_REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1";

/** `obs_recall` page limits, as upstream. */
const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;
const RECALL_LIMITS = Object.freeze({
  maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
  maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
});

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function countLines(text) {
  if (text.length === 0) return 0;
  let lines = text.endsWith("\n") ? 0 : 1;
  for (const character of text) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

function countBufferLines(buffer) {
  if (buffer.length === 0) return 0;
  let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }
  return lines;
}

function containsReducerReceipt(text) {
  return text.split("\n").some((line) => line === EVIDENCE_REDUCER_RECEIPT_PREFIX);
}

/**
 * Upstream's test for "this is a plain text tool result and nothing else":
 * a successful result whose blocks are all text. A result that failed, or that
 * carries an image, a file or a receipt-like non-text block, is left alone.
 *
 * It is defined here, next to the mechanism that consumes it, exactly as
 * upstream keeps it in `observation.ts` beside `createObservation`.
 */
function isPureTextResult(message) {
  return (
    message?.role === "toolResult" &&
    message.isError !== true &&
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => block?.type === "text")
  );
}

/** The text a tool result carries, joined the way upstream joins it. */
function textFromResult(message) {
  return (message.content ?? []).map((block) => block.text).join("\n");
}

function isObservationId(id) {
  return OBSERVATION_ID_PATTERN.test(String(id ?? ""));
}

function observationPath(runtimeRoot, id) {
  return join(runtimeRoot, "observation-pack", "objects", `${id}.txt`);
}

/**
 * Decide whether a text payload becomes an observation, and derive its identity.
 *
 * `createObservation` is pure so it can be tested without touching the disk; the
 * caller stores the result with `ensureStored`. An `undefined` return means "not
 * eligible": too small, or already a verified reducer receipt.
 *
 * `options.thresholdBytes` exists for one caller only: a scan of the live session
 * context, where PI-Desktop hands over at most 8000 characters of a result. The
 * explicit `obs_pack` path never passes it, so upstream's 10 KiB rule is exactly
 * what applies to a payload the plugin can see in full.
 */
function createObservation(input, runtimeRoot, options = {}) {
  const text = typeof input?.text === "string" ? input.text : "";
  const thresholdBytes =
    Number.isSafeInteger(options.thresholdBytes) && options.thresholdBytes >= 1
      ? options.thresholdBytes
      : THRESHOLD_BYTES;
  if (containsReducerReceipt(text)) return undefined;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= thresholdBytes) return undefined;
  if (!runtimeRoot) throw new Error("Persistent SoL-Pi runtime directory is unavailable");

  const toolName = typeof input?.toolName === "string" ? input.toolName : "unknown";
  const toolCallId = typeof input?.toolCallId === "string" ? input.toolCallId : "";
  const contentHash = hash(text);
  const id = `obs_${hash(`${toolName}\0${toolCallId}\0${contentHash}`).slice(0, 24)}`;
  return {
    id,
    contentHash,
    filePath: observationPath(runtimeRoot, id),
    toolName,
    text,
    bytes,
    lines: countLines(text),
    tokens: estimateTokens(text),
  };
}

/**
 * Write the payload to its content-addressed path, refusing symlinks and
 * verifying an existing object byte for byte before reusing it.
 */
async function ensureStored(observation) {
  const directoryPath = dirname(observation.filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`Observation directory is not a regular directory for ${observation.id}`);
  }

  let handle;
  try {
    handle = await open(observation.filePath, CREATE_OBJECT_FLAGS, 0o600);
    await handle.writeFile(observation.text, { encoding: "utf8" });
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
    try {
      const existing = await existingHandle.stat();
      if (!existing.isFile()) {
        throw new Error(`Content-addressed observation is not a regular file for ${observation.id}`);
      }
      if (existing.size !== observation.bytes) {
        throw new Error(`Content-addressed observation size mismatch for ${observation.id}`);
      }
      const existingContent = await existingHandle.readFile();
      if (hash(existingContent) !== observation.contentHash) {
        throw new Error(`Content-addressed observation hash mismatch for ${observation.id}`);
      }
    } finally {
      await existingHandle.close();
    }
  } finally {
    await handle?.close();
  }
}

function completeLineExcerpt(text, budgetBytes, fromEnd) {
  const lines = text.split(/(?<=\n)/);
  const selected = [];
  let selectedBytes = 0;
  let index = fromEnd ? lines.length - 1 : 0;

  while (index >= 0 && index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (selectedBytes + lineBytes > budgetBytes) break;
    if (fromEnd) selected.unshift(line);
    else selected.push(line);
    selectedBytes += lineBytes;
    index += fromEnd ? -1 : 1;
  }

  return selected.join("");
}

/** The exact text the agent continues with. Stable for the same observation. */
function placeholderFor(observation) {
  const headBudget = Math.floor(PLACEHOLDER_EXCERPT_BYTES / 2);
  const tailBudget = PLACEHOLDER_EXCERPT_BYTES - headBudget;
  const head = completeLineExcerpt(observation.text, headBudget, false);
  const tail = completeLineExcerpt(observation.text, tailBudget, true);
  return [
    `[large tool result replaced after its first ${FULL_SENDS} provider requests]`,
    `id: ${observation.id}`,
    `tool: ${observation.toolName}`,
    `original_bytes: ${observation.bytes}`,
    `original_lines: ${observation.lines}`,
    `estimated_tokens: ${observation.tokens}`,
    `retrieve: call obs_recall with {"id":"${observation.id}","offset":0}; continue with returned next_offset`,
    `[first complete lines, up to ${headBudget} bytes]`,
    head,
    `[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
    tail,
    `[${observation.bytes} original bytes omitted]`,
  ].join("\n");
}

function trimUtf8End(buffer, limit) {
  let end = limit;
  while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * Read one exact page of a stored observation. Paging is by byte offset with a
 * line cap, and a page never splits a UTF-8 sequence: the same contract upstream
 * exposes through `obs_recall`, so a resumed or compacted session keeps working.
 */
async function readRecallChunk(path, offset, limits) {
  const handle = await open(path, READ_OBJECT_FLAGS);
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
    if (offset > fileStats.size) {
      throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);
    }

    const available = Math.max(0, fileStats.size - offset);
    const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    let end = Math.min(bytesRead, limits.maxBytes);
    let newlineCount = 0;

    for (let index = 0; index < end; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      newlineCount += 1;
      if (newlineCount === limits.maxLines) {
        end = index + 1;
        break;
      }
    }

    end = trimUtf8End(buffer, end);
    const chunk = buffer.subarray(0, end);
    const nextOffset = offset + chunk.length;
    return {
      text: chunk.toString("utf8"),
      bytes: chunk.length,
      lines: countBufferLines(chunk),
      nextOffset,
      eof: nextOffset >= fileStats.size,
    };
  } finally {
    await handle.close();
  }
}

/** The two header lines an `obs_recall` page always carries. */
function recallHeader(id, offset, chunk) {
  return [
    `[obs_recall id=${id} offset=${offset} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
    `[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
  ].join("\n");
}

module.exports = {
  THRESHOLD_BYTES,
  FULL_SENDS,
  PLACEHOLDER_EXCERPT_BYTES,
  RECALL_MAX_BYTES,
  RECALL_MAX_LINES,
  RECALL_LIMITS,
  EVIDENCE_REDUCER_RECEIPT_PREFIX,
  hash,
  estimateTokens,
  countLines,
  countBufferLines,
  isObservationId,
  observationPath,
  createObservation,
  ensureStored,
  placeholderFor,
  readRecallChunk,
  recallHeader,
  containsReducerReceipt,
  isPureTextResult,
  textFromResult,
};
