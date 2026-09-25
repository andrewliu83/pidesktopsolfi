"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { createHash } = require("node:crypto");

const observation = require("../lib/observation-pack.js");

const store = mkdtempSync(join(tmpdir(), "sol-pi-obspack-"));
after(() => rmSync(store, { recursive: true, force: true }));

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const make = (text, options = {}) =>
  observation.createObservation({ text, toolName: "bash", toolCallId: "call_1", ...options }, store);

test("the upstream limits are the ones that ship", () => {
  assert.equal(observation.THRESHOLD_BYTES, 10 * 1024);
  assert.equal(observation.FULL_SENDS, 2);
  assert.equal(observation.PLACEHOLDER_EXCERPT_BYTES, 1024);
  assert.equal(observation.RECALL_MAX_BYTES, 16 * 1024);
  assert.equal(observation.RECALL_MAX_LINES, 400);
  assert.equal(observation.RECALL_LIMITS.maxBytes, 16 * 1024 - 512);
  assert.equal(observation.RECALL_LIMITS.maxLines, 400 - 2);
  assert.equal(observation.EVIDENCE_REDUCER_RECEIPT_PREFIX, "sol_pi_evidence_receipt_v1");
});

test("the threshold is strict: exactly 10 KiB is left alone, one byte more is packed", () => {
  assert.equal(make("x".repeat(10 * 1024)), undefined);
  const packed = make("x".repeat(10 * 1024 + 1));
  assert.equal(packed.bytes, 10 * 1024 + 1);
  assert.equal(packed.lines, 1);
  assert.equal(packed.tokens, Math.ceil((10 * 1024 + 1) / 4));
});

test("the observation id is upstream's derivation, not a home-made one", () => {
  const text = "y".repeat(20000);
  const packed = make(text);
  const contentHash = sha256(text);
  const expected = `obs_${sha256(`bash\0call_1\0${contentHash}`).slice(0, 24)}`;
  assert.equal(packed.id, expected);
  assert.match(packed.id, /^obs_[a-f0-9]{24}$/);
  assert.equal(packed.contentHash, contentHash);
  assert.equal(packed.filePath, observation.observationPath(store, packed.id));
});

test("the same text packed twice collapses onto one id", () => {
  const text = "z".repeat(15000);
  assert.equal(make(text).id, make(text, { toolCallId: "call_1" }).id);
  assert.notEqual(make(text).id, make(text, { toolCallId: "call_2" }).id);
});

test("a verified receipt is never packed again", () => {
  const body = `${"l".repeat(20000)}\nsol_pi_evidence_receipt_v1\nstatus=failure`;
  assert.equal(observation.containsReducerReceipt(body), true);
  assert.equal(make(body), undefined);
  assert.equal(observation.containsReducerReceipt("see sol_pi_evidence_receipt_v1 inline"), false);
});

test("an eligible observation without a runtime directory is an error, not a silent drop", () => {
  assert.throws(
    () => observation.createObservation({ text: "x".repeat(20000) }, ""),
    /runtime directory is unavailable/,
  );
});

test("isObservationId accepts only the documented shape", () => {
  assert.equal(observation.isObservationId(`obs_${"a".repeat(24)}`), true);
  assert.equal(observation.isObservationId(`obs_${"a".repeat(23)}`), false);
  assert.equal(observation.isObservationId(`obs_${"z".repeat(24)}`), false);
  assert.equal(observation.isObservationId("observation_abc"), false);
  assert.equal(observation.isObservationId(undefined), false);
});

test("hash and the small helpers match their contracts", () => {
  assert.equal(observation.hash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(observation.countLines(""), 0);
  assert.equal(observation.countLines("a"), 1);
  assert.equal(observation.countLines("a\n"), 1);
  assert.equal(observation.countLines("a\nb"), 2);
  assert.equal(observation.estimateTokens("abcd"), 1);
  assert.equal(observation.estimateTokens("abcde"), 2);
});

test("the placeholder names the id, the size and how to get the bytes back", () => {
  const packed = make("a".repeat(20000));
  const placeholder = observation.placeholderFor(packed);
  assert.match(placeholder, /^\[large tool result replaced after its first 2 provider requests\]\n/);
  assert.ok(placeholder.includes(`id: ${packed.id}`));
  assert.ok(placeholder.includes(`tool: bash`));
  assert.ok(placeholder.includes(`original_bytes: 20000`));
  assert.ok(placeholder.includes(`original_lines: 1`));
  assert.ok(placeholder.includes(`"id":"${packed.id}","offset":0`));
  assert.ok(placeholder.includes("[first complete lines, up to 512 bytes]"));
  assert.ok(placeholder.includes("[middle omitted; last complete lines, up to 512 bytes]"));
  assert.ok(placeholder.includes("[20000 original bytes omitted]"));
  assert.equal(placeholder, observation.placeholderFor(packed), "a placeholder must be stable");
});

test("storing is idempotent, and a corrupted object is an integrity failure", async () => {
  const packed = make("b".repeat(12000));
  await observation.ensureStored(packed);
  await observation.ensureStored(packed);
  assert.equal(readFileSync(packed.filePath, "utf8").length, 12000);

  writeFileSync(packed.filePath, "c".repeat(12000));
  await assert.rejects(() => observation.ensureStored(packed), /hash mismatch/);

  writeFileSync(packed.filePath, "short");
  await assert.rejects(() => observation.ensureStored(packed), /size mismatch/);
});

test("obs_recall paging returns the exact bytes and stops at the end", async () => {
  // 250 lines of ~51 bytes: comfortably over the 10 KiB threshold, and still
  // small enough that one full page (RECALL_LIMITS.maxBytes) holds all of it.
  const original = Array.from({ length: 250 }, (_, index) => `line ${index}: ${"d".repeat(40)}\n`).join("");
  const packed = make(original);
  await observation.ensureStored(packed);

  const whole = await observation.readRecallChunk(packed.filePath, 0, observation.RECALL_LIMITS);
  assert.equal(whole.text, original);
  assert.equal(whole.eof, true);
  assert.equal(whole.nextOffset, Buffer.byteLength(original, "utf8"));
  assert.match(
    observation.recallHeader(packed.id, 0, whole),
    new RegExp(`^\\[obs_recall id=${packed.id} offset=0 next_offset=${whole.nextOffset} eof=true\\]\\n`),
  );

  const pages = [];
  let offset = 0;
  let pageCount = 0;
  for (;;) {
    const chunk = await observation.readRecallChunk(packed.filePath, offset, {
      maxBytes: 128,
      maxLines: 5,
    });
    assert.ok(chunk.bytes <= 128, `page of ${chunk.bytes} bytes exceeds the requested 128`);
    assert.ok(chunk.lines <= 5, `page of ${chunk.lines} lines exceeds the requested 5`);
    assert.ok(chunk.bytes > 0, "a page must make progress");
    pages.push(chunk.text);
    pageCount += 1;
    if (chunk.eof) break;
    offset = chunk.nextOffset;
    assert.ok(pageCount < 400, "paging must terminate");
  }
  assert.equal(pages.join(""), original, "paged recall must reassemble byte-identically");
  assert.ok(pageCount > 1, "a 128-byte page cannot hold the whole observation");
});

test("an offset past the end is refused with the numbers", async () => {
  const packed = make("e".repeat(11000));
  await observation.ensureStored(packed);
  await assert.rejects(
    () => observation.readRecallChunk(packed.filePath, 999999, observation.RECALL_LIMITS),
    /exceeds observation size/,
  );
});

test("a directory where an object should be is refused", async () => {
  const id = `obs_${"f".repeat(24)}`;
  const path = observation.observationPath(store, id);
  mkdirSync(join(store, "observation-pack", "objects"), { recursive: true });
  mkdirSync(path, { recursive: true });
  await assert.rejects(() => observation.readRecallChunk(path, 0, observation.RECALL_LIMITS), /not a regular file/);
});
