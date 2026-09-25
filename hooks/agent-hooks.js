"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 * Ported from NVlabs/SoL-Pi `src/sol-pi/extensions/observation-pack/index.ts` (MIT).
 *
 * The hook route.
 *
 * PI-Desktop loads this module inside its **agent** process, because the plugin's
 * manifest declares it under `contributes.agentExtensions` and asks for the
 * `agent.extension` permission. That is the only place the port can get what
 * upstream's plugins get from `@earendil-works/pi-coding-agent`: a handler on
 * `context`, which sees the messages of a provider request before it is sent and
 * may return a rewritten list.
 *
 * What this module therefore restores, using the port's own libraries so the two
 * routes cannot drift:
 *
 *  - `context`   - upstream's ObservationPack projection, byte for byte: a large
 *                  tool result is sent in full for its first `FULL_SENDS`
 *                  requests, then replaced by the port's exact placeholder, while
 *                  the original bytes stay archived by observation id and the
 *                  agent pulls exact pages back with `obs_recall`. Because the
 *                  hook sees the *whole* result (not the host's 8000-character
 *                  projection of it) upstream's 10 KiB threshold, its `isError`
 *                  rule and its reducer-receipt rule all apply exactly.
 *  - `turn_end`  - the per-turn economics record. It only ever appends a line to
 *                  its own ledger; it returns nothing at all, so it cannot
 *                  change a conversation even by accident.
 *
 * What it deliberately does not do:
 *
 *  - it registers no tool (the plugin's own manifest already contributes
 *    `obs_recall`, and the runtime refuses a name that is taken),
 *  - it never writes outside the plugin's data directory (resolved from
 *    `PI_DESKTOP_DATA_DIR`, and every path comes from `lib/paths.js`),
 *  - it never edits stored history: the projection is a per-request view, so a
 *    resumed or compacted session keeps its bytes,
 *  - it never fails the agent: every handler catches its own errors and returns
 *    the messages it was given, unchanged.
 *
 * The switch that matters is the same one the panel shows. `observationPack`
 * decides whether results are ever replaced and `turnMeasurement` whether a turn
 * is recorded at all; both are read from the plugin's stored settings on every
 * request, so flipping a switch in the panel takes effect on the next request
 * instead of the next reload.
 */

const { mkdir, readFile, stat, writeFile } = require("node:fs/promises");
const { dirname, join } = require("node:path");

const fusion = require("../lib/action-fusion.js");
const observation = require("../lib/observation-pack.js");
const paths = require("../lib/paths.js");
const configLib = require("../lib/config.js");
const metadata = require("../lib/metadata.js");
const { createSafeLedger } = require("../lib/ledger.js");

const ROUTE = "agent-extension";
const HOOK_LEDGER_EVENT = "turn";

/* ------------------------------------------------------------- environment */

/** Resolve one directory once, and reuse it: the host root cannot move. */
function createCache() {
  return { dataDir: null };
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The plugin's own data directory, found from what the host tells its sidecar.
 *
 * A hook module cannot call `pi.plugin.getDataPath()` - that API belongs to the
 * plugin process - so the same directory is derived from `PI_DESKTOP_DATA_DIR`.
 * A refusal here is not fatal: it means the hook route archives nothing, and it
 * says so instead of writing somewhere unexpected.
 */
async function resolveDataDir(env = process.env, cache = createCache()) {
  if (cache.dataDir) return cache.dataDir;
  const candidates = paths.dataDirCandidates(env);
  if (!candidates.length) {
    throw Object.assign(
      new Error(
        "PI_DESKTOP_DATA_DIR is not set, so the hook route cannot find the plugin's data directory.",
      ),
      { code: "NO_DATA_DIR" },
    );
  }
  let chosen = candidates[0];
  for (const candidate of candidates) {
    if (await isDirectory(join(candidate, "sessions"))) {
      chosen = candidate;
      break;
    }
  }
  cache.dataDir = chosen;
  return chosen;
}

/** The session id the archive is keyed by, from the first source that has one. */
function sessionIdFrom(ctx, event) {
  const values = [];
  try {
    values.push(ctx?.sessionManager?.getSessionId?.());
  } catch {
    // A context without a session manager is expected on some events; the
    // fallbacks below cover it.
  }
  values.push(event?.sessionId, ctx?.sessionId);
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * The settings the user sees in the panel, resolved by the same code the plugin's
 * tools use. The file is re-read on every request on purpose: a switch flipped in
 * the panel has to take effect immediately, and re-reading a small file is
 * cheaper than explaining why a mechanism kept running after it was turned off.
 *
 * An unreadable or invalid file is a refusal, not a default: guessing here would
 * decide to rewrite the user's context on no evidence.
 */
async function readConfig(dataDir) {
  let raw;
  try {
    raw = await readFile(join(dataDir, "settings.json"), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, config: configLib.defaultConfig() };
    return { ok: false, error: `SoL-Pi settings could not be read: ${error?.message ?? error}` };
  }
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `SoL-Pi settings are not valid JSON: ${error?.message ?? error}` };
  }
  return configLib.resolveConfig(stored);
}

/** Everything a handler needs, or a refusal with the reason. */
async function resolveArchive(ctx, event, cache) {
  const dataDir = await resolveDataDir(process.env, cache);
  const resolved = await readConfig(dataDir);
  if (!resolved.ok) throw Object.assign(new Error(resolved.error), { code: "SETTINGS_INVALID" });
  const sessionId = sessionIdFrom(ctx, event);
  return {
    dataDir,
    config: resolved.config,
    sessionId,
    bucket: paths.sessionBucket(sessionId),
    root: paths.sessionRoot(dataDir, sessionId),
  };
}

function ledgerFor(cache, root) {
  cache.ledgers ??= new Map();
  let ledger = cache.ledgers.get(root);
  if (!ledger) {
    ledger = createSafeLedger(paths.observationLedgerPath(root), (error) => {
      // Losing a log line must never cost the agent its observation.
      console.error(`[sol-pi-hooks] ledger write failed: ${error?.message ?? error}`);
    });
    cache.ledgers.set(root, ledger);
  }
  return ledger;
}

/**
 * The measurement ledger, deliberately apart from the observation ledger.
 *
 * Packing events belong with the plugin's own accounting (same file, same event
 * names, a different `route`), but a per-turn measurement is not an observation:
 * one file would let a turn record inflate the panel's packed/recalled counts.
 */
function measurementLedgerFor(cache, root) {
  cache.measurements ??= new Map();
  let ledger = cache.measurements.get(root);
  if (!ledger) {
    ledger = createSafeLedger(paths.hookLedgerPath(root), (error) => {
      // A lost measurement costs one line of accounting, never the conversation.
      console.error(`[sol-pi-hooks] measurement write failed: ${error?.message ?? error}`);
    });
    cache.measurements.set(root, ledger);
  }
  return ledger;
}

/* ---------------------------------------------------------------- measuring */

function textOfMessage(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .map((block) => (block?.type === "text" ? String(block.text ?? "") : "[non-text block]"))
    .join("\n");
}

/** What one provider request costs, measured from the messages it carries. */
function estimateMessages(messages) {
  let tokens = 0;
  let bytes = 0;
  for (const message of messages) {
    const text = textOfMessage(message);
    bytes += Buffer.byteLength(text, "utf8");
    tokens += observation.estimateTokens(text);
  }
  return { messages: messages.length, bytes, tokens };
}

/* --------------------------------------------------------------- projection */

/**
 * Upstream's loop, over the messages of one provider request.
 *
 * The counting rule is upstream's: how many provider requests a message has
 * already been part of is the number of assistant messages that follow it, with
 * the in-memory `sentCounts` map as the exact answer once this process has seen
 * the message itself. That combination is what makes the first `FULL_SENDS`
 * requests full and every later request a placeholder, even across a reload.
 */
async function projectMessages({ messages, root, sentCounts, ledger }) {
  const projected = [...messages];
  const priorAssistantCounts = new Array(messages.length);
  let assistantCount = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    priorAssistantCounts[index] = assistantCount;
    if (messages[index]?.role === "assistant") assistantCount += 1;
  }

  const requestIndex = assistantCount + 1;
  const tally = { packed: 0, archivedBytes: 0, tokensKeptOut: 0, replaced: [] };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!observation.isPureTextResult(message)) continue;

    try {
      const text = observation.textFromResult(message);
      // The port's one added guard, shared with obs_pack's scan: the marker a
      // fused call writes is the answer to "did my follow-up command run?", so a
      // mechanism must never be the reason the agent cannot read it.
      if (fusion.fusedThenRunResult(text, message.toolName)) continue;

      const created = observation.createObservation(
        { text, toolName: message.toolName, toolCallId: message.toolCallId },
        root,
      );
      if (!created) continue;
      await observation.ensureStored(created);

      const key = `${root}\0${created.id}`;
      const previousSends = sentCounts.get(key) ?? priorAssistantCounts[index] ?? 0;
      if (previousSends < observation.FULL_SENDS) {
        await ledger({
          event: "full",
          route: ROUTE,
          id: created.id,
          request: requestIndex,
          tool: created.toolName,
          originalBytes: created.bytes,
          originalLines: created.lines,
          originalTokens: created.tokens,
          contentHash: created.contentHash,
        });
        sentCounts.set(key, previousSends + 1);
        continue;
      }

      const placeholder = observation.placeholderFor(created);
      const placeholderTokens = observation.estimateTokens(placeholder);
      const removedTokens = Math.max(0, created.tokens - placeholderTokens);
      await ledger({
        event: "placeholder",
        route: ROUTE,
        id: created.id,
        request: requestIndex,
        sendNumber: previousSends + 1,
        tool: created.toolName,
        originalBytes: created.bytes,
        originalLines: created.lines,
        originalTokens: created.tokens,
        placeholderBytes: Buffer.byteLength(placeholder, "utf8"),
        placeholderTokens,
        removedTokens,
      });
      projected[index] = { ...message, content: [{ type: "text", text: placeholder }] };
      sentCounts.set(key, previousSends + 1);
      tally.packed += 1;
      tally.archivedBytes += created.bytes;
      tally.tokensKeptOut += removedTokens;
      tally.replaced.push(created.id);
    } catch (error) {
      // Fail open, exactly as upstream: a packing failure must never cost the
      // agent its observation.
      console.error(`[sol-pi-hooks] fail-open for a tool result: ${error?.message ?? error}`);
    }
  }

  return { projected, tally, requestIndex };
}

/* ------------------------------------------------------------------- status */

/**
 * Tell the panel which route is live.
 *
 * The status file is rewritten only when what it says would change, so a busy
 * session does not write it once per request. It is the honest answer to "are
 * the hooks running?": if the module was never loaded, the file is missing.
 */
async function writeStatus(cache, archive, extra = {}) {
  const payload = {
    route: ROUTE,
    pluginId: paths.PLUGIN_ID,
    version: metadata.VERSION,
    session_bucket: archive.bucket,
    threshold_bytes: observation.THRESHOLD_BYTES,
    full_sends: observation.FULL_SENDS,
    observationPack: archive.config.observationPack === true,
    turnMeasurement: archive.config.turnMeasurement === true,
    ...extra,
  };
  const comparable = JSON.stringify(payload);
  if (cache.status === comparable) return;
  cache.status = comparable;
  try {
    const body = `${JSON.stringify({ ...payload, at: new Date().toISOString() }, null, 2)}\n`;
    const target = paths.hookStatusPath(archive.root);
    // The bucket may not exist yet: in a fresh session this module can be the
    // first thing to write anything at all, and a status file that cannot be
    // created would cost the panel the one sentence it needs.
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, body, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    // A missing status file only costs the panel a sentence; never the agent.
    cache.status = null;
    console.error(`[sol-pi-hooks] status write failed: ${error?.message ?? error}`);
  }
}

/* --------------------------------------------------------------- the module */

/**
 * The factory the runtime calls once, with the agent-side ExtensionAPI.
 *
 * Returning early on an API that cannot register anything is deliberate: the
 * loader requires a function and would otherwise hand over an API this module
 * does not understand.
 */
function createAgentHooks(pi) {
  if (!pi || typeof pi.on !== "function") return;
  const cache = createCache();
  const sentCounts = new Map();
  const turnTallies = new Map();

  pi.on("context", async (event, ctx) => {
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    try {
      const archive = await resolveArchive(ctx, event, cache);
      await writeStatus(cache, archive);
      const ledger = ledgerFor(cache, archive.root);

      if (archive.config.observationPack !== true) {
        // Off means off: the messages go back exactly as they came in, and
        // nothing is archived or logged.
        return { messages: [...messages] };
      }

      const { projected, tally, requestIndex } = await projectMessages({
        messages,
        root: archive.root,
        sentCounts,
        ledger,
      });

      if (archive.config.turnMeasurement === true) {
        const previous = turnTallies.get(archive.root) ?? {
          requests: 0,
          packed: 0,
          archivedBytes: 0,
          tokensKeptOut: 0,
          observations: new Set(),
        };
        const cost = estimateMessages(messages);
        turnTallies.set(archive.root, {
          requests: previous.requests + 1,
          packed: previous.packed + tally.packed,
          archivedBytes: previous.archivedBytes + tally.archivedBytes,
          tokensKeptOut: previous.tokensKeptOut + tally.tokensKeptOut,
          observations: new Set([...previous.observations, ...tally.replaced]),
          lastRequest: requestIndex,
          contextMessages: cost.messages,
          contextBytes: cost.bytes,
          contextTokens: cost.tokens,
        });
      }

      return { messages: projected };
    } catch (error) {
      // Fail open: the agent gets the conversation it would have had anyway.
      console.error(`[sol-pi-hooks] context hook: ${error?.message ?? error}`);
      return { messages: [...messages] };
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
      const archive = await resolveArchive(ctx, event, cache);
      await writeStatus(cache, archive);
      if (archive.config.turnMeasurement !== true) return;

      const tally = turnTallies.get(archive.root);
      if (!tally || tally.requests === 0) return;
      turnTallies.delete(archive.root);

      await measurementLedgerFor(cache, archive.root)({
        event: HOOK_LEDGER_EVENT,
        route: ROUTE,
        turnId: typeof event?.turnId === "string" ? event.turnId : null,
        reason: typeof event?.reason === "string" ? event.reason : null,
        session_bucket: archive.bucket,
        requests: tally.requests,
        packed: tally.packed,
        observations: tally.observations.size,
        archived_bytes: tally.archivedBytes,
        tokens_kept_out: tally.tokensKeptOut,
        context_messages: tally.contextMessages ?? null,
        context_bytes: tally.contextBytes ?? null,
        context_tokens: tally.contextTokens ?? null,
      });
    } catch (error) {
      console.error(`[sol-pi-hooks] turn_end hook: ${error?.message ?? error}`);
    }
    // Nothing is returned on purpose: a measurement must not be able to change
    // the conversation, and the runtime replaces a result only when it gets one.
  });

  // The panel reads this to say which route is live, so write it as soon as the
  // module is loaded rather than waiting for a request that may never come.
  void (async () => {
    try {
      const archive = await resolveArchive(undefined, undefined, cache);
      await writeStatus(cache, archive, { announced: true });
    } catch (error) {
      console.error(`[sol-pi-hooks] announce: ${error?.message ?? error}`);
    }
  })();
}

createAgentHooks.default = createAgentHooks;
createAgentHooks.ROUTE = ROUTE;
createAgentHooks.HOOK_LEDGER_EVENT = HOOK_LEDGER_EVENT;
createAgentHooks.resolveDataDir = resolveDataDir;
createAgentHooks.readConfig = readConfig;
createAgentHooks.sessionIdFrom = sessionIdFrom;
createAgentHooks.estimateMessages = estimateMessages;
createAgentHooks.projectMessages = projectMessages;
createAgentHooks.createCache = createCache;

module.exports = createAgentHooks;