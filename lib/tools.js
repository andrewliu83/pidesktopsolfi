"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * The six agent tools, and the panel channels that show what they did.
 *
 * Every handler returns the object convention PI-Desktop projects to the model
 * (`{ ok, text, …details }`, JSON-stringified by the host), and refuses with a
 * thrown error that names the setting or the limit that stopped it — never with
 * a plausible-looking success.
 */

const { mkdir, readFile, readdir, stat, writeFile } = require("node:fs/promises");
const { dirname, join } = require("node:path");

const configLib = require("./config.js");
const fusion = require("./action-fusion.js");
const hostLib = require("./host.js");
const { createSafeLedger } = require("./ledger.js");
const observation = require("./observation-pack.js");
const paths = require("./paths.js");
const planLib = require("./compact-plan.js");
const economics = require("./compact-economics.js");
const stateLib = require("./compact-state.js");
const reducer = require("./reducer.js");

/** Upstream's constant for the native summary a compaction leaves behind. */
const DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE = 1000;
/**
 * The host caps one tool result at 8000 characters when it projects the session
 * to a plugin (`PLUGIN_TOOL_RESULT_MAX_CHARS` in host 0.15.x). A scan can
 * therefore see at most that much of a long result, and says so.
 */
const HOST_TOOL_RESULT_VISIBLE_CHARS = 8000;
const CHARS_PER_TOKEN = 4;
const MAX_SCAN_PLACEHOLDER_BYTES = 64 * 1024;

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

function tokenEstimate(text) {
  return Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN);
}

function result(payload) {
  return { ok: true, ...payload };
}

function round(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 10 ** digits) / 10 ** digits
    : null;
}

/* ------------------------------------------------------------------- ledger */

async function ledgerFor(host, ctx) {
  const root = await hostLib.sessionRoot(host, ctx);
  return createSafeLedger(paths.observationLedgerPath(root), (error) => {
    void error;
  });
}

async function readLedgerTail(path, limit) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const lines = raw.split("\n").filter((line) => line.trim());
  const tail = lines.slice(Math.max(0, lines.length - limit));
  const entries = [];
  for (const line of tail) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* a partial trailing line is not a reason to hide the rest */
    }
  }
  return entries;
}

/* --------------------------------------------------------- action fusion */

async function handleFusedEdit(args, ctx, host) {
  const config = await hostLib.config(host);
  configLib.requireMechanism(config, "actionFusion");

  const workspace = await hostLib.workspace(host);
  const target = await fusion.resolveInsideRoot(workspace.path, args?.path);
  const thenRun = args?.then_run;

  const outcome = await fusion.executeMutationThenRun({
    absolutePath: target.absolutePath,
    relativePath: target.relativePath,
    mutation: () => fusion.applyMutation(target, args ?? {}),
    thenRun,
    cwd: workspace.path,
    signal: ctx?.signal,
  });

  if (outcome.status === "none") {
    return result({
      text: outcome.summary,
      path: outcome.relativePath ?? target.relativePath,
      action: args?.action,
      then_run: null,
    });
  }

  const lines = [outcome.summary];
  if (outcome.status === "succeeded") {
    lines.push("", fusion.THEN_RUN_SUCCEEDED);
    if (outcome.output) lines.push(outcome.output);
    for (const note of outcome.notes ?? []) lines.push(`[note] ${note}`);
    return result({
      text: lines.join("\n"),
      path: target.relativePath,
      action: args?.action,
      then_run: { command: thenRun.command, exit_code: outcome.exitCode, status: outcome.status },
      model_round_trips_avoided: 1,
    });
  }

  // Upstream reports a failed follow-up command as an error that still carries
  // the mutation, because the edit stands while its validation did not pass.
  const failure = [outcome.summary, "", fusion.THEN_RUN_FAILED];
  if (outcome.output) failure.push(outcome.output);
  for (const note of outcome.notes ?? []) failure.push(`[note] ${note}`);
  if (outcome.exitCode !== null) failure.push(`exit_code=${outcome.exitCode}`);
  throw Object.assign(new Error(failure.join("\n")), {
    code: "THEN_RUN_FAILED",
    path: target.relativePath,
  });
}

/* -------------------------------------------------------- observation pack */

function placeholderSummary(obs) {
  return {
    id: obs.id,
    tool: obs.toolName,
    original_bytes: obs.bytes,
    original_lines: obs.lines,
    estimated_tokens: obs.tokens,
    content_sha256: obs.contentHash,
  };
}

async function packText(host, ctx, { text, toolName, toolCallId, thresholdBytes, sourceTruncated }) {
  const root = await hostLib.sessionRoot(host, ctx);
  // Upstream's 10 KiB rule, unless the caller is looking at a view the host has
  // already truncated: then the floor is what the plugin can actually see, and the
  // result says so rather than pretending it archived the whole thing.
  const floor =
    Number.isSafeInteger(thresholdBytes) && thresholdBytes >= 1
      ? thresholdBytes
      : observation.THRESHOLD_BYTES;
  const obs = observation.createObservation({ text, toolName, toolCallId }, root, {
    thresholdBytes: floor,
  });
  if (!obs) {
    const bytes = byteLength(text);
    if (observation.containsReducerReceipt(text)) {
      return {
        packed: false,
        reason: "already-a-verified-receipt",
        bytes,
        message:
          "This text is already an evidence-preserving receipt; packing it again would replace verified evidence with an excerpt.",
      };
    }
    return {
      packed: false,
      reason: "under-threshold",
      bytes,
      threshold_bytes: floor,
      message: `This result is ${bytes} bytes; ObservationPack only packs results larger than ${floor} bytes, so nothing was archived.`,
    };
  }
  await observation.ensureStored(obs);
  const placeholder = observation.placeholderFor(obs);
  const placeholderTokens = observation.estimateTokens(placeholder);
  const removedTokens = Math.max(0, obs.tokens - placeholderTokens);
  const ledger = await ledgerFor(host, ctx);
  await ledger({
    event: "pack",
    id: obs.id,
    tool: obs.toolName,
    toolCallId,
    sourceMayBeTruncated: sourceTruncated === true,
    originalBytes: obs.bytes,
    originalLines: obs.lines,
    originalTokens: obs.tokens,
    placeholderBytes: byteLength(placeholder),
    placeholderTokens,
    removedTokens,
    contentHash: obs.contentHash,
    objectPath: obs.filePath,
  });
  return {
    packed: true,
    ...placeholderSummary(obs),
    placeholder_bytes: byteLength(placeholder),
    removed_tokens: removedTokens,
    source_may_be_truncated: sourceTruncated === true,
    placeholder,
  };
}

async function handleObsPack(args, ctx, host) {
  const action = String(args?.action ?? "");
  if (action === "list") {
    return await listObservations(host, ctx, args);
  }

  const config = await hostLib.config(host);
  configLib.requireMechanism(config, "observationPack");

  if (action === "pack") {
    let text = typeof args?.text === "string" ? args.text : undefined;
    let toolName = typeof args?.tool === "string" && args.tool ? args.tool : "unknown";
    if (text === undefined && typeof args?.path === "string" && args.path) {
      const workspace = await hostLib.workspace(host);
      const target = await fusion.resolveInsideRoot(workspace.path, args.path);
      text = await readFile(target.absolutePath, "utf8");
      toolName = toolName === "unknown" ? `read:${target.relativePath}` : toolName;
    }
    if (typeof text !== "string") {
      throw new Error('obs_pack action "pack" needs either `text` or `path`.');
    }
    const packed = await packText(host, ctx, {
      text,
      toolName,
      toolCallId: typeof args?.tool_call_id === "string" ? args.tool_call_id : "",
    });
    if (!packed.packed) {
      return result({ text: packed.message, ...packed });
    }
    return result({
      text: packed.placeholder,
      ...packed,
      next_step: `Continue with the placeholder above. Read its bytes back with obs_recall {"id":"${packed.id}","offset":0} when you need them.`,
    });
  }

  if (action === "scan") {
    return await scanContext(host, ctx, args);
  }

  throw new Error('obs_pack action must be "pack", "scan" or "list".');
}

async function listObservations(host, ctx, args) {
  const root = await hostLib.sessionRoot(host, ctx);
  const entries = await readLedgerTail(paths.observationLedgerPath(root), 2000);
  const packed = new Map();
  let packedCount = 0;
  let packedBytes = 0;
  let removedTokens = 0;
  let recallCount = 0;
  for (const entry of entries) {
    if (entry?.event === "pack" && typeof entry.id === "string") {
      packed.set(entry.id, entry);
      packedCount += 1;
      packedBytes += Number(entry.originalBytes ?? 0);
      removedTokens += Number(entry.removedTokens ?? 0);
    } else if (entry?.event === "recall") {
      recallCount += 1;
    }
  }
  const limit = clampLimit(args?.limit, 20, 200);
  const list = [...packed.values()]
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      id: entry.id,
      tool: entry.tool,
      original_bytes: entry.originalBytes,
      original_lines: entry.originalLines,
      estimated_tokens: entry.originalTokens,
      removed_tokens: entry.removedTokens,
      packed_at: entry.timestamp,
      object_path: entry.objectPath,
    }));
  const text = list.length
    ? [
        `# Archived observations (${packedCount} packed, ${recallCount} recalls)`,
        "",
        ...list.map(
          (item) =>
            `- \`${item.id}\` — ${item.tool}: ${item.original_bytes} bytes / ${item.original_lines} lines (${item.estimated_tokens} tokens), ${item.removed_tokens} tokens kept out of context`,
        ),
      ].join("\n")
    : "# Archived observations\n\nNothing is archived for this session yet.";
  return result({
    text,
    observations: list,
    packed_count: packedCount,
    archived_bytes: packedBytes,
    tokens_kept_out_of_context: removedTokens,
    recalls: recallCount,
    session_root: root,
  });
}

/**
 * Upstream merges a file mutation with the command that follows it, and that
 * merged result is the one the agent has to read: it carries the confirmation of
 * what changed and the `[then_run:…]` verdict of what ran afterwards. Replacing
 * it behind the agent's back would hide the verdict, so the scan leaves fused
 * results alone. The agent can still pack one by hand with obs_pack, which is an
 * explicit request rather than an automatic projection.
 *
 * The verdict marker sits on the third line of a fused result, ahead of the
 * command output, so it survives the host's 8000-character projection. The tool
 * name is checked as well, because that identifies a fused call even when a scan
 * sees only the head of a result.
 */
const THEN_RUN_MARKERS = [fusion.THEN_RUN_SUCCEEDED, fusion.THEN_RUN_FAILED, fusion.THEN_RUN_SKIPPED];
const FUSED_TOOL_NAME = "fused_edit";

function fusedThenRunResult(text, toolName) {
  if (String(toolName ?? "") === FUSED_TOOL_NAME) return true;
  return THEN_RUN_MARKERS.some((marker) => String(text ?? "").includes(marker));
}

/**
 * The closest thing to upstream's context hook that the host allows: look at the
 * live conversation, count how many provider requests each large tool result has
 * already been part of (the assistant messages that follow it), and pack the ones
 * that have been replayed at least FULL_SENDS times.
 */
async function scanContext(host, ctx, args) {
  const context = await hostLib.sessionContext(host);
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const requestedMinBytes = clampNumber(args?.min_bytes, observation.THRESHOLD_BYTES, 1, 100 * 1024 * 1024);
  // PI-Desktop projects at most 8000 characters of a single tool result to a
  // plugin, so a scan that insisted on upstream's 10 KiB threshold could never
  // find anything. The floor drops to what the host actually exposes, and every
  // archive made from a truncated view says so in its own placeholder.
  const minBytes = Math.min(requestedMinBytes, HOST_TOOL_RESULT_VISIBLE_CHARS);
  const limit = clampLimit(args?.limit, 10, 50);

  const priorAssistantCounts = new Array(messages.length);
  let assistantCount = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    priorAssistantCounts[index] = assistantCount;
    if (messages[index]?.role === "assistant") assistantCount += 1;
  }

  const candidates = [];
  let skipped = 0;
  let fusedKept = 0;
  let placeholderBytes = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message?.role !== "tool") continue;
    const content = typeof message.content === "string" ? message.content : "";
    if (byteLength(content) < minBytes) continue;
    const priorSends = priorAssistantCounts[index] ?? 0;
    if (priorSends < observation.FULL_SENDS) continue;
    if (fusedThenRunResult(content, message.toolName)) {
      fusedKept += 1;
      continue;
    }
    if (candidates.length >= limit) {
      skipped += 1;
      continue;
    }
    const packed = await packText(host, ctx, {
      text: content,
      toolName: message.toolName ?? "unknown",
      toolCallId: `ctx:${index}`,
      thresholdBytes: minBytes,
      sourceTruncated: content.length >= HOST_TOOL_RESULT_VISIBLE_CHARS,
    });
    if (!packed.packed) continue;
    if (placeholderBytes + packed.placeholder_bytes > MAX_SCAN_PLACEHOLDER_BYTES) {
      skipped += 1;
      continue;
    }
    placeholderBytes += packed.placeholder_bytes;
    candidates.push({
      ...packed,
      prior_provider_requests: priorSends,
      source_visible_chars: content.length,
      source_may_be_truncated: content.length >= HOST_TOOL_RESULT_VISIBLE_CHARS,
    });
  }

  const totalTokens = candidates.reduce((sum, item) => sum + item.removed_tokens, 0);
  const text = candidates.length
    ? [
        `# ${candidates.length} large tool result(s) eligible for packing`,
        "",
        `Together they hold ${candidates.reduce((sum, item) => sum + item.original_bytes, 0)} bytes that have already been sent at least ${observation.FULL_SENDS} times. Replace each of them with its placeholder; the bytes stay on disk and obs_recall returns them exactly.`,
        fusedKept > 0
          ? `${fusedKept} other large result(s) were left alone because they are fused-call results whose [then_run:…] verdict the agent still needs to read.`
          : "",
        "",
        ...candidates.map((item) =>
          [
            `## ${item.id} — ${item.tool} (${item.original_bytes} bytes, ${item.prior_provider_requests} provider requests so far)`,
            item.source_may_be_truncated
              ? "_The host projects at most 8000 characters of a tool result to a plugin, so this archive holds that visible part._"
              : "",
            "",
            item.placeholder,
            "",
          ]
            .filter((line) => line !== undefined)
            .join("\n"),
        ),
      ].join("\n")
    : [
        "# Nothing to pack",
        "",
        `No tool result in the live context reaches ${minBytes} bytes and has already been replayed ${observation.FULL_SENDS} times.`,
        fusedKept > 0
          ? `${fusedKept} large result(s) were left alone because they are fused-call results whose [then_run:…] verdict the agent still needs to read.`
          : "",
        requestedMinBytes === observation.THRESHOLD_BYTES
          ? `Upstream's threshold is ${observation.THRESHOLD_BYTES} bytes, but PI-Desktop hands a plugin at most ${HOST_TOOL_RESULT_VISIBLE_CHARS} characters of a result; a result you still hold in full can be packed directly with obs_pack action "pack".`
          : "",
        context?.truncated === true
          ? "The host also truncated this view of the conversation, so older results may not be visible here."
          : "",
      ]
        .filter(Boolean)
        .join("\n");

  return result({
    text,
    candidates: candidates.map(({ placeholder, ...rest }) => rest),
    tokens_kept_out_of_context: totalTokens,
    skipped,
    fused_results_kept: fusedKept,
    context_truncated: context?.truncated === true,
  });
}

async function handleObsRecall(args, ctx, host) {
  const id = String(args?.id ?? "");
  if (!observation.isObservationId(id)) throw new Error(`Unknown observation id: ${id}`);
  const offsetRaw = Number(args?.offset ?? 0);
  if (!Number.isSafeInteger(offsetRaw) || offsetRaw < 0) {
    throw new Error("offset must be a non-negative integer.");
  }
  const requestedBytes = clampNumber(
    args?.max_bytes,
    observation.RECALL_LIMITS.maxBytes,
    1,
    observation.RECALL_LIMITS.maxBytes,
  );
  const root = await hostLib.sessionRoot(host, ctx);
  const limits = { maxBytes: requestedBytes, maxLines: observation.RECALL_LIMITS.maxLines };

  let chunk;
  try {
    chunk = await observation.readRecallChunk(observation.observationPath(root, id), offsetRaw, limits);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Unknown observation id: ${id}`);
    throw error;
  }

  const content = `${observation.recallHeader(id, offsetRaw, chunk)}\n${chunk.text}`;
  if (
    byteLength(content) > observation.RECALL_MAX_BYTES ||
    observation.countLines(content) > observation.RECALL_MAX_LINES
  ) {
    throw new Error("Recall output exceeded its hard limit.");
  }

  const ledger = await ledgerFor(host, ctx);
  await ledger({
    event: "recall",
    id,
    offset: offsetRaw,
    bytes: chunk.bytes,
    lines: chunk.lines,
    nextOffset: chunk.nextOffset,
    eof: chunk.eof,
  });

  return result({
    text: content,
    id,
    offset: offsetRaw,
    bytes: chunk.bytes,
    lines: chunk.lines,
    next_offset: chunk.nextOffset,
    eof: chunk.eof,
  });
}

/* ---------------------------------------------------- evidence-preserving */

async function readReducerSource(host, ctx, args) {
  const given = ["text", "path", "observation_id"].filter((key) => args?.[key] !== undefined);
  if (given.length !== 1) {
    throw new Error("reduce_evidence needs exactly one source: `text`, `path` or `observation_id`.");
  }
  if (given[0] === "text") return String(args.text);
  if (given[0] === "path") {
    const workspace = await hostLib.workspace(host);
    const target = await fusion.resolveInsideRoot(workspace.path, args.path);
    return await readFile(target.absolutePath, "utf8");
  }
  const id = String(args.observation_id);
  if (!observation.isObservationId(id)) throw new Error(`Unknown observation id: ${id}`);
  const root = await hostLib.sessionRoot(host, ctx);
  try {
    return await readFile(observation.observationPath(root, id), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Unknown observation id: ${id}`);
    throw error;
  }
}

async function handleReduceEvidence(args, ctx, host) {
  const config = await hostLib.config(host);
  configLib.requireMechanism(config, "evidencePreservingReducer");

  const body = await readReducerSource(host, ctx, args ?? {});
  const root = await hostLib.sessionRoot(host, ctx);
  const journal = createSafeLedger(paths.reducerJournalPath(root), (error) => {
    void error;
  });
  const record = async (entry) => {
    const { kind, ...data } = entry;
    await journal({
      event: reducer.REDUCER_EVENT_TYPE,
      schema: reducer.REDUCER_EVENT_SCHEMA,
      kind,
      ...data,
    });
  };

  const reducerConfig = reducer.loadReducerConfig({
    reducerProvider: config.evidencePreservingReducerProvider,
    reducerModel: config.evidencePreservingReducerModel,
    storeRoot: paths.reducerRoot(root),
  });

  const outcome = await reducer.reduceLog(
    record,
    reducerConfig,
    {
      body,
      command: typeof args?.command === "string" ? args.command : "",
      isError: args?.is_error === true,
      reducerModel: typeof args?.reducer_model === "string" ? args.reducer_model : undefined,
    },
    (input) => host.agent.complete(input),
  );

  if (!outcome.applied) {
    // Fail open: the original text is returned untouched, with the reason, so a
    // reduction that cannot be verified never hides evidence.
    const reasonText = {
      "source-under-min-bytes": `The log is smaller than ${reducer.DEFAULT_MIN_BYTES} bytes; reduction is not worth a model call.`,
      "source-over-max-chars": "The log is larger than the reducer's 600,000-character limit, so it was not sent anywhere.",
      "likely-secret": "The log looks like it contains a credential, so it was not sent to any model.",
      "not-a-diagnostic-command": "The command is not a build/test/lint command, so the log was not reduced.",
      "invalid-json": "The reducer model did not return JSON.",
      "schema-mismatch": "The receipt did not match the required schema or the archived source hash.",
      "unverifiable-quote": "At least one quoted line could not be found byte for byte in the archived log.",
      "missing-failure-evidence": "A failing log came back without failure evidence, so the receipt was discarded.",
      "receipt-not-smaller": "The receipt was not smaller than the original log.",
      "model-response-error": "The reducer model returned an error.",
      "model-call-timeout": "The reducer model call timed out.",
      "reducer-model-unavailable": "The configured reducer model is not available in this installation.",
      "model-call-exception": "The reducer model call failed.",
      "reducer-model-invalid": "The requested reducer model is not a providerId/modelId pair.",
    }[outcome.reason];
    return result({
      text: body,
      applied: false,
      reason: outcome.reason,
      explanation: reasonText ?? `Reduction was skipped (${outcome.reason}).`,
      detail: outcome.detail ?? null,
      source_artifact: outcome.archive?.path ?? null,
      note: "The original text above is unchanged.",
    });
  }

  return result({
    text: outcome.receipt,
    applied: true,
    ...placeholderReceiptSummary(outcome),
  });
}

function placeholderReceiptSummary(outcome) {
  return {
    status: outcome.archive ? "verified" : "unknown",
    source_bytes: outcome.archive?.bytes ?? null,
    source_sha256: outcome.archive?.hash ?? null,
    source_artifact: outcome.archive?.path ?? null,
    receipt_bytes: outcome.receiptBytes,
    removed_bytes: outcome.removedBytes,
    evidence_count: outcome.evidenceCount,
    uncertain: outcome.uncertain,
    reducer_provider: outcome.provider,
    reducer_model: outcome.model,
    usage: outcome.usage,
  };
}

/* ------------------------------------------------------- online compaction */

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function clampLimit(value, fallback, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 1) return fallback;
  return Math.min(max, Math.floor(numeric));
}

function contextTokenEstimate(messages) {
  let total = 0;
  for (const message of messages) {
    total += Math.ceil(byteLength(message?.content) / CHARS_PER_TOKEN);
  }
  return total;
}

function modelContextWindow(entries, modelKey) {
  const wanted = String(modelKey ?? "");
  const pick =
    entries.find((entry) => entry?.key === wanted) ??
    entries.find((entry) => `${entry?.providerId}/${entry?.modelId}` === wanted) ??
    null;
  if (!pick) return { modelKey: wanted || null, contextWindow: null };
  const window =
    (Number.isFinite(pick.contextWindow) && pick.contextWindow) ||
    (Number.isFinite(pick.context_window) && pick.context_window) ||
    (Number.isFinite(pick?.limits?.contextWindow) && pick.limits.contextWindow) ||
    null;
  return { modelKey: wanted || pick.key || null, contextWindow: window ? Number(window) : null };
}

/**
 * Measure the live conversation and decide whether compacting pays for itself.
 *
 * What is measured, and what is not, is stated in the output: a plugin sees the
 * projected conversation (tool results capped at 8000 characters, 200k characters
 * in total) and not the system prompt, so the token figure is a floor.
 */
async function evaluateCompaction(host, ctx, options = {}) {
  const config = await hostLib.config(host);
  const context = await hostLib.sessionContext(host);
  const messages = Array.isArray(context?.messages) ? context.messages : [];
  const observedTokens = contextTokenEstimate(messages);
  const keepRecentTokens = clampNumber(
    options.keepRecentTokens,
    config.keepRecentTokens,
    1,
    Number.MAX_SAFE_INTEGER,
  );

  const root = await hostLib.sessionRoot(host, ctx);
  const statePath = paths.planPath(root);
  const state = await stateLib.loadOnlineState(statePath);
  const advanced = stateLib.recordProviderRequest(state, observedTokens);

  const remainingBoundaries = Number.isFinite(Number(options.remainingBoundaries))
    ? Math.max(0, Math.floor(Number(options.remainingBoundaries)))
    : advanced.plan.filter((step) => step.status !== "completed").length;

  const window = modelContextWindow(await hostLib.models(host), context?.modelKey ?? ctx?.modelKey);
  const archiveTokens = Math.max(0, observedTokens - keepRecentTokens);
  const averageContextTokenIncrement =
    advanced.positiveContextDeltaCount === 0
      ? null
      : advanced.positiveContextDeltaTotal / advanced.positiveContextDeltaCount;

  const decision = economics.decideCompaction({
    writeTokens: observedTokens,
    archiveTokens,
    memoTokens: DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
    contextTokens: observedTokens,
    completedBoundaryRequestCounts: advanced.completedBoundaryRequestCounts.length
      ? advanced.completedBoundaryRequestCounts
      : null,
    remainingBoundaries,
    averageContextTokenIncrement,
    contextWindowTokens: window.contextWindow,
    priorCompactionCount: advanced.nativeCompactionCount,
    carriedDebtTokens: advanced.cacheDebtTokens,
    cacheDebtRepaymentTokens: advanced.cacheDebtRepaymentTokens,
    cacheWriteReadRatio: config.cacheWriteReadRatio,
    economics: economics.DEFAULT_COMPACTION_ECONOMICS,
  });

  await stateLib.saveOnlineState(statePath, advanced);
  return {
    config,
    context,
    messages,
    observedTokens,
    keepRecentTokens,
    state: advanced,
    statePath,
    remainingBoundaries,
    contextWindowTokens: window.contextWindow,
    modelKey: window.modelKey ?? context?.modelKey ?? null,
    decision,
    basis: {
      measured: "the conversation the host projects to a plugin",
      tool_results_capped_at_chars: HOST_TOOL_RESULT_VISIBLE_CHARS,
      system_prompt_included: false,
      context_truncated: context?.truncated === true,
    },
  };
}

function decisionSummary(decision) {
  return {
    compact: decision.compact,
    reason: decision.reason,
    context_tokens: decision.contextTokens,
    archive_tokens: decision.archiveTokens,
    memo_tokens: decision.memoTokens,
    break_even_requests: round(decision.breakevenRequests),
    effective_horizon_requests: round(decision.effectiveHorizonRequests),
    expected_remaining_requests: round(decision.expectedRemainingRequests),
    requests_per_boundary_mean: round(decision.requestsPerBoundaryMean),
    context_window_tokens: decision.contextWindowTokens ?? null,
    window_request_upper_bound: decision.windowRequestUpperBound,
    cache_write_read_ratio: decision.cacheWriteReadRatio,
    prior_compaction_count: decision.priorCompactionCount,
    carried_debt_tokens: round(decision.carriedDebtTokens),
  };
}

function decisionSentence(decision) {
  if (decision.compact && decision.reason === "window_protection") {
    return "Worth compacting now: the context is inside the window reserve, so the price is no longer the question.";
  }
  if (decision.compact) {
    return `Worth compacting now: break-even at ${round(decision.breakevenRequests)} requests, inside the estimated ${round(
      decision.effectiveHorizonRequests,
    )} requests left.`;
  }
  const because = {
    non_positive_saving: "the compaction would not remove enough tokens to pay for itself",
    horizon_unavailable: "no completed plan step has been recorded yet, so there is no request horizon to price against",
    cache_ratio_unavailable: "the configured cache write-to-read ratio is missing, so no price could be computed",
    deferred_subsequent_margin: "this is not the first compaction and the margin is not open yet",
    deferred_carried_debt: "the cache debt from the previous compaction is still being repaid",
    deferred_economic: "the remaining work is expected to end before the rewrite is repaid",
  }[decision.reason];
  return `Not worth it yet: ${because ?? decision.reason}.`;
}

async function writeCompactionBrief(host, ctx, evaluation) {
  const root = await hostLib.sessionRoot(host, ctx);
  const briefPath = paths.compactionBriefPath(root);
  const state = evaluation.state;
  const completed = state.plan.filter((step) => step.status === "completed");
  const remaining = state.plan.filter((step) => step.status !== "completed");
  const lines = [
    "# SoL-Pi compaction brief",
    "",
    `Written ${new Date().toISOString()} before compacting this session.`,
    "Read this back after the checkpoint: the conversation no longer carries it.",
    "",
    "## Verdict",
    "",
    `- ${decisionSentence(evaluation.decision)}`,
    `- context measured: ${evaluation.observedTokens} tokens (conversation only; the system prompt is not visible to a plugin)`,
    `- break-even: ${round(evaluation.decision.breakevenRequests)} requests; horizon: ${round(evaluation.decision.effectiveHorizonRequests)} requests`,
    `- reason code: \`${evaluation.decision.reason}\``,
    "",
    "## Completed work",
    "",
  ];
  if (completed.length === 0) lines.push("- none recorded");
  for (const step of completed) lines.push(`- [${step.id}] ${step.goal}`);
  lines.push("", "## Remaining work", "");
  if (remaining.length === 0) lines.push("- none recorded");
  for (const step of remaining) {
    lines.push(`- [${step.id}] ${step.goal} (${step.status})`);
  }
  if (state.pendingProgress.length > 0) {
    lines.push("", "## Progress evidence", "");
    for (const progress of state.pendingProgress.slice(-12)) {
      lines.push(`- [${progress.stepId}] ${progress.goal}`);
      if (progress.filesChanged.length) lines.push(`  - files changed: ${progress.filesChanged.join(", ")}`);
      if (progress.verification.length) lines.push(`  - verification: ${progress.verification.join("; ")}`);
      if (progress.decisions.length) lines.push(`  - decisions: ${progress.decisions.join("; ")}`);
      if (progress.nextWork.length) lines.push(`  - next work: ${progress.nextWork.join("; ")}`);
    }
  }
  lines.push(
    "",
    "## After the checkpoint",
    "",
    "- The task is still active; keep going from the remaining work above.",
    "- Archived evidence is still on disk: `obs_pack` action `list` shows the handles and `obs_recall` returns exact pages.",
    "- Numeric facts cost more to re-derive than to keep, so re-run a command only when its output is genuinely needed again.",
    "",
  );
  await mkdir(dirname(briefPath), { recursive: true, mode: 0o700 });
  await writeFile(briefPath, lines.join("\n"), { encoding: "utf8", mode: 0o600 });
  return briefPath;
}

async function handlePlanUpdate(args, ctx, host) {
  const config = await hostLib.config(host);
  configLib.requireMechanism(config, "onlineContextCompact");

  const steps = planLib.parsePlanSteps(args?.steps);
  if (!steps || steps.length === 0) {
    throw new Error("plan_update needs at least one valid step: {id, goal, status}.");
  }

  const root = await hostLib.sessionRoot(host, ctx);
  const statePath = paths.planPath(root);
  const state = await stateLib.loadOnlineState(statePath);
  const transition = planLib.analyzePlanTransition(state.plan, steps);
  const completedIds = transition.completedSteps.map((step) => step.id);

  let next = state;
  let boundaryRecorded = false;
  if (completedIds.length > 0) {
    const firstCompleted = steps.find((step) => step.id === completedIds[0]);
    const progress = progressFor(args?.progress, steps, firstCompleted);
    next = stateLib.recordBoundary(state, steps, progress);
    boundaryRecorded = true;
  } else if (JSON.stringify(state.plan) !== JSON.stringify(steps)) {
    next = { ...state, plan: [...steps] };
  }
  await stateLib.saveOnlineState(statePath, next);

  let verdict = null;
  let briefPath = null;
  if (boundaryRecorded) {
    const evaluation = await evaluateCompaction(host, ctx, {
      keepRecentTokens: config.keepRecentTokens,
      remainingBoundaries: steps.filter((step) => step.status !== "completed").length,
    });
    verdict = decisionSummary(evaluation.decision);
    briefPath = await writeCompactionBrief(host, ctx, evaluation);
  }

  const text = [
    planLib.formatPlanSnapshot(steps),
    ...transition.advice,
    boundaryRecorded ? `Progress boundary recorded for ${completedIds.join(", ")}.` : "",
    verdict
      ? `${decisionSentence(verdict)}\n${
          verdict.compact
            ? `Ask the user to run the /compact command, then continue from ${briefPath}.`
            : `The carry-forward brief is at ${briefPath} if a checkpoint happens anyway.`
        }`
      : "",
    "The plan is persisted for this session; send the complete plan again on the next update.",
  ]
    .filter(Boolean)
    .join("\n");

  return result({
    text,
    boundary: boundaryRecorded,
    completed_step_ids: completedIds,
    plan: steps,
    compaction: verdict,
    brief_path: briefPath,
  });
}

function progressFor(progress, steps, completedStep) {
  if (!progress || !completedStep) return undefined;
  const strings = (value) =>
    Array.isArray(value) ? value.filter((item) => typeof item === "string").slice(0, 128) : [];
  return {
    stepId: completedStep.id,
    goal: completedStep.goal,
    filesChanged: strings(progress.files_changed),
    verification: strings(progress.verification),
    decisions: strings(progress.decisions),
    nextWork: steps.filter((step) => step.status !== "completed").map((step) => step.goal),
  };
}

async function handleCompactCheck(args, ctx, host) {
  const config = await hostLib.config(host);
  configLib.requireMechanism(config, "onlineContextCompact");

  const evaluation = await evaluateCompaction(host, ctx, {
    keepRecentTokens: args?.keep_recent_tokens,
    remainingBoundaries: args?.remaining_boundaries,
  });
  const briefPath = await writeCompactionBrief(host, ctx, evaluation);
  const summary = decisionSummary(evaluation.decision);

  const text = [
    "# Compaction check",
    "",
    `- ${decisionSentence(evaluation.decision)}`,
    `- context measured: ${evaluation.observedTokens} tokens (conversation only; PI-Desktop does not let a plugin see the system prompt)`,
    `- tokens kept verbatim: ${evaluation.keepRecentTokens}; archive: ${evaluation.decision.archiveTokens}; summary: ${evaluation.decision.memoTokens}`,
    `- break-even: ${round(evaluation.decision.breakevenRequests)} requests; horizon: ${round(evaluation.decision.effectiveHorizonRequests)} requests (${evaluation.remainingBoundaries} boundaries left)`,
    `- compaction ${evaluation.decision.compact ? "recommended" : "not recommended"} — reason \`${evaluation.decision.reason}\``,
    `- carry-forward brief: ${briefPath}`,
    "",
    "PI-Desktop keeps native compaction under the user's command, so this tool cannot perform it.",
    evaluation.decision.compact
      ? "Ask the user to run the /compact command, then continue from the brief above."
      : "Continue working; ask for a checkpoint when this verdict changes.",
  ].join("\n");

  return result({
    text,
    compaction: summary,
    context_truncated: evaluation.basis.context_truncated,
    brief_path: briefPath,
    horizon_basis: {
      completed_boundary_request_counts: evaluation.decision.completedBoundaryRequestCounts,
      remaining_boundaries: evaluation.remainingBoundaries,
      average_context_token_increment: round(evaluation.decision.averageContextTokenIncrement),
      context_window_tokens: evaluation.contextWindowTokens,
      model_key: evaluation.modelKey,
    },
  });
}

/* ------------------------------------------------------------ panel bridge */

/**
 * Every session bucket this plugin has archived into, newest first.
 *
 * The panel runs outside a tool call, so it has no session id to key on: it
 * enumerates what the tools actually wrote under the plugin data directory
 * instead of pretending to know the live session. A bucket that cannot be
 * summarised is still listed, with `error` set, so an unreadable archive shows
 * up rather than silently going missing.
 */
async function listSessionBuckets(host) {
  const dir = join(await hostLib.dataPath(host), "sessions");
  let names = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }

  const buckets = [];
  for (const name of names) {
    const root = join(dir, name);
    try {
      const observations = await readLedgerTail(paths.observationLedgerPath(root), 200);
      const reducerEntries = await readLedgerTail(paths.reducerJournalPath(root), 200);
      const planState = await stateLib.loadOnlineState(paths.planPath(root));
      const packs = observations.filter((entry) => entry?.event === "pack");
      const receipts = reducerEntries.filter((entry) => entry?.event === reducer.REDUCER_EVENT_TYPE);
      let brief = null;
      try {
        const info = await stat(paths.compactionBriefPath(root));
        brief = { bytes: info.size, at: info.mtime.toISOString() };
      } catch {
        brief = null;
      }
      const stamps = [
        ...observations.map((entry) => entry?.timestamp),
        ...reducerEntries.map((entry) => entry?.timestamp),
        brief?.at,
      ].filter((value) => typeof value === "string");
      buckets.push({
        bucket: name,
        observations: packs.length,
        recalled: observations.filter((entry) => entry?.event === "recall").length,
        archived_bytes: packs.reduce((sum, entry) => sum + Number(entry.originalBytes ?? 0), 0),
        tokens_kept_out: packs.reduce((sum, entry) => sum + Number(entry.removedTokens ?? 0), 0),
        receipts: {
          candidates: receipts.filter((entry) => entry.kind === "candidate").length,
          applied: receipts.filter((entry) => entry.kind === "applied").length,
          fallbacks: receipts.filter((entry) => entry.kind === "fallback").length,
        },
        plan_steps: Array.isArray(planState?.plan) ? planState.plan.length : 0,
        has_brief: brief !== null,
        updated_at: stamps.length ? stamps.sort().at(-1) : null,
        error: null,
      });
    } catch (error) {
      buckets.push({ bucket: name, error: String(error?.message ?? error) });
    }
  }
  buckets.sort((left, right) =>
    String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")),
  );
  return buckets;
}

/**
 * The bucket the panel shows: the one it asked for, else the most recently
 * written.
 *
 * A bucket name is a lookup key, never a path: it has to match a directory that
 * is already there, so a crafted name cannot walk out of the data directory.
 */
async function resolveBucket(host, requested) {
  const dir = join(await hostLib.dataPath(host), "sessions");
  const wanted = typeof requested === "string" ? requested.trim() : "";
  if (wanted) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    const match = entries.find((entry) => entry.isDirectory() && entry.name === wanted);
    if (!match) throw new Error(`unknown session bucket: ${wanted}`);
    return { bucket: match.name, root: join(dir, match.name) };
  }
  const newest = (await listSessionBuckets(host)).find((entry) => !entry.error);
  if (newest) return { bucket: newest.bucket, root: join(dir, newest.bucket) };
  return { bucket: null, root: await hostLib.sessionRoot(host, {}) };
}

/** The panel's whole view of the plugin: settings, one bucket, and its totals. */
async function panelState(host, options = {}) {
  const stored = await hostLib.settings(host);
  // Resolve straight from the stored settings rather than through
  // `hostLib.config`, which throws: the panel has to be able to show a bad
  // settings value instead of going blank.
  const resolved = configLib.resolveConfig(stored);
  const config = resolved.ok ? resolved.config : configLib.defaultConfig();
  const sessions = await listSessionBuckets(host);
  const { bucket, root } = await resolveBucket(host, options.bucket);

  let workspace = null;
  try {
    workspace = await hostLib.workspace(host);
  } catch {
    workspace = null;
  }

  const observations = await readLedgerTail(paths.observationLedgerPath(root), 200);
  const reducerEntries = await readLedgerTail(paths.reducerJournalPath(root), 200);
  const planState = await stateLib.loadOnlineState(paths.planPath(root));
  let brief = null;
  try {
    brief = await readFile(paths.compactionBriefPath(root), "utf8");
  } catch {
    brief = null;
  }

  const packs = observations.filter((entry) => entry?.event === "pack");
  const receipts = reducerEntries.filter((entry) => entry?.event === reducer.REDUCER_EVENT_TYPE);

  return {
    ok: true,
    version: require("./metadata.js").VERSION,
    settings: stored,
    config,
    config_error: resolved.ok ? null : resolved.error,
    enabled: configLib.enabledMechanisms(config),
    workspace: workspace ? { name: workspace.name, path: workspace.path } : null,
    sessions,
    bucket,
    totals: {
      observations: packs.length,
      recalled: observations.filter((entry) => entry?.event === "recall").length,
      archived_bytes: packs.reduce((sum, entry) => sum + Number(entry.originalBytes ?? 0), 0),
      tokens_kept_out: packs.reduce((sum, entry) => sum + Number(entry.removedTokens ?? 0), 0),
      reducer_candidates: receipts.filter((entry) => entry.kind === "candidate").length,
      reducer_applied: receipts.filter((entry) => entry.kind === "applied").length,
      reducer_fallbacks: receipts.filter((entry) => entry.kind === "fallback").length,
    },
    plan: planState
      ? {
          steps: planState.plan,
          completed_boundaries: planState.completedBoundaryRequestCounts,
          native_compactions: planState.nativeCompactionCount,
          request_count: planState.requestCount,
        }
      : null,
    observations: packs
      .slice(-20)
      .reverse()
      .map((entry) => ({
        id: entry.id,
        tool: entry.tool ?? null,
        original_bytes: entry.originalBytes ?? null,
        removed_tokens: entry.removedTokens ?? null,
        packed_at: entry.timestamp ?? null,
      })),
    receipts: receipts
      .slice(-20)
      .reverse()
      .map((entry) => ({
        kind: entry.kind,
        reason: entry.reason ?? null,
        source_bytes: entry.sourceBytes ?? null,
        receipt_bytes: entry.receiptBytes ?? null,
        evidence_count: entry.evidenceCount ?? null,
        digest: entry.sourceSha256 ?? null,
        at: entry.timestamp ?? null,
      })),
    brief,
  };
}

/**
 * Read one archived object exactly, in pages.
 *
 * `kind` says which archive an observation id or content digest belongs to.
 * Both paths are built from a bucket root this plugin minted, and an id that is
 * not exactly the expected shape is refused before any file is opened.
 */
async function readArchivedPage(host, payload) {
  const { root } = await resolveBucket(host, payload?.bucket);
  const offset = isNonNegativeInteger(payload?.offset) ? payload.offset : 0;
  const kind = String(payload?.kind ?? "observation");
  let file;
  let label;
  if (kind === "observation") {
    const id = String(payload?.id ?? "");
    if (!observation.isObservationId(id)) throw new Error("unknown observation id");
    file = observation.observationPath(root, id);
    label = id;
  } else if (kind === "reducer") {
    const digest = String(payload?.digest ?? "");
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("unknown archived log digest");
    file = paths.reducerObjectPath(root, digest);
    label = digest;
  } else {
    throw new Error(`unknown archive kind: ${kind}`);
  }

  let chunk;
  try {
    chunk = await observation.readRecallChunk(file, offset, {
      maxBytes: observation.RECALL_LIMITS.maxBytes,
      maxLines: observation.RECALL_LIMITS.maxLines,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`no archived ${kind} ${label} in this session bucket`);
    }
    throw error;
  }
  return {
    ok: true,
    kind,
    id: label,
    offset,
    text: chunk.text,
    bytes: chunk.bytes,
    lines: chunk.lines,
    next_offset: chunk.nextOffset,
    eof: chunk.eof,
  };
}

/** Everything the panel HTML talks to, over `window.pluginBridge`. */
async function onPanelInvoke(host, channel, payload) {
  const bucket = payload?.bucket;
  switch (channel) {
    case "sol.state":
      return await panelState(host, { bucket });
    case "sol.setSettings": {
      const patch = payload?.patch;
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
        throw new Error("patch must be an object");
      }
      await hostLib.updateSettings(host, patch);
      return await panelState(host, { bucket });
    }
    case "sol.applyPreset": {
      const preset = payload?.preset === "local" ? configLib.localPreset() : configLib.disabledPreset();
      await hostLib.updateSettings(host, preset);
      return await panelState(host, { bucket });
    }
    case "sol.readArchived":
      return await readArchivedPage(host, payload);
    default:
      throw new Error(`unknown SoL-Pi panel channel: ${channel}`);
  }
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The handler table `main.js` registers, keyed by tool name. */
function createHandlers(host) {
  return {
    fused_edit: (args, ctx) => handleFusedEdit(args, ctx, host),
    obs_pack: (args, ctx) => handleObsPack(args, ctx, host),
    obs_recall: (args, ctx) => handleObsRecall(args, ctx, host),
    reduce_evidence: (args, ctx) => handleReduceEvidence(args, ctx, host),
    plan_update: (args, ctx) => handlePlanUpdate(args, ctx, host),
    compact_check: (args, ctx) => handleCompactCheck(args, ctx, host),
  };
}

module.exports = {
  DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE,
  HOST_TOOL_RESULT_VISIBLE_CHARS,
  createHandlers,
  panelState,
  onPanelInvoke,
  evaluateCompaction,
  decisionSummary,
  decisionSentence,
  contextTokenEstimate,
  modelContextWindow,
  packText,
  readLedgerTail,
  progressFor,
};
