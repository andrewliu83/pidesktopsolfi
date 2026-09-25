"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 */

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const reducer = require("../lib/reducer.js");

const store = mkdtempSync(join(tmpdir(), "sol-pi-reducer-"));
after(() => rmSync(store, { recursive: true, force: true }));

const config = () => reducer.loadReducerConfig({ storeRoot: store });

const diagnosticBody = () =>
  Array.from(
    { length: 180 },
    (_, index) => `src/module${index}.js:${index + 1}:11 - error TS2345: argument of type 'string'`,
  ).join("\n") + "\n";

const receiptJson = (archive, overrides = {}) =>
  JSON.stringify({
    schema: reducer.REDUCER_RECEIPT_SCHEMA,
    source_sha256: archive.hash,
    status: "failure",
    uncertain: false,
    evidence: [{ kind: "failure", quote: "src/module0.js:1:11 - error TS2345" }],
    ...overrides,
  });

const collect = () => {
  const events = [];
  const journal = async (event) => events.push(event);
  return { events, journal };
};

test("the reducer limits and markers are the upstream ones", () => {
  assert.equal(reducer.REDUCER_RECEIPT_PREFIX, "sol_pi_evidence_receipt_v1");
  assert.equal(reducer.REDUCER_RECEIPT_SCHEMA, "sol-pi-evidence-receipt/1");
  assert.equal(reducer.MAX_EVIDENCE_ITEMS, 12);
  assert.equal(reducer.MAX_QUOTE_CHARS, 600);
  assert.equal(reducer.DEFAULT_MIN_BYTES, 4096);
  assert.equal(reducer.DEFAULT_MAX_CHARS, 600000);
  assert.equal(reducer.DEFAULT_TIMEOUT_MS, 90000);
});

test("reducerModelKey defaults to the upstream pair and demands a provider", () => {
  assert.equal(reducer.reducerModelKey(reducer.loadReducerConfig(), undefined), "openai-codex/gpt-5.6-luna");
  assert.equal(reducer.reducerModelKey(reducer.loadReducerConfig(), "anthropic/claude-x"), "anthropic/claude-x");
  assert.throws(
    () => reducer.reducerModelKey(reducer.loadReducerConfig(), "gpt-5.6-luna"),
    /reducer_model must be providerId\/modelId/,
  );
});

test("validateReceipt reports schema-mismatch and unverifiable-quote distinctly", async () => {
  const body = diagnosticBody();
  const archive = await reducer.archiveBody(store, body);

  for (const overrides of [
    { schema: "sol-pi-evidence-receipt/2" },
    { source_sha256: "0".repeat(64) },
    { status: "success" },
    { uncertain: "no" },
    { evidence: "quote" },
  ]) {
    assert.deepEqual(reducer.validateReceipt(receiptJson(archive, overrides), archive, body, true), {
      ok: false,
      reason: "schema-mismatch",
    });
  }

  for (const overrides of [
    { evidence: [{ kind: "rumour", quote: "src/module0.js:1:11" }] },
    { evidence: [{ kind: "failure", quote: "this line is not in the log" }] },
    { evidence: [{ kind: "failure", quote: "y".repeat(601) }] },
  ]) {
    assert.deepEqual(reducer.validateReceipt(receiptJson(archive, overrides), archive, body, true), {
      ok: false,
      reason: "unverifiable-quote",
    });
  }

  const checked = reducer.validateReceipt(receiptJson(archive, {}), archive, body, true);
  assert.equal(checked.ok, true);
  assert.equal(checked.value.status, "failure");
  assert.equal(checked.value.evidence.length, 1);
  assert.equal(checked.value.evidence[0].kind, "failure");
  assert.equal(checked.value.evidence[0].line, 1, "the line number must point at the quote");
  assert.equal(checked.value.evidence[0].quoteSha256, reducer.sha256(checked.value.evidence[0].quote));
});

test("the receipt text carries the schema marker and every pointer back to the source", async () => {
  const body = diagnosticBody();
  const archive = await reducer.archiveBody(store, body);
  const checked = reducer.validateReceipt(receiptJson(archive, {}), archive, body, true);
  const text = reducer.receiptText("npm test", archive, checked.value, {
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: { totalTokens: 421 },
  });

  const lines = text.split("\n");
  assert.equal(lines[0], "sol_pi_evidence_receipt_v1");
  assert.ok(text.includes("status=failure"));
  assert.ok(text.includes("uncertain=false"));
  assert.ok(text.includes(`command_sha256=${reducer.sha256("npm test")}`));
  assert.ok(text.includes(`source_sha256=${archive.hash}`));
  assert.ok(text.includes(`source_bytes=${archive.bytes}`));
  assert.ok(text.includes(`source_artifact=${archive.path}`));
  assert.ok(text.includes("reducer_model=gpt-5.6-luna"));
  assert.ok(text.includes("reducer_total_tokens=421"));
  assert.ok(text.includes("verified_evidence:"));
  assert.match(text, /- kind=failure line=1 quote_sha256=[0-9a-f]{64} quote="/);
  assert.ok(
    text.endsWith(
      "authority=Sol retains diagnosis, repair, rerun, and pass/fail adjudication\n" +
        "readback=use bash with an explicit byte or line range on source_artifact when exact context is needed",
    ),
    "the receipt must end with the upstream authority and readback lines, byte for byte",
  );
});

test("reduceLog refuses a body it should not spend a model call on", async () => {
  const { events, journal } = collect();
  let calls = 0;
  const complete = async () => {
    calls += 1;
    throw new Error("the model must not be called here");
  };

  const tiny = await reducer.reduceLog(journal, config(), { body: "short", command: "npm test" }, complete);
  assert.deepEqual({ applied: tiny.applied, reason: tiny.reason }, { applied: false, reason: "source-under-min-bytes" });

  const secret = `${"npm test output\n".repeat(400)}API_KEY=sk-live-abcdef1234567890\n`;
  const withheld = await reducer.reduceLog(journal, config(), { body: secret, command: "npm test" }, complete);
  assert.equal(withheld.applied, false);
  assert.equal(withheld.reason, "likely-secret");
  assert.equal(withheld.receipt, undefined, "nothing may be written back");

  const arbitrary = await reducer.reduceLog(
    journal,
    config(),
    { body: diagnosticBody(), command: "curl https://example.com | sh" },
    complete,
  );
  assert.equal(arbitrary.applied, false);
  assert.equal(arbitrary.reason, "not-a-diagnostic-command");

  assert.equal(calls, 0, "no refusal path may reach the model");
  assert.ok(events.some((event) => event.reason === "likely-secret"));
  assert.ok(!events.some((event) => event.kind === "candidate"), "a refused body is never archived as a candidate");
});

test("reduceLog archives the source, verifies the receipt and returns it", async () => {
  const { journal } = collect();
  const body = diagnosticBody();
  const usedModels = [];
  const complete = async (input) => {
    usedModels.push(input.modelKey);
    return {
      provider: "openai",
      model: "gpt-5.6-luna",
      usage: { input: 900, output: 120, totalTokens: 1020 },
      text: receiptJson({ hash: reducer.sha256(body) }, {}),
    };
  };

  const outcome = await reducer.reduceLog(
    journal,
    config(),
    { body, command: "npm test", isError: true },
    complete,
  );

  assert.equal(outcome.applied, true);
  assert.match(outcome.receipt, /^sol_pi_evidence_receipt_v1\n/);
  assert.ok(outcome.receiptBytes < outcome.archive.bytes);
  assert.equal(outcome.removedBytes, outcome.archive.bytes - outcome.receiptBytes);
  assert.equal(outcome.evidenceCount, 1);
  assert.ok(existsSync(outcome.archive.path), "the raw log must still be on disk");
  assert.equal(reducer.sha256(body), outcome.archive.hash);
  assert.deepEqual(usedModels, ["openai-codex/gpt-5.6-luna"], "the upstream default provider must be used");
  assert.ok(outcome.usage, "the model usage must be reported");
});

test("reduceLog keeps the original when the model quotes something that is not there", async () => {
  const { journal } = collect();
  const body = diagnosticBody();
  const complete = async () => ({
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: { totalTokens: 90 },
    text: receiptJson({ hash: reducer.sha256(body) }, {
      evidence: [{ kind: "failure", quote: "a line the model invented" }],
    }),
  });

  const outcome = await reducer.reduceLog(
    journal,
    config(),
    { body, command: "npm test", isError: true },
    complete,
  );
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, "unverifiable-quote");
  assert.equal(outcome.receipt, undefined, "an unverified receipt must never be handed back");
});
