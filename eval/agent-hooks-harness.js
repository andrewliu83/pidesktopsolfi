"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * The hook route, exercised without the host.
 *
 * PI-Desktop loads `hooks/agent-hooks.js` inside its agent process and hands it an
 * ExtensionAPI with `on`. This harness does exactly that, with synthetic message
 * arrays shaped like the ones the host sends, and a temporary installation root so
 * every write lands somewhere that can be inspected and thrown away.
 *
 * What it is for: the projection is the one part of this plugin that can change a
 * request the model sees, so the rules have to be asserted rather than described -
 * the two full sends, the exact placeholder, the archive on disk, the switch that
 * ends it, the fused-call envelope that is never touched, and the per-turn record
 * that returns nothing at all.
 *
 * Every expectation is computed from the port's own library, never from a copy of
 * the text inside this file, so a harness that passes cannot diverge from the code
 * that runs.
 */

const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { basename, join, sep } = require("node:path");

const observation = require("../lib/observation-pack.js");
const paths = require("../lib/paths.js");
const tools = require("../lib/tools.js");

const SESSION_ID = "harness-session-1";
const PLUGIN_ROOT = join(__dirname, "..");

/** A result far over upstream's threshold, with lines to excerpt. */
const BIG_RESULT = Array.from(
  { length: 400 },
  (_, index) => `line ${index} of a result that is far too large to replay`,
).join("\n");

function loadModule() {
  // Required through the shipped path so the harness fails if the manifest ever
  // declares a module that is not there.
  return require(join(PLUGIN_ROOT, "hooks", "agent-hooks.js"));
}

function tick(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResult(text, extra = {}) {
  return {
    role: "toolResult",
    toolName: "bash",
    toolCallId: "call_big",
    content: [{ type: "text", text }],
    ...extra,
  };
}

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * One hook module, one temporary installation.
 *
 * `settings` is written to the file the plugin reads; omitting it leaves the file
 * absent, which is the "never configured" case and therefore the shipped defaults.
 */
async function withHooks(options, body) {
  const installRoot = mkdtempSync(join(tmpdir(), "sol-pi-hooks-"));
  const dataDir = join(installRoot, "plugins", "data", paths.PLUGIN_ID);
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  if (options?.settings !== undefined) {
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify(options.settings), "utf8");
  }

  const previous = process.env.PI_DESKTOP_DATA_DIR;
  if (options?.env === undefined) process.env.PI_DESKTOP_DATA_DIR = installRoot;
  else if (options.env === null) delete process.env.PI_DESKTOP_DATA_DIR;

  const accessed = new Set();
  const handlers = new Map();
  const pi = new Proxy(
    {},
    {
      get(_target, property) {
        accessed.add(String(property));
        if (property === "on") {
          return (name, handler) => {
            handlers.set(name, handler);
          };
        }
        return undefined;
      },
    },
  );

  const factory = loadModule();
  factory(pi);
  await tick();

  const root = paths.sessionRoot(dataDir, options?.sessionId ?? SESSION_ID);
  const ctx = { sessionManager: { getSessionId: () => options?.sessionId ?? SESSION_ID } };

  try {
    return await body({ factory, handlers, accessed, dataDir, installRoot, root, ctx });
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = previous;
    rmSync(installRoot, { recursive: true, force: true });
  }
}

/** The three provider requests upstream's rule is built around. */
function sendSession(handlers, ctx, result) {
  return [
    [userMessage("please run it"), result],
    [userMessage("please run it"), result, assistantMessage("ok")],
    [userMessage("please run it"), result, assistantMessage("ok"), userMessage("and again"), assistantMessage("sure")],
  ].map((messages) => ({ messages, ctx }));
}

async function run() {
  const checks = [];
  const add = async (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error?.message ?? error) });
    }
  };

  const expect = (condition, message) => {
    if (!condition) throw new Error(message);
  };

  await add("the module is the factory the runtime calls, and subscribes to exactly two events", async () => {
    const factory = loadModule();
    expect(typeof factory === "function", "the module must export the factory itself");
    expect(factory.default === factory, "its default export must be the same function");
    return await withHooks({}, async ({ handlers, accessed }) => {
      expect(
        JSON.stringify([...handlers.keys()]) === JSON.stringify(["context", "turn_end"]),
        `unexpected hooks: ${[...handlers.keys()].join(", ")}`,
      );
      expect(
        JSON.stringify([...accessed]) === JSON.stringify(["on"]),
        `the module touched API members it did not declare: ${[...accessed].join(", ")}`,
      );
      return "context + turn_end, nothing else on the API";
    });
  });

  await add("a large result is full for its first two sends, then exact-placeholder", async () => {
    return await withHooks({}, async ({ handlers, ctx, root, dataDir }) => {
      const context = handlers.get("context");
      const result = toolResult(BIG_RESULT);
      const sends = sendSession(handlers, ctx, result);

      const expected = observation.createObservation(
        { text: BIG_RESULT, toolName: "bash", toolCallId: "call_big" },
        root,
      );
      expect(expected, "the harness's own copy of the message must qualify as an observation");
      const placeholder = observation.placeholderFor(expected);

      const first = await context({ type: "context", messages: sends[0].messages }, ctx);
      expect(
        first.messages[1].content[0].text === BIG_RESULT,
        "the first send must carry the result in full",
      );

      const second = await context({ type: "context", messages: sends[1].messages }, ctx);
      expect(
        second.messages[1].content[0].text === BIG_RESULT,
        "the second send must still carry it in full",
      );

      const third = await context({ type: "context", messages: sends[2].messages }, ctx);
      expect(third.messages[1].content[0].text === placeholder, "the third send must be the placeholder");
      expect(
        third.messages[0].content[0].text === "please run it" &&
          third.messages[2].content[0].text === "ok" &&
          third.messages[4].content[0].text === "sure",
        "nothing but the oversized result may change",
      );
      expect(
        third.messages[3].content[0].text === "and again",
        "the messages around the result must survive untouched",
      );

      const objectPath = observation.observationPath(root, expected.id);
      expect(existsSync(objectPath), "the original bytes must be archived");
      expect(
        readFileSync(objectPath, "utf8") === BIG_RESULT,
        "the archive must be byte-for-byte the original",
      );
      expect(
        objectPath.startsWith(dataDir + sep),
        "every archive must live under this plugin's data directory",
      );

      const ledger = readJsonLines(paths.observationLedgerPath(root));
      const events = ledger.map((entry) => entry.event);
      expect(
        JSON.stringify(events) === JSON.stringify(["full", "full", "placeholder"]),
        `unexpected ledger: ${events.join(", ")}`,
      );
      const replacement = ledger[2];
      expect(replacement.id === expected.id, "the ledger must name the observation");
      expect(replacement.sendNumber === 3, `sendNumber must be 3, got ${replacement.sendNumber}`);
      expect(
        replacement.removedTokens === expected.tokens - observation.estimateTokens(placeholder),
        "the recorded saving must be the real difference",
      );
      expect(
        ledger.every((entry) => entry.route === "agent-extension"),
        "every hook-route entry must say which route wrote it",
      );

      // What the panel will read from the same file: three lines, one
      // observation. The saving is counted once, because re-counting every
      // placeholder would let a long session claim savings it never made.
      const totals = tools.summarizeObservations(ledger);
      expect(totals.observations === 1, `one observation must count once, got ${totals.observations}`);
      expect(totals.recalled === 0, "nothing has been recalled yet");
      expect(
        totals.archivedBytes === expected.bytes,
        `the archived size must be the original size, got ${totals.archivedBytes}`,
      );
      expect(
        totals.tokensKeptOut === expected.tokens - observation.estimateTokens(placeholder),
        `the saving must be counted once, got ${totals.tokensKeptOut}`,
      );
      expect(totals.items[0].route === "agent-extension", "the panel must attribute it to the hook route");

      // The tool route can pack the same text too, later and with its own saving
      // (same text, same id). The panel must still show one observation, and it
      // must report the first saving it recorded: adding a later one would let a
      // single observation claim bytes it never kept out.
      const repeated = {
        ...ledger[2],
        event: "pack",
        route: "tool",
        removedTokens: (expected.tokens - observation.estimateTokens(placeholder)) * 2,
      };
      const both = tools.summarizeObservations([...ledger, repeated]);
      expect(both.observations === 1, `one id must stay one observation, got ${both.observations}`);
      expect(
        both.tokensKeptOut === totals.tokensKeptOut,
        `a later saving must not change the total (${both.tokensKeptOut} vs ${totals.tokensKeptOut})`,
      );
      return `full x2 then placeholder (${replacement.removedTokens} tokens kept out)`;
    });
  });

  await add("a resumed session is projected too: the count survives a restart", async () => {
    // The rule upstream relies on when its own memory is empty: how many assistant
    // messages follow the result. A fresh process must still replace it.
    return await withHooks({}, async ({ handlers, ctx }) => {
      const result = toolResult(BIG_RESULT);
      const messages = [
        userMessage("please run it"),
        result,
        assistantMessage("ok"),
        userMessage("and again"),
        assistantMessage("sure"),
      ];
      const projected = await handlers.get("context")({ type: "context", messages }, ctx);
      expect(
        projected.messages[1].content[0].text.includes("[large tool result replaced"),
        "a process that never saw the first sends must still replace the result",
      );
      return "replaced from the assistant count alone";
    });
  });

  await add("only plain text results are ever touched", async () => {
    return await withHooks({}, async ({ handlers, ctx }) => {
      const context = handlers.get("context");
      const small = toolResult("a short note");
      const failed = toolResult(BIG_RESULT, { isError: true });
      const image = {
        role: "toolResult",
        toolName: "screenshot",
        toolCallId: "call_img",
        content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      };
      const fused = toolResult(`${BIG_RESULT}\n[then_run:succeeded]`, { toolName: "fused_edit" });
      const markerOnly = toolResult(`${BIG_RESULT}\n[then_run:failed]`, { toolName: "bash" });
      const messages = [
        userMessage("go"),
        small,
        assistantMessage("a"),
        failed,
        assistantMessage("b"),
        image,
        assistantMessage("c"),
        fused,
        assistantMessage("d"),
        markerOnly,
        assistantMessage("e"),
        {
          role: "system",
          content: [{ type: "text", text: "a system note that is far too long to be an observation" }],
        },
      ];
      const projected = await context({ type: "context", messages }, ctx);
      expect(
        projected.messages[1].content[0].text === "a short note",
        "a result under the 10 KiB threshold must be left alone",
      );
      expect(projected.messages[3].content[0].text === BIG_RESULT, "a failed result must be left alone");
      expect(
        projected.messages[5].content[0].type === "image",
        "a result carrying a non-text block must be left alone",
      );
      expect(
        projected.messages[7].content[0].text.startsWith(BIG_RESULT),
        "a fused call's own result must be left alone: the [then_run:…] marker is the answer",
      );
      expect(
        projected.messages[9].content[0].text.startsWith(BIG_RESULT),
        "any result carrying a [then_run:…] marker must be left alone",
      );
      expect(
        projected.messages[11].content[0].text.startsWith("a system note"),
        "only tool results participate",
      );
      return "5 ineligible messages, all untouched";
    });
  });

  await add("switching packing off returns the messages byte-identical and archives nothing", async () => {
    return await withHooks({ settings: { observationPack: false, turnMeasurement: true } }, async ({ handlers, ctx, root }) => {
      const result = toolResult(BIG_RESULT);
      const messages = [
        userMessage("please run it"),
        result,
        assistantMessage("ok"),
        userMessage("and again"),
        assistantMessage("sure"),
      ];
      const before = JSON.stringify(messages);
      const projected = await handlers.get("context")({ type: "context", messages }, ctx);
      expect(JSON.stringify(projected.messages) === before, "the messages must come back unchanged");
      expect(
        !existsSync(paths.observationLedgerPath(root)),
        "nothing may be logged while packing is off",
      );
      expect(!existsSync(paths.observationDir(root)), "nothing may be archived while packing is off");
      return "identical messages, no archive, no ledger";
    });
  });

  await add("an unreadable settings file is a refusal, never a silent default", async () => {
    return await withHooks({ settings: "not json at all" }, async ({ handlers, ctx }) => {
      const messages = [userMessage("please run it"), toolResult(BIG_RESULT), assistantMessage("ok"), assistantMessage("sure")];
      const before = JSON.stringify(messages);
      const projected = await handlers.get("context")({ type: "context", messages }, ctx);
      expect(JSON.stringify(projected.messages) === before, "a broken settings file must change nothing");
      return "left alone, with the reason logged";
    });
  });

  await add("without a data directory the hook route degrades instead of throwing", async () => {
    return await withHooks({ env: null }, async ({ handlers, ctx }) => {
      const messages = [userMessage("please run it"), toolResult(BIG_RESULT), assistantMessage("ok"), assistantMessage("sure")];
      const before = JSON.stringify(messages);
      const projected = await handlers.get("context")({ type: "context", messages }, ctx);
      expect(JSON.stringify(projected.messages) === before, "no data directory means nothing is rewritten");
      const turn = await handlers.get("turn_end")({ type: "turn_end", turnId: "t1", reason: "done" }, ctx);
      expect(turn === undefined, "the measurement hook returns nothing, ever");
      return "returned the conversation it was given";
    });
  });

  await add("the per-turn record is written once per turn, and returns nothing", async () => {
    return await withHooks({}, async ({ handlers, ctx, root }) => {
      const context = handlers.get("context");
      const turnEnd = handlers.get("turn_end");
      const result = toolResult(BIG_RESULT);
      const sends = sendSession(handlers, ctx, result);
      await context({ type: "context", messages: sends[0].messages }, ctx);
      await context({ type: "context", messages: sends[1].messages }, ctx);
      const returned = await turnEnd({ type: "turn_end", turnId: "turn-1", reason: "stop" }, ctx);
      expect(returned === undefined, "the measurement must not be able to change the conversation");

      const lines = readJsonLines(paths.hookLedgerPath(root));
      expect(lines.length === 1, `expected one measurement, got ${lines.length}`);
      const entry = lines[0];
      expect(entry.event === "turn", "the ledger must be a turn record");
      expect(entry.requests === 2, `requests must be 2, got ${entry.requests}`);
      expect(entry.turnId === "turn-1" && entry.reason === "stop", "the turn identity must be recorded");
      expect(entry.context_messages === sends[1].messages.length, "the context size must be measured");
      expect(entry.context_tokens > 0, "a token estimate must be recorded");
      expect(typeof entry.tokens_kept_out === "number", "the savings so far must be recorded");
      expect(
        JSON.stringify(entry).includes(BIG_RESULT) === false,
        "the record must never contain the payload it measured",
      );

      // A second turn without a request writes nothing, and the first line is not
      // repeated: the books close on every turn.
      await turnEnd({ type: "turn_end", turnId: "turn-1", reason: "stop" }, ctx);
      expect(readJsonLines(paths.hookLedgerPath(root)).length === 1, "an empty turn writes nothing");
      return "one line per turn, no payload, stable across an empty turn";
    });
  });

  await add("switching the measurement off writes nothing", async () => {
    return await withHooks({ settings: { turnMeasurement: false } }, async ({ handlers, ctx, root }) => {
      const context = handlers.get("context");
      const turnEnd = handlers.get("turn_end");
      const result = toolResult(BIG_RESULT);
      const sends = sendSession(handlers, ctx, result);
      await context({ type: "context", messages: sends[0].messages }, ctx);
      await context({ type: "context", messages: sends[1].messages }, ctx);
      await turnEnd({ type: "turn_end", turnId: "turn-1", reason: "stop" }, ctx);
      expect(!existsSync(paths.hookLedgerPath(root)), "nothing may be measured while the switch is off");
      // Packing is independent of the measurement and must still have happened.
      expect(
        readJsonLines(paths.observationLedgerPath(root)).length === 2,
        "the two full sends must still be archived",
      );
      return "measurement off, packing unaffected";
    });
  });

  await add("the status file says which route is live, and the panel can read it", async () => {
    return await withHooks({}, async ({ root, dataDir, handlers, ctx }) => {
      expect(
        basename(root) !== "shared",
        "the harness must exercise a real session bucket, not the announcement one",
      );

      // At load time no session is known, so the module's announcement lands in
      // `shared`. That file is the panel's evidence that the route ran at all.
      const sharedRoot = join(dataDir, "sessions", "shared");
      const statusPath = paths.hookStatusPath(sharedRoot);
      expect(existsSync(statusPath), "the module must announce itself when it loads");
      const status = JSON.parse(readFileSync(statusPath, "utf8"));
      expect(status.route === "agent-extension", `unexpected route ${status.route}`);
      expect(status.pluginId === paths.PLUGIN_ID, "the status must name this plugin");
      expect(typeof status.version === "string" && status.version.length > 0, "the version must be recorded");
      expect(status.observationPack === true, "the shipped default must be visible to the panel");
      expect(status.turnMeasurement === true, "the shipped default must be visible to the panel");
      expect(status.threshold_bytes === observation.THRESHOLD_BYTES, "the threshold must be stated");
      expect(status.full_sends === observation.FULL_SENDS, "the replay rule must be stated");
      expect(status.announced === true, "the load-time file must say it is an announcement");
      expect(
        statusPath.startsWith(dataDir + sep),
        "the status file must live under this plugin's data directory",
      );

      // A session that has not sent anything reads as "loaded", not "live": the
      // panel may not claim a route served a request it never saw.
      const before = await tools.hookRouteState({}, root);
      expect(before.live === false && before.announced === true, "an unserved session must not read as live");
      expect(before.status_bucket === "shared", `expected the shared bucket, got ${before.status_bucket}`);

      // One request through the hook, and this session has a status of its own.
      await handlers.get("context")({ type: "context", messages: [userMessage("hi")] }, ctx);
      const ownPath = paths.hookStatusPath(root);
      expect(existsSync(ownPath), "a served session must have its own status");
      expect(
        JSON.parse(readFileSync(ownPath, "utf8")).announced === undefined,
        "only the announcement carries that flag",
      );
      const after = await tools.hookRouteState({}, root);
      expect(after.live === true, "a served session must read as live");
      expect(after.status_bucket === basename(root), `expected ${basename(root)}, got ${after.status_bucket}`);
      return `announced in shared, live in ${basename(root)}`;
    });
  });

  return checks;
}

module.exports = { run, BIG_RESULT, SESSION_ID, PLUGIN_ROOT };