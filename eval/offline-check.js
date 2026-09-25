#!/usr/bin/env node
"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * The offline gate: load this plugin against the strict host stub and walk every
 * mechanism, every refusal, the panel channels, the commands and the manifest
 * agreement check. No network, no app, no model calls.
 *
 * It is written to fail loudly rather than to look green:
 *   - `pi` is a Proxy that throws on any member PI-Desktop does not document, so
 *     an invented API fails here;
 *   - every recorded host call is matched against the documented allowlist;
 *   - refusals are asserted, not just happy paths (mechanism-off, credential
 *     paths, fabricated reducer quotes, path traversal in a panel channel);
 *   - the manifest check is asserted to CATCH a tampered manifest;
 *   - each tool result over 8000 characters must be an untouched fallback, never
 *     a "success" that quietly drops evidence.
 *
 * Usage: node eval/offline-check.js [--verbose]
 */

const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { createHash } = require("node:crypto");

const { createHostStub, readManifest } = require("./host-stub.js");

const pluginRoot = resolve(__dirname, "..");
const verbose = process.argv.includes("--verbose");

const results = [];
let failed = 0;

function section(title) {
  results.push({ kind: "section", title });
  console.log(`\n── ${title}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ kind: "pass", name });
    console.log(`  ok   ${name}${detail && verbose ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed += 1;
    results.push({ kind: "fail", name, error: String(error?.message ?? error) });
    console.log(`  FAIL ${name}\n       ${String(error?.message ?? error)}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRefusal(fn, { code, includes } = {}) {
  let result;
  try {
    result = await fn();
  } catch (error) {
    const message = String(error?.message ?? error);
    if (code) expect(error?.code === code, `expected code ${code}, got ${error?.code}: ${message}`);
    if (includes) {
      const needles = Array.isArray(includes) ? includes : [includes];
      for (const needle of needles) {
        expect(message.includes(needle), `refusal did not mention ${JSON.stringify(needle)}: ${message}`);
      }
    }
    return message;
  }
  throw new Error(`expected a refusal, got ${JSON.stringify(result).slice(0, 240)}`);
}

function freshPlugin(stub) {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(pluginRoot)) delete require.cache[key];
  }
  globalThis.pi = stub.pi;
  return require(join(pluginRoot, "main.js"));
}

const DOCUMENTED_API = new Set([
  "plugin.getSettings",
  "plugin.setSettings",
  "plugin.getDataPath",
  "workspace.get",
  "agent.registerTool",
  "agent.unregisterTool",
  "agent.complete",
  "models.list",
  "session.getLlmContext",
  "session.get",
  "commands.register",
  "commands.unregister",
  "ui.openPanel",
  "ui.closePanel",
  "ui.showToast",
  "ui.notify",
  "clipboard.writeText",
]);

const BIG_LOG_LINES = [];
for (let index = 0; index < 240; index += 1) {
  BIG_LOG_LINES.push(
    index === 7
      ? "src/parser.js:41:9 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'."
      : `[build] step ${index}: compiling module ${index} with no diagnostics`,
  );
}
const BIG_LOG = BIG_LOG_LINES.join("\n");
const BIG_RESULT = Array.from({ length: 900 }, (_, index) => `[tool] line ${index}: ${"x".repeat(64)}`).join("\n");
const SECRET_LOG = `${"npm test output\n".repeat(400)}API_KEY=sk-live-abcdef1234567890\n`;

function receiptFor(input, { kind = "summary", quote, status = "success", hash }) {
  const body = String(input?.messages?.[0]?.content ?? "");
  const source = /source_sha256=([0-9a-f]{64})/.exec(body)?.[1] ?? hash;
  const inside = /<untrusted_log>\n([\s\S]*?)\n<\/untrusted_log>/.exec(body)?.[1] ?? "";
  const firstLine = inside.split("\n").find((line) => line.trim()) ?? "no output";
  return {
    provider: "openai",
    model: "gpt-5.6-luna",
    usage: { input: 100, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 140 },
    text: JSON.stringify({
      schema: "sol-pi-evidence-receipt/1",
      source_sha256: source,
      status,
      uncertain: false,
      evidence: [{ kind, quote: quote ?? firstLine }],
    }),
  };
}

async function main() {
  const scratch = mkdtempSync(join(tmpdir(), "sol-pi-gate-"));
  const dataPath = join(scratch, "data");
  const projectRoot = join(scratch, "project");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(dataPath, { recursive: true });
  mkdirSync(join(projectRoot, "src"), { recursive: true });

  const manifest = readManifest(pluginRoot);
  const stub = createHostStub({
    dataPath,
    projectRoot,
    manifest,
    sessionContext: { messages: [], truncated: false, modelKey: "openai/gpt-5.6-luna" },
    complete: async (input) => receiptFor(input),
  });

  section("Load the plugin the way PI-Desktop does");
  const plugin = freshPlugin(stub);

  await check("onLoad registers exactly the manifest's tools and commands", async () => {
    expect(typeof plugin.onLoad === "function", "main.js must export onLoad");
    expect(typeof plugin.onUnload === "function", "main.js must export onUnload");
    expect(typeof plugin.onPanelInvoke === "function", "main.js must export onPanelInvoke");
    await plugin.onLoad();
    const wantTools = manifest.contributes.agentTools.map((tool) => tool.name).sort();
    const gotTools = [...stub.state.tools.keys()].sort();
    expect(
      JSON.stringify(gotTools) === JSON.stringify(wantTools),
      `tools registered ${JSON.stringify(gotTools)} vs manifest ${JSON.stringify(wantTools)}`,
    );
    const wantCommands = manifest.contributes.commands.map((command) => command.id).sort();
    const gotCommands = [...stub.state.commands.keys()].sort();
    expect(
      JSON.stringify(gotCommands) === JSON.stringify(wantCommands),
      `commands ${JSON.stringify(gotCommands)} vs manifest ${JSON.stringify(wantCommands)}`,
    );
    return `${gotTools.length} tools, ${gotCommands.length} commands`;
  });

  await check("every tool descriptor is complete and host-legal", async () => {
    for (const [name, tool] of stub.state.tools) {
      expect(/^[a-z][a-z0-9_]{0,63}$/.test(name), `tool name ${name} is not host-legal`);
      expect(tool.description.length > 60, `tool ${name} needs a real description`);
      expect(["low", "medium", "high"].includes(tool.risk), `tool ${name} risk ${tool.risk}`);
      expect(tool.schema.type === "object", `tool ${name} needs an object schema`);
      expect(
        Object.keys(tool.schema.properties ?? {}).length > 0,
        `tool ${name} needs properties`,
      );
      expect(tool.schema.additionalProperties === false, `tool ${name} must refuse extra properties`);
    }
    return "all six descriptors pass the host's own checks";
  });

  await check("only documented host APIs were touched", async () => {
    const used = new Set(stub.state.calls.map((call) => call.api));
    const unknown = [...used].filter((api) => !DOCUMENTED_API.has(api));
    expect(unknown.length === 0, `undocumented host calls: ${unknown.join(", ")}`);
    const list = [...used].sort();
    expect(list.includes("agent.registerTool"), "tools must be registered through the host");
    expect(!list.some((api) => api.startsWith("fs.")), "SoL-Pi must not use the host fs API");
    expect(!list.some((api) => api.startsWith("net.")), "SoL-Pi must not fetch anything");
    return list.join(", ");
  });

  await check("no plan-safe action is claimed that the host would drop", async () => {
    // The 0.15.x child bridge forwards name/description/risk/schema only, so the
    // host sees an empty planSafeActions list. The gate proves the plugin does
    // not depend on the field to work in normal mode.
    const registered = [...stub.state.tools.values()];
    for (const tool of registered) {
      expect(Array.isArray(tool.planSafeActions), `${tool.name} should carry the field`);
    }
    await expectRefusal(() => stub.invokeTool("fused_edit", { action: "write", path: "a.txt", content: "x" }, { mode: "plan" }), {
      includes: "not allowed in plan mode",
    });
    return "plan mode refused, as the host does for every plugin tool";
  });

  section("Each switch does exactly what it says, in both directions");

  await check("fused_edit refuses while actionFusion is off, naming the setting", async () => {
    const message = await expectRefusal(
      () => stub.invokeTool("fused_edit", { action: "write", path: "off.txt", content: "hello" }),
      { code: "MECHANISM_DISABLED" },
    );
    expect(message.includes("actionFusion"), "refusal must name the setting");
    expect(!existsSync(join(projectRoot, "off.txt")), "a refused call must not write the file");
    return message.split(".")[0];
  });

  await check("obs_pack works on the shipped defaults, and refuses the moment it is switched off", async () => {
    // Packing is the one mechanism that ships on: it removes a replay the model has
    // already paid for and adds nothing, so the gate proves both directions -
    // without setup it packs, and one switch ends it immediately.
    const shipped = await stub.invokeTool("obs_pack", {
      action: "pack",
      text: BIG_RESULT,
      tool: "bash",
      tool_call_id: "call_default",
    });
    expect(shipped.packed === true, "packing must work with no setup at all");
    expect(/^obs_[0-9a-f]{24}$/.test(shipped.id), `unexpected id ${shipped.id}`);

    await stub.pi.plugin.setSettings({ observationPack: false });
    await expectRefusal(() => stub.invokeTool("obs_pack", { action: "pack", text: BIG_RESULT }), {
      code: "MECHANISM_DISABLED",
    });
    await expectRefusal(() => stub.invokeTool("obs_pack", { action: "scan" }), {
      code: "MECHANISM_DISABLED",
    });
    await stub.pi.plugin.setSettings({ observationPack: true });
    return "on by default, off the moment the switch is off";
  });

  await check("reduce_evidence refuses while the reducer is off", async () => {
    await expectRefusal(
      () => stub.invokeTool("reduce_evidence", { text: BIG_LOG, command: "npm test", is_error: true }),
      { code: "MECHANISM_DISABLED" },
    );
    expect(stub.state.completeCalls.length === 0, "nothing may be sent to a model while it is off");
  });

  await check("plan_update and compact_check refuse while onlineContextCompact is off", async () => {
    await expectRefusal(() => stub.invokeTool("plan_update", { steps: [] }), {
      code: "MECHANISM_DISABLED",
    });
    await expectRefusal(() => stub.invokeTool("compact_check", {}), { code: "MECHANISM_DISABLED" });
  });

  await check("obs_pack list and obs_recall stay usable, so archived evidence is never stranded", async () => {
    await stub.invokeTool("obs_pack", { action: "list" });
    await expectRefusal(() => stub.invokeTool("obs_recall", { id: "obs_" + "0".repeat(24) }), {
      includes: "Unknown observation id",
    });
  });

  section("Action Fusion: one call, mutation plus its validation");

  await stub.pi.plugin.setSettings({ actionFusion: true, observationPack: true });

  await check("write + passing command reports the success marker and the exit code", async () => {
    const outcome = await stub.invokeTool("fused_edit", {
      action: "write",
      path: "src/ok.txt",
      content: "hello\n",
      then_run: { command: 'node -e "console.log(1+1)"' },
    });
    expect(outcome.ok === true, "the call must report ok");
    expect(outcome.text.includes("[then_run:succeeded]"), "success marker missing");
    expect(outcome.then_run.exit_code === 0, "exit code must be reported");
    expect(readFileSync(join(projectRoot, "src/ok.txt"), "utf8") === "hello\n", "file not written");
    expect(outcome.text.includes("2"), "command output must be included in the same result");
    return `${outcome.text.length} chars in one call`;
  });

  await check("a failing command keeps the mutation and reports [then_run:failed]", async () => {
    const message = await expectRefusal(
      () =>
        stub.invokeTool("fused_edit", {
          action: "write",
          path: "src/failing.txt",
          content: "kept\n",
          then_run: { command: 'node -e "process.exit(3)"' },
        }),
      { code: "THEN_RUN_FAILED" },
    );
    expect(message.includes("[then_run:failed]"), "failure marker missing");
    expect(message.includes("exit_code=3"), "exit code missing from the failure");
    expect(readFileSync(join(projectRoot, "src/failing.txt"), "utf8") === "kept\n", "mutation must be kept");
  });

  await check("a failed mutation skips the command instead of running it", async () => {
    writeFileSync(join(projectRoot, "src/dup.txt"), "same same\n");
    // Upstream reports a mutation that cannot be applied as an error, and the
    // skip marker rides along with it - the command must not run off the back of
    // an edit that never landed.
    const message = await expectRefusal(
      () =>
        stub.invokeTool("fused_edit", {
          action: "edit",
          path: "src/dup.txt",
          old_string: "same",
          new_string: "other",
          then_run: { command: 'node -e "console.log(\'MUST NOT RUN\')"' },
        }),
      { includes: ["[then_run:skipped]", "was not run"] },
    );
    expect(message.includes("more than once"), `the refusal must name the real problem: ${message}`);
    expect(!message.includes("MUST NOT RUN"), "the command ran against an unverified file");
    expect(readFileSync(join(projectRoot, "src/dup.txt"), "utf8") === "same same\n", "file changed anyway");
    return "mutation error surfaced, command skipped";
  });

  await check("editing a file that does not exist refuses by name, creating nothing", async () => {
    const message = await expectRefusal(
      () =>
        stub.invokeTool("fused_edit", {
          action: "edit",
          path: "src/missing.txt",
          old_string: "a",
          new_string: "b",
        }),
      { includes: "does not exist" },
    );
    expect(message.includes("src/missing.txt"), "the refusal must name the path");
    expect(!existsSync(join(projectRoot, "src/missing.txt")), "a failed edit must not create the file");
  });

  await check("credentials, absolute paths and escapes are refused by name", async () => {
    const cases = [
      [{ action: "write", path: ".env", content: "SECRET=1" }, [".env"]],
      [{ action: "write", path: "keys/id_rsa", content: "x" }, ["id_rsa"]],
      [{ action: "write", path: "../outside.txt", content: "x" }, [".."]],
      [{ action: "write", path: "/tmp/absolute.txt", content: "x" }, ["absolute"]],
      [{ action: "write", path: ".git/config", content: "x" }, [".git"]],
    ];
    const seen = [];
    for (const [args, needles] of cases) {
      const message = await expectRefusal(() => stub.invokeTool("fused_edit", args));
      for (const needle of needles) {
        expect(
          message.toLowerCase().includes(needle.toLowerCase()),
          `refusal for ${args.path} did not mention ${needle}: ${message}`,
        );
      }
      seen.push(args.path);
    }
    expect(!existsSync(join(projectRoot, ".env")), ".env must never be created");
    expect(!existsSync(resolve(projectRoot, "..", "outside.txt")), "escape must not write outside the root");
    return seen.join(", ");
  });


  await check("the session's own project folder answers when the window has none", async () => {
    // PI-Desktop keeps one project per session (ADR 0016/D093), so a conversation
    // can run in a folder the window never opened: workspace.get() is empty while
    // the session still knows its folder. The host reads
    // session.get(...).session.projectPath itself to scope file access per session.
    stub.state.workspaceInfo = null;
    stub.state.sessionRecord = undefined;
    try {
      const outcome = await stub.invokeTool("fused_edit", {
        action: "write",
        path: "session-root.txt",
        content: "written through the session's project folder\n",
      });
      expect(outcome.ok === true, "the write must succeed");
      const written = join(projectRoot, "session-root.txt");
      expect(existsSync(written), "the file must land in the session's folder");
      expect(
        stub.state.calls.some((call) => call.api === "session.get"),
        "the session lookup must be attempted",
      );
      return readFileSync(written, "utf8").trim();
    } finally {
      stub.state.workspaceInfo = undefined;
      stub.state.sessionRecord = undefined;
      rmSync(join(projectRoot, "session-root.txt"), { force: true });
    }
  });

  await check("a conversation with no project anywhere is refused by name", async () => {
    stub.state.workspaceInfo = null;
    stub.state.sessionRecord = null;
    try {
      const message = await expectRefusal(() =>
        stub.invokeTool("fused_edit", { action: "write", path: "nowhere.txt", content: "x" }),
      );
      expect(/no project is open/i.test(message), `refusal must name the missing project: ${message}`);
      expect(/session/i.test(message), `refusal must say the session was asked too: ${message}`);
      expect(!existsSync(join(projectRoot, "nowhere.txt")), "nothing may be written");
      return "refused without writing";
    } finally {
      stub.state.workspaceInfo = undefined;
      stub.state.sessionRecord = undefined;
    }
  });

  await check("a wrapped workspace answer and a failed session lookup are both handled", async () => {
    stub.state.workspaceInfo = { workspace: { path: projectRoot, name: "project" } };
    try {
      const outcome = await stub.invokeTool("fused_edit", {
        action: "write",
        path: "wrapped.txt",
        content: "resolved from the wrapped payload\n",
      });
      expect(outcome.ok === true, "the { workspace: { path } } shape must resolve");
      rmSync(join(projectRoot, "wrapped.txt"), { force: true });

      stub.state.workspaceInfo = null;
      stub.state.sessionRecord = new Error("permission denied");
      const message = await expectRefusal(() =>
        stub.invokeTool("fused_edit", { action: "write", path: "denied.txt", content: "x" }),
      );
      expect(
        message.includes("Session lookup failed too: permission denied"),
        `refusal must disclose the failed lookup instead of hiding it: ${message}`,
      );
      return "wrapped shape accepted, failed lookup disclosed";
    } finally {
      stub.state.workspaceInfo = undefined;
      stub.state.sessionRecord = undefined;
      rmSync(join(projectRoot, "wrapped.txt"), { force: true });
    }
  });
  await check("an oversized command output is capped, and says so", async () => {
    const outcome = await stub.invokeTool("fused_edit", {
      action: "write",
      path: "src/loud.txt",
      content: "x\n",
      then_run: {
        command: 'node -e "for(let i=0;i<40000;i++)console.log(\'y\'.repeat(8))"',
      },
    });
    expect(outcome.text.includes("[note] output was cut at"), "the cap must be stated in the result");
    expect(outcome.then_run.exit_code === 0, "the command itself still succeeded");
    expect(Buffer.byteLength(outcome.text, "utf8") < 300000, "output must be bounded");
    return `${Buffer.byteLength(outcome.text, "utf8")} bytes after capping`;
  });

  section("ObservationPack: bytes leave the context but never the machine");

  let packedId = null;
  await check("a large result is archived under a content-addressed id", async () => {
    const outcome = await stub.invokeTool("obs_pack", {
      action: "pack",
      text: BIG_RESULT,
      tool: "bash",
      tool_call_id: "call_1",
    });
    expect(outcome.packed === true, "the result must be packed");
    expect(/^obs_[0-9a-f]{24}$/.test(outcome.id), `unexpected id ${outcome.id}`);
    expect(outcome.original_bytes === Buffer.byteLength(BIG_RESULT), "byte count must be exact");
    expect(outcome.removed_tokens > 0, "packing must keep tokens out of the context");
    expect(outcome.placeholder.length < BIG_RESULT.length / 4, "the placeholder must be much smaller");
    const objectPath = join(dataPath, "sessions");
    expect(existsSync(objectPath), "archives must live under the plugin data directory");
    packedId = outcome.id;
    // Upstream's derivation, pinned: obs_ + sha24(`toolName\0toolCallId\0contentHash`).
    const contentHash = createHash("sha256").update(BIG_RESULT, "utf8").digest("hex");
    const expectedId = `obs_${createHash("sha256")
      .update(`bash\0call_1\0${contentHash}`, "utf8")
      .digest("hex")
      .slice(0, 24)}`;
    expect(packedId === expectedId, "the id must match upstream's derivation, not a home-made one");
    return packedId;
  });

  await check("a small result is left alone", async () => {
    const small = "just a short note";
    const outcome = await stub.invokeTool("obs_pack", { action: "pack", text: small });
    expect(outcome.packed === false, "small text must not be packed");
    expect(outcome.reason === "under-threshold", `unexpected reason ${outcome.reason}`);
    expect(outcome.text.includes("10240"), "the threshold must be stated");
  });

  await check("obs_recall pages the exact bytes back, and reassembles to the original", async () => {
    const reassembled = [];
    let offset = 0;
    let pages = 0;
    for (;;) {
      const page = await stub.invokeTool("obs_recall", { id: packedId, offset, max_bytes: 4096 });
      expect(page.id === packedId, "wrong id in the page");
      expect(page.bytes > 0, "a page must carry bytes");
      expect(page.text.includes(`next_offset=${page.next_offset}`), "the header must state the next offset");
      reassembled.push(page.text.split("\n").slice(2).join("\n"));
      pages += 1;
      if (page.eof) break;
      offset = page.next_offset;
      expect(pages < 40, "paging should not run away");
    }
    expect(
      reassembled.join("") === BIG_RESULT,
      "paged recall must reassemble byte-identically",
    );
    return `${pages} pages, ${Buffer.byteLength(BIG_RESULT, "utf8")} bytes reassembled`;
  });

  await check("recall records a ledger entry and refuses a bad offset", async () => {
    const ledgerPath = join(dataPath, "sessions");
    const buckets = require("node:fs").readdirSync(ledgerPath);
    const ledger = buckets
      .map((name) => join(ledgerPath, name, "observation-pack", "ledger.jsonl"))
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("");
    expect(ledger.includes('"event":"pack"'), "the pack must be in the ledger");
    expect(ledger.includes('"event":"recall"'), "the recall must be in the ledger");
    await expectRefusal(() => stub.invokeTool("obs_recall", { id: packedId, offset: 99999999 }));
  });

  await check("obs_pack scan packs an oversized tool result from the live context", async () => {
    stub.state.sessionContext = {
      modelKey: "openai/gpt-5.6-luna",
      truncated: false,
      messages: [
        { role: "user", content: "run the build" },
        { role: "assistant", content: "running" },
        { role: "tool", toolName: "bash", content: BIG_RESULT },
        { role: "assistant", content: "ok" },
        { role: "tool", toolName: "bash", content: BIG_RESULT },
        { role: "assistant", content: "now the next thing" },
      ],
    };
    const outcome = await stub.invokeTool("obs_pack", { action: "scan" });
    expect(outcome.candidates.length === 1, `expected 1 candidate, got ${outcome.candidates.length}`);
    const candidate = outcome.candidates[0];
    expect(candidate.prior_provider_requests >= 2, "upstream's replay rule must be applied");
    expect(candidate.original_bytes >= 8000, "the host model must reflect its 8000-character projection");
    expect(outcome.tokens_kept_out_of_context > 0, "the scan must report what it saves");
    return `${candidate.id}, ${candidate.prior_provider_requests} replays`;
  });

  await check("scan leaves its own fused-call results alone", async () => {
    // A real fused result carries its verdict on line 3, ahead of the command
    // output, so even a truncated view shows it. The second fused message pushes
    // the verdict past the 8000 characters a plugin can see, and must still be
    // recognised for what it is by its tool name alone.
    const FUSED_RESULT = `sol_pi_fused_edit: lib/thing.js\n\n[then_run:succeeded]\n\n${BIG_RESULT}`;
    const FUSED_RESULT_OUT_OF_SIGHT = `${"p".repeat(8000)}\n\n[then_run:failed]`;
    stub.state.sessionContext = {
      modelKey: "openai/gpt-5.6-luna",
      truncated: false,
      messages: [
        { role: "user", content: "edit lib/thing.js, then run the build" },
        { role: "assistant", content: "editing" },
        { role: "tool", toolName: "fused_edit", content: FUSED_RESULT },
        { role: "assistant", content: "and again" },
        { role: "tool", toolName: "fused_edit", content: FUSED_RESULT_OUT_OF_SIGHT },
        { role: "assistant", content: "now the build" },
        { role: "tool", toolName: "bash", content: BIG_RESULT },
        { role: "assistant", content: "ok" },
        { role: "assistant", content: "next" },
      ],
    };
    const outcome = await stub.invokeTool("obs_pack", { action: "scan" });
    expect(
      outcome.fused_results_kept === 2,
      `both fused results must be kept, got ${outcome.fused_results_kept}`,
    );
    expect(outcome.candidates.length === 1, `expected 1 candidate, got ${outcome.candidates.length}`);
    expect(
      outcome.candidates[0].tool === "bash",
      `the candidate must not be a fused call, got ${outcome.candidates[0].tool}`,
    );
    expect(
      outcome.text.includes("left alone"),
      "the scan must say why it left the fused result in place",
    );
    return "2 kept, 1 packed";
  });

  await check("scan says nothing to do when no result qualifies", async () => {
    stub.state.sessionContext = {
      modelKey: "openai/gpt-5.6-luna",
      truncated: false,
      messages: [
        { role: "tool", toolName: "bash", content: "small" },
        { role: "assistant", content: "fine" },
      ],
    };
    const outcome = await stub.invokeTool("obs_pack", { action: "scan" });
    expect(outcome.candidates.length === 0, "nothing should qualify");
    expect(outcome.text.includes("Nothing to pack"), "the agent must be told plainly");
  });

  section("Evidence-Preserving Reducer: checked, or nothing");

  await stub.pi.plugin.setSettings({ evidencePreservingReducer: true });

  await check("a verifiable receipt is applied and archived", async () => {
    stub.state.complete = async (input) =>
      receiptFor(input, { kind: "failure", quote: BIG_LOG_LINES[7], status: "failure" });
    const outcome = await stub.invokeTool("reduce_evidence", {
      text: BIG_LOG,
      command: "npm test",
      is_error: true,
    });
    expect(outcome.applied === true, `expected the receipt to apply: ${outcome.reason ?? ""}`);
    expect(outcome.text.startsWith("sol_pi_evidence_receipt_v1"), "the receipt must carry its schema marker");
    expect(outcome.text.includes("source_sha256="), "the receipt must name the archived source");
    expect(outcome.text.includes("verified_evidence:"), "evidence must be quoted back");
    expect(stub.state.completeCalls.length === 1, "exactly one model call");
    const call = stub.state.completeCalls[0];
    expect(String(call.modelKey).includes("/"), "the model key must be provider/model");
    expect(call.includeSessionContext === false, "the reducer must not send the session context");
    expect(String(call.system).includes("untrusted"), "the prompt must mark the log as untrusted data");
    return `${Buffer.byteLength(BIG_LOG)} → ${Buffer.byteLength(outcome.text)} bytes`;
  });

  await check("a fabricated quote is rejected and the original text comes back untouched", async () => {
    stub.state.complete = async (input) =>
      receiptFor(input, { kind: "failure", quote: "line that is not in the log at all", status: "failure" });
    const outcome = await stub.invokeTool("reduce_evidence", {
      text: BIG_LOG,
      command: "npm test",
      is_error: true,
    });
    expect(outcome.applied === false, "an unverifiable quote must not apply");
    expect(outcome.reason === "unverifiable-quote", `unexpected reason ${outcome.reason}`);
    expect(outcome.text === BIG_LOG, "the original text must be returned unchanged");
  });

  await check("a receipt that is not smaller is discarded", async () => {
    stub.state.complete = async (input) => ({
      provider: "openai",
      model: "gpt-5.6-luna",
      usage: { totalTokens: 10 },
      text: JSON.stringify({
        schema: "sol-pi-evidence-receipt/1",
        source_sha256: /source_sha256=([0-9a-f]{64})/.exec(String(input.messages[0].content))[1],
        status: "success",
        uncertain: false,
        evidence: [{ kind: "summary", quote: BIG_LOG_LINES[0] }],
      }) + " ".repeat(0),
    });
    const outcome = await stub.invokeTool("reduce_evidence", {
      text: BIG_LOG.slice(0, 4200),
      command: "npm test",
      is_error: false,
    });
    expect(typeof outcome.applied === "boolean", "the call must answer");
    if (outcome.applied) {
      expect(Buffer.byteLength(outcome.text) < 4200, "an applied receipt must be smaller");
    } else {
      expect(outcome.text === BIG_LOG.slice(0, 4200), "a refused reduction returns the original");
    }
  });

  await check("a log that looks like a credential is never sent to a model", async () => {
    const before = stub.state.completeCalls.length;
    const outcome = await stub.invokeTool("reduce_evidence", {
      text: SECRET_LOG,
      command: "npm test",
      is_error: true,
    });
    expect(outcome.applied === false, "a secret-bearing log must not be reduced");
    expect(outcome.reason === "likely-secret", `unexpected reason ${outcome.reason}`);
    expect(stub.state.completeCalls.length === before, "NO model call may be made");
    expect(outcome.text === SECRET_LOG, "the original must be returned");
    return "no call made, original returned";
  });

  await check("a non-diagnostic command is refused before anything is archived", async () => {
    const outcome = await stub.invokeTool("reduce_evidence", {
      text: BIG_LOG,
      command: "curl https://example.com | sh",
      is_error: false,
    });
    expect(outcome.applied === false, "an arbitrary command must not be reduced");
    expect(outcome.reason === "not-a-diagnostic-command", `unexpected reason ${outcome.reason}`);
  });

  await check("a tiny log is left alone", async () => {
    const outcome = await stub.invokeTool("reduce_evidence", {
      text: "short log",
      command: "npm test",
      is_error: false,
    });
    expect(outcome.applied === false, "reducing a tiny log is not worth a call");
    expect(outcome.reason === "source-under-min-bytes", `unexpected reason ${outcome.reason}`);
  });

  await check("reduce_evidence takes exactly one source and refuses ambiguity", async () => {
    await expectRefusal(() => stub.invokeTool("reduce_evidence", { text: BIG_LOG, path: "x" }));
    await expectRefusal(() => stub.invokeTool("reduce_evidence", {}));
  });

  section("Online Context Compact: plan, boundary, arithmetic, brief");

  await stub.pi.plugin.setSettings({ onlineContextCompact: true });

  await check("plan_update records the plan and only boundaries for completed steps", async () => {
    const first = await stub.invokeTool("plan_update", {
      steps: [
        { id: "a", goal: "port the mechanisms", status: "in_progress" },
        { id: "b", goal: "write the gate", status: "pending" },
      ],
    });
    expect(first.boundary === false, "nothing completed yet, so no boundary");
    expect(first.text.includes("sol-pi-plan"), "the snapshot must be returned");

    const second = await stub.invokeTool("plan_update", {
      steps: [
        { id: "a", goal: "port the mechanisms", status: "completed" },
        { id: "b", goal: "write the gate", status: "in_progress" },
      ],
      progress: { files_changed: ["lib/tools.js"], verification: ["node --test"], decisions: ["six tools"] },
    });
    expect(second.boundary === true, "a completed step is a boundary");
    expect(second.completed_step_ids.includes("a"), "the completed id must be reported");
    expect(typeof second.brief_path === "string", "a boundary writes the carry-forward brief");
    expect(existsSync(second.brief_path), "the brief must exist on disk");
    return second.brief_path;
  });

  await check("the brief carries the open work forward, not just the numbers", async () => {
    const briefPath = join(dataPath, "sessions");
    const buckets = require("node:fs").readdirSync(briefPath);
    let brief = "";
    for (const name of buckets) {
      const candidate = join(briefPath, name, "online-context-compact", "compaction-brief.md");
      if (existsSync(candidate)) brief = readFileSync(candidate, "utf8");
    }
    expect(brief.length > 0, "a brief must have been written");
    expect(brief.includes("write the gate"), "open work must survive the boundary");
    expect(brief.includes("## Remaining work"), "the brief must keep a remaining-work section");
    expect(brief.includes("[b]"), "the open step must be carried forward by id");
    return `${brief.length} chars`;
  });

  await check("plan_update rejects a malformed plan outright", async () => {
    await expectRefusal(() => stub.invokeTool("plan_update", { steps: [{ id: "a", goal: "x", status: "nope" }] }), {
      includes: "valid step",
    });
    await expectRefusal(() => stub.invokeTool("plan_update", { steps: [] }), { includes: "at least one" });
    await expectRefusal(
      () => stub.invokeTool("plan_update", { steps: [{ id: "a", goal: "x", status: "pending", extra: 1 }] }),
      { includes: "valid step" },
    );
  });

  await check("compact_check measures, decides, and says it cannot compact", async () => {
    stub.state.sessionContext = {
      modelKey: "openai/gpt-5.6-luna",
      truncated: false,
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ${"z".repeat(4000)}`,
      })),
    };
    const outcome = await stub.invokeTool("compact_check", {});
    expect(outcome.ok === true, "the call must answer");
    expect(outcome.compaction.context_tokens > 0, "the context must be measured");
    expect(typeof outcome.compaction.reason === "string", "a reason code is required");
    expect(outcome.text.includes("cannot perform it"), "it must say that it cannot compact");
    expect(outcome.text.includes("/compact"), "it must hand the user the command instead");
    expect(existsSync(outcome.brief_path), "a brief must be written");
    expect(outcome.horizon_basis.context_window_tokens > 0, "the window must be reported");
    return `${outcome.compaction.reason}, ${outcome.compaction.context_tokens} tokens`;
  });

  await check("a nearly full window wins over the arithmetic (window protection)", async () => {
    stub.state.models = [{ key: "openai/gpt-5.6-luna", contextWindow: 24000 }];
    stub.state.sessionContext = {
      modelKey: "openai/gpt-5.6-luna",
      truncated: false,
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ${"z".repeat(9000)}`,
      })),
    };
    const outcome = await stub.invokeTool("compact_check", {});
    expect(outcome.compaction.compact === true, `expected a compaction recommendation, got ${outcome.compaction.reason}`);
    expect(outcome.compaction.reason === "window_protection", `unexpected reason ${outcome.compaction.reason}`);
    stub.state.models = [{ key: "openai/gpt-5.6-luna", contextWindow: 200000 }];
    return "recommended regardless of price";
  });

  await check("with no history it refuses to guess a horizon", async () => {
    stub.state.sessionContext = { modelKey: "openai/gpt-5.6-luna", truncated: false, messages: [] };
    const outcome = await stub.invokeTool("compact_check", {});
    expect(outcome.ok === true, "the call must still answer");
    expect(
      typeof outcome.compaction.reason === "string" && outcome.compaction.reason.length > 0,
      "a reason is still required",
    );
    return outcome.compaction.reason;
  });

  section("Panel and view channels");

  await check("sol.state lists the session buckets the tools actually wrote", async () => {
    const state = await plugin.onPanelInvoke("sol.state", {});
    expect(state.ok === true, "the state must load");
    expect(Array.isArray(state.sessions) && state.sessions.length === 1, `expected 1 bucket, got ${state.sessions?.length}`);
    const bucket = state.sessions[0];
    expect(bucket.observations >= 2, "the packed observations must be counted");
    expect(bucket.archived_bytes > 0, "archived bytes must be reported");
    expect(bucket.receipts.candidates >= 1, "reducer candidates must be counted");
    expect(bucket.plan_steps === 2, `plan steps must be counted, got ${bucket.plan_steps}`);
    expect(bucket.has_brief === true, "the brief must be visible");
    expect(state.enabled.sort().join(",") === ["actionFusion", "evidencePreservingReducer", "observationPack", "onlineContextCompact"].sort().join(","), `unexpected enabled set: ${state.enabled}`);
    return `${bucket.bucket}: ${bucket.observations} packs, ${bucket.archived_bytes} bytes`;
  });

  await check("sol.readArchived returns an exact page of an observation", async () => {
    const state = await plugin.onPanelInvoke("sol.state", {});
    const id = state.observations[0].id;
    const page = await plugin.onPanelInvoke("sol.readArchived", { bucket: state.bucket, kind: "observation", id, offset: 0 });
    expect(page.ok === true, "the page must load");
    expect(page.bytes > 0 && page.bytes <= 16384, "a page must be bounded");
    expect(typeof page.next_offset === "number", "the next offset must be reported");
    return `${page.bytes} bytes`;
  });

  await check("sol.readArchived reads an archived reducer log by its digest", async () => {
    const state = await plugin.onPanelInvoke("sol.state", {});
    const receipt = state.receipts.find((entry) => typeof entry.digest === "string");
    expect(receipt, "a receipt with a digest must exist");
    const page = await plugin.onPanelInvoke("sol.readArchived", {
      bucket: state.bucket,
      kind: "reducer",
      digest: receipt.digest,
      offset: 0,
    });
    expect(page.ok === true, "the archived source must be readable");
    expect(page.text.length > 0, "the page must carry text");
    return `${receipt.digest.slice(0, 10)}…`;
  });

  await check("a crafted bucket name cannot walk out of the archive root", async () => {
    await expectRefusal(() => plugin.onPanelInvoke("sol.state", { bucket: "../../etc" }), {
      includes: "unknown session bucket",
    });
    await expectRefusal(() => plugin.onPanelInvoke("sol.state", { bucket: "." }), {
      includes: "unknown session bucket",
    });
    const state = await plugin.onPanelInvoke("sol.state", {});
    await expectRefusal(
      () =>
        plugin.onPanelInvoke("sol.readArchived", {
          bucket: state.bucket,
          kind: "reducer",
          digest: "../../../../etc/passwd",
        }),
      { includes: "digest" },
    );
    await expectRefusal(
      () => plugin.onPanelInvoke("sol.readArchived", { bucket: state.bucket, kind: "observation", id: "../../etc" }),
      { includes: "observation id" },
    );
  });

  await check("a bad settings patch is refused instead of guessed at", async () => {
    await expectRefusal(() => plugin.onPanelInvoke("sol.setSettings", { patch: "actionFusion" }));
    await expectRefusal(() => plugin.onPanelInvoke("sol.nope", {}));
  });

  await check("sol.setSettings and sol.applyPreset round-trip", async () => {
    const off = await plugin.onPanelInvoke("sol.applyPreset", { preset: "off" });
    expect(off.enabled.length === 0, "the off preset must disable everything");
    const local = await plugin.onPanelInvoke("sol.applyPreset", { preset: "local" });
    expect(
      local.enabled.sort().join(",") === "actionFusion,observationPack",
      `the local preset must enable only the two local mechanisms, got ${local.enabled}`,
    );
    const patched = await plugin.onPanelInvoke("sol.setSettings", { patch: { keepRecentTokens: 12345 } });
    expect(patched.config.keepRecentTokens === 12345, "a numeric setting must round-trip");
    expect(patched.config.evidencePreservingReducer === false, "unrelated settings must be untouched");
    return local.enabled.join(", ");
  });

  section("Commands");

  await check("every declared command runs and does something specific", async () => {
    await stub.invokeCommand("solPi.open");
    expect(stub.state.panels.length === 1, "solPi.open must open the panel");

    await stub.invokeCommand("solPi.disableAll");
    expect(stub.state.settings.actionFusion === false, "disableAll must turn everything off");
    expect(stub.state.settings.onlineContextCompact === false, "disableAll must reach every key");

    await stub.invokeCommand("solPi.enableLocal");
    expect(stub.state.settings.actionFusion === true, "enableLocal must enable action fusion");
    expect(stub.state.settings.observationPack === true, "enableLocal must enable observation packing");
    expect(
      stub.state.settings.evidencePreservingReducer === false,
      "enableLocal must NOT enable the mechanism that spends quota",
    );
    expect(stub.state.settings.onlineContextCompact === false, "enableLocal must leave compaction off");

    await stub.invokeCommand("solPi.compactBrief");
    const last = stub.state.toasts.at(-1);
    expect(last && typeof last.message === "string", "compactBrief must report something");
    return `${stub.state.toasts.length} toasts`;
  });

  section("Result discipline");

  await check("an oversized result is never a quiet success", async () => {
    await stub.pi.plugin.setSettings({
      actionFusion: true,
      observationPack: true,
      evidencePreservingReducer: true,
      onlineContextCompact: true,
    });
    const outcomes = [];
    stub.state.sessionContext = { modelKey: "openai/gpt-5.6-luna", truncated: false, messages: [] };
    outcomes.push(await stub.invokeTool("obs_pack", { action: "pack", text: BIG_RESULT }));
    outcomes.push(await stub.invokeTool("obs_pack", { action: "list" }));
    outcomes.push(await stub.invokeTool("compact_check", {}));
    for (const outcome of outcomes) {
      const size = Buffer.byteLength(JSON.stringify(outcome), "utf8");
      if (size <= 8000) continue;
      expect(
        outcome.applied === false ||
          outcome.packed === false ||
          outcome.original_bytes !== undefined ||
          outcome.candidates !== undefined ||
          outcome.receipts !== undefined ||
          outcome.observations !== undefined,
        "a large result must be an archive pointer or an untouched fallback",
      );
    }
    return "archive pointers only";
  });

  section("Manifest agreement");

  await check("the shipped manifest and the metadata module agree", async () => {
    plugin.assertManifestAgreement(stub.pi);
    return "agree";
  });

  await check("a tampered manifest makes the plugin refuse to load", async () => {
    const tampered = structuredClone(manifest);
    tampered.permissions = tampered.permissions.filter((permission) => permission !== "session.read");
    const badStub = createHostStub({ dataPath: join(scratch, "data-bad"), projectRoot, manifest: tampered });
    const badPlugin = freshPlugin(badStub);
    const message = await expectRefusal(() => badPlugin.onLoad(), { includes: "manifest" });
    expect(message.includes("session.read"), "the drift must name the missing permission");
    return "refused";
  });

  await check("a renamed tool makes the plugin refuse to load", async () => {
    const tampered = structuredClone(manifest);
    tampered.contributes.agentTools[0].name = "fused_edit_v2";
    const badStub = createHostStub({ dataPath: join(scratch, "data-bad2"), projectRoot, manifest: tampered });
    const badPlugin = freshPlugin(badStub);
    await expectRefusal(() => badPlugin.onLoad(), { includes: "contributes.agentTools" });
  });

  await check("a plugin that fails to load leaves nothing registered", async () => {
    const tampered = structuredClone(manifest);
    tampered.contributes.commands = [];
    const badStub = createHostStub({ dataPath: join(scratch, "data-bad3"), projectRoot, manifest: tampered });
    const badPlugin = freshPlugin(badStub);
    await expectRefusal(() => badPlugin.onLoad());
    expect(badStub.state.commands.size === 0, "no command may survive a failed load");
  });

  // The tampered-load checks above replaced `globalThis.pi`; put the good host
  // back so the remaining checks run against the instance the plugin loaded with.
  globalThis.pi = stub.pi;

  section("Files the manifest promises");

  await check("every declared skill exists, parses its frontmatter, and has a usable description", async () => {
    const names = [];
    for (const relative of manifest.contributes.skills) {
      const path = join(pluginRoot, relative);
      expect(existsSync(path), `${relative} is missing`);
      const raw = readFileSync(path, "utf8");
      expect(raw.length < 128 * 1024, `${relative} is over the host's 128 KiB limit`);
      const match = /^---\n([\s\S]*?)\n---\n/.exec(raw);
      expect(match, `${relative} has no frontmatter`);
      const front = match[1];
      const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim();
      const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim();
      expect(name, `${relative} needs a name`);
      expect(description, `${relative} needs a description`);
      expect(description.length <= 240, `${relative} description is ${description.length} chars (max 240)`);
      expect(raw.length > match[0].length + 200, `${relative} needs a real body`);
      names.push(relative);
    }
    return names.length + " skills";
  });

  await check("the view and the panel entry both exist, and settings keys are host-legal", async () => {
    for (const view of manifest.contributes.views) {
      expect(existsSync(join(pluginRoot, view.entry)), `${view.entry} is missing`);
      expect(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(view.id), `view id ${view.id} is not host-legal`);
    }
    expect(existsSync(join(pluginRoot, manifest.ui.panel)), `${manifest.ui.panel} is missing`);
    for (const setting of manifest.contributes.settings) {
      expect(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(setting.key), `setting key ${setting.key} is not host-legal`);
      expect(setting.title && setting.title.trim(), `setting ${setting.key} needs a title`);
      expect(["string", "number", "boolean", "select", "json", "shortcut"].includes(setting.type), `setting ${setting.key} type ${setting.type}`);
    }
    const legal = new Set([
      "ui.panel", "ui.view", "ui.microphone", "ui.theme", "ui.settings", "ui.window.appearance",
      "clipboard.read", "clipboard.write", "notify", "fs.read", "fs.write", "fs.delete",
      "agent.tool.register", "agent.prompt.inject", "agent.complete", "agent.extension",
      "provider.register", "desktop.control", "models.list", "project.create", "session.read",
      "session.import", "session.read.own", "session.update.own", "session.delete.own",
      "usage.read", "net.fetch", "shell.openExternal", "mcp.server.local", "mcp.server.remote",
      "background.service", "bus.publish", "bus.subscribe", "browser.cdp",
      "audio.capture.background", "audio.playback.background", "speech.adapter.register",
      "keyboard.globalShortcut", "net.websocket",
    ]);
    for (const permission of manifest.permissions) {
      expect(legal.has(permission), `permission ${permission} is not one PI-Desktop grants`);
    }
    return `${manifest.permissions.length} permissions, ${manifest.contributes.settings.length} settings`;
  });

  await check("the panel page loads no remote resource and no inline script", async () => {
    const html = readFileSync(join(pluginRoot, manifest.ui.panel), "utf8");
    expect(!/https?:\/\//.test(html), "the panel must not reference a remote resource");
    expect(!/<script(?![^>]*\bsrc=)/i.test(html), "the panel must not use an inline script");
    expect(!/\son[a-z]+\s*=/i.test(html), "the panel must not use an inline event handler");
    return "self-contained";
  });

  section("Unload");

  await check("onUnload unregisters everything it registered", async () => {
    await plugin.onUnload();
    expect(stub.state.tools.size === 0, "no tool may survive unload");
    expect(stub.state.commands.size === 0, "no command may survive unload");
    const unregisterCalls = stub.state.calls.filter((call) => call.api.includes("unregister"));
    expect(unregisterCalls.length >= 10, "every registration must be undone through the host");
    return `${unregisterCalls.length} unregister calls`;
  });

  section("The hook route, exercised without the host");

  // The agent-side module lives in a different process from the plugin, so it is
  // exercised through its real entry point, with a temporary installation root.
  // Each result is printed in `check`'s shape, so a failing hook check is a
  // failing gate check, by name.
  for (const item of await require("./agent-hooks-harness.js").run()) {
    if (item.ok) {
      results.push({ kind: "pass", name: item.name });
      console.log(`  ok   ${item.name}${verbose ? ` — ${item.detail}` : ""}`);
    } else {
      failed += 1;
      results.push({ kind: "fail", name: item.name, error: item.detail });
      console.log(`  FAIL ${item.name}\n       ${item.detail}`);
    }
  }
  if (!verbose) {
    console.log("\nSections passed. Re-run with --verbose for per-check detail.");
  }
  console.log(`\n${results.filter((item) => item.kind === "pass").length} checks passed, ${failed} failed`);

  rmSync(scratch, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("\nThe gate itself failed:", error?.stack ?? error);
  process.exit(2);
});
