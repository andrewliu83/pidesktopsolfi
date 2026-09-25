# Port notes — NVlabs/SoL-Pi → PI-Desktop

Each section below says what upstream does, where that behaviour lives in this
plugin, what is reproduced exactly, and what could not be — with the reason.
Anything not listed as a divergence is meant to be a faithful copy, and the
offline gate checks that it is.

## Provenance

| | |
|---|---|
| Upstream | [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) |
| Commit ported | `1559b5cb12c72da4a485bc50fe326586b216fb19` (2026-09-22), package version `0.1.0` |
| Licence | MIT — NVIDIA Corporation & Affiliates; full text in `THIRD_PARTY_NOTICES.md` |
| Target host | PI-Desktop 0.15.x **plugin** API (`plugin.registerTool`, `ui.panel`, `agent.complete`, …) |
| Not the target | the `pi` coding-agent *extension* API (`pi.on("context")`, `pi.registerTool`, `ExtensionContext`) |
| Upstream entry point | `src/sol-pi/index.ts` — one extension that registers the four mechanisms, each gated by `sol-pi.json` |

The single fact that explains most of the differences below: upstream is a *pi
coding-agent extension*. It works through lifecycle hooks (`context`,
`tool_result`, `turn_end`, `session_*`), and two of its mechanisms work by
**replacing the host's own tools**. The contract this port targets — a PI-Desktop
*plugin* (`globalThis.pi`, registered tools, a panel, commands) — can do neither: it
registers *additional* tools, and its own code receives no agent event at all. So
every hook-driven trigger becomes an explicit tool or command, and the state that
upstream keeps in session entries is kept in files under the plugin's data
directory instead.

PI-Desktop *does* have the agent hook surface — it is the one upstream is written
against, and it is reachable from a plugin only by contributing an ExtensionAPI
module (`contributes.agentExtensions` plus the `agent.extension` permission, i.e.
code running inside the agent process). This port does not do that, and
"The hook surface, precisely" below states exactly what each route can and cannot
reach, so the choice can be judged rather than assumed.

## Where each upstream file went

| Upstream (`src/sol-pi/…`) | Here |
|---|---|
| `config.ts` | `lib/config.js` (+ settings declared in `manifest.json`) |
| `runtime-paths.ts` | `lib/paths.js` |
| `index.ts` | `main.js` (`onLoad`, registration, commands) |
| `tui.ts` (status-line savings) | `views/` (work panel) + the `text` of every tool result + `ui.showToast` |
| `extensions/action-fusion/index.ts` | `lib/action-fusion.js`, `lib/tools.js` (`fused_edit`), `lib/tool-descriptors.js` |
| `extensions/action-fusion/file-queue.ts` | `withFusedFileQueue` in `lib/action-fusion.js` |
| `extensions/action-fusion/then-run.ts` | `executeMutationThenRun` in `lib/action-fusion.js` |
| `extensions/observation-pack/observation.ts` | `lib/observation-pack.js` |
| `extensions/observation-pack/ledger.ts` | `lib/ledger.js` (shared JSONL ledger) |
| `extensions/observation-pack/index.ts` | `lib/tools.js` (`obs_pack`, `obs_recall`) |
| `extensions/evidence-preserving-reducer/*.ts` | `lib/reducer.js` (receipt, provider, archive, candidate, journal, config in one module) |
| `extensions/online-context-compact/economics.ts` | `lib/compact-economics.js` |
| `extensions/online-context-compact/plan.ts` | `lib/compact-plan.js` |
| `extensions/online-context-compact/state.ts` | `lib/compact-state.js` (+ `plan.json` underneath) |
| `extensions/online-context-compact/tools.ts` | `lib/tools.js` (`plan_update`) |
| `extensions/online-context-compact/extension.ts` | `lib/tools.js` (`compact_check`) + the `solPi.compactBrief` command |
| — (no upstream counterpart) | `lib/host.js` (host-API adapter), `lib/metadata.js`, `manifest.json`, `eval/`, `test/`, `scripts/`, `skills/` |

## 1. Action Fusion — `fused_edit`

**Upstream.** `edit` and `write` are the host's own tools; upstream spreads their
templates (`...editTemplate`, `...writeTemplate`) and registers them again with an
extra `then_run` parameter, so the mutation and its validation command happen in
one call. `file-queue.ts` serialises concurrent calls per file, `then-run.ts`
holds the ordering and reporting logic.

**Preserved here.** The whole inside of the mechanism: the per-path queue, the
hash guard taken *before* the command runs, atomic writes, the confirmation line,
and the verdict markers — `[then_run:succeeded]`, `[then_run:failed]`,
`[then_run:skipped]` — with upstream's shape (verdict on its own line after the
summary, output after it, `exit_code=` last, `[note] …` for a capped stream). A
failed mutation skips the command and says the command was not run. The refusal
list is upstream's: absolute paths, `..` escapes, credential directories
(`.ssh/`, `.aws/`, …) and credential-looking files; upstream's `@`-prefixed
paths, `file://` URLs and unicode-space normalisation are accepted and then forced
back inside the project root. `runCommand`'s default timeout is upstream's.

**Divergences.**

| Change | Why |
|---|---|
| One new tool `fused_edit` with `action: "edit" \| "write"` instead of extending `edit`/`write` | A PI-Desktop plugin cannot override a host tool, and it cannot add a parameter to one. Registering a separate tool is the only way to keep the fused call available; `then_run` is the same field, and it is optional, so `fused_edit` without `then_run` is exactly the base tool. |
| `~` home paths are refused (`refused: "~…" is a home-directory path`) | The host resolves plugin paths against the project root; a home path would name a file outside the workspace, which the mechanism's own containment rule forbids. Upstream never sees them because `pi` resolves paths against a trusted cwd. |
| Editing a path that does not exist throws `edit: <path> does not exist; use action "write" to create it.` | Upstream inherits the base tool's message. A plugin gets no such message, so the same rule is stated explicitly rather than letting a `readFile` error leak a host-internal path. |

## 2. ObservationPack — `obs_pack`, `obs_recall`

**Upstream.** A `pi.on("context")` projection hook replaces large, already-replayed
tool results with a placeholder; the bytes stay on disk and `obs_recall` pages them
back. `THRESHOLD_BYTES` is 10 KiB, `FULL_SENDS` is 2, the id is
`obs_` + `sha256(toolName \0 toolCallId \0 sha256(text)).slice(0, 24)`, recall is
capped at 15872 bytes or 398 lines, and the placeholder text is fixed.

**Preserved here.** All of it, byte for byte: the id derivation, the strict
threshold (`<= THRESHOLD_BYTES` is *not* packed), the `FULL_SENDS` replay rule, the
content-addressed store with its size and hash checks on read, the exact
placeholder lines (`[first complete lines, up to 512 bytes]`,
`[middle omitted; last complete lines, up to 512 bytes]`,
`[N original bytes omitted]`), the 15872-byte / 398-line paging caps with their
refusals, and the ledger entry every recall writes. `obs_recall` keeps its upstream
name.

**Divergences.**

| Change | Why |
|---|---|
| Packing is an explicit `obs_pack` tool (`action: "pack" \| "scan" \| "list"`), not a projection hook | The plugin route has no `context` hook, so there is no place to install the automatic replacement — the agent-extension route does have one, and this port does not ship it ("The hook surface, precisely"). `scan` is the stand-in: it reads the live conversation through `session.getLlmContext()`, counts how many assistant messages follow each large tool result (upstream's replay count), and returns the eligible ones *with* their placeholders for the agent to apply. `pack` packs text the agent is holding. |
| A scan never packs its own fused-call results; it reports how many it left alone (`fused_results_kept`) | A `fused_edit` result carries the `[then_run:…]` verdict the agent has to read. Upstream never faces this because the projection runs after the call has been read; a scan runs against a live conversation where that result is still actionable. The verdict marker sits on line 3, ahead of the output, so it survives the host's projection; the tool name is checked as well, because that identifies a fused call even when a scan sees only the head of a result. |
| The scan's effective threshold is `min(requested, 8000)` and it reports `source_may_be_truncated` / `source_visible_chars` for every candidate | PI-Desktop projects at most 8000 characters of a tool result to a plugin, so a scan that insisted on 10 KiB could never find anything. Archives made from a truncated view say so in their own placeholder, and the "Nothing to pack" text names the upstream threshold and points at `obs_pack action "pack"`. |
| `obs_pack` and `obs_recall` stay usable while the mechanism is off | The rest of the mechanism (automatic packing) is what the setting gates. Refusing recall too would strand bytes that are already on disk and could not be read any other way. |

## 3. Evidence-Preserving Reducer — `reduce_evidence`

**Upstream.** `pi.on("tool_result")` notices a large *failing* diagnostic result,
archives the raw body under its content hash, asks a model for a receipt, and then
verifies **every** field of that receipt against the archive before trusting it:
schema, source hash, byte/line counts, status, evidence kinds, and every quote must
appear in the original text. A receipt that fails any check is discarded and the
original text comes back untouched. Refusals: `source-under-min-bytes` (4096),
`source-over-max-chars`, `likely-secret`, `not-a-diagnostic-command`,
`receipt-not-smaller`, `model-response-error`. The receipt's verification lines are
fixed strings, and so are its `authority=` and `readback=` closers.

**Preserved here.** The verification, in the same order, with the same reasons and
the same fail-open result shape (`{applied:false, reason, archive}` with no text
field), the same archive layout (`objects/<hh>/<hash>.txt`, an existing name with
different bytes is an integrity failure rather than a cache hit), the same journal,
the same 4096-byte floor and secret detection, the same receipt schema marker
(`sol_pi_evidence_receipt_v1`) and the same evidence line format
(`- kind= line= quote_sha256= quote=`). The instruction lines that the frontier
agent sees — readback and authority — are upstream's words, and the gate pins them.

**Divergences.**

| Change | Why |
|---|---|
| An explicit `reduce_evidence` tool that requires `command`, with exactly one source (`text`, `path` or `observation_id`) | Upstream's trigger is a `tool_result` hook this route cannot install (see "The hook surface, precisely"). Because the reducer only ever ran for a diagnostic command, the port states that requirement in the tool itself: a non-diagnostic command is refused before anything is archived or sent to a model, and passing two sources is refused as ambiguous rather than guessed at. |
| The default provider is `openai-codex` (`DEFAULT_REDUCER_PROVIDER`, upstream's `["openai", "codex"].join("-")`), default model `gpt-5.6-luna` | Faithful to upstream, and surfaced as settings. PI-Desktop maps the `openai-codex` alias onto its own provider; if the alias is not available on the machine, the refusal names the setting to repoint instead of silently substituting a provider. |
| The receipt records the reducer model and provider that actually answered | Upstream records them too; here they come from `agent.complete`, so the receipt names what PI-Desktop resolved rather than what was requested. |

## 4. Online Context Compact — `plan_update`, `compact_check`

**Upstream.** Ten lifecycle hooks project a plan into the conversation, track
context growth across requests (`before_provider_request`, `turn_end`), decide
whether compacting is worth its cache cost, run the host's native compaction, and
then inject "call `update_plan` with a fresh plan". `economics.ts` holds the
decision maths; `plan.ts` the plan parsing and its `<sol-pi-plan
task_status="active">` marker; `state.ts` the counters, carried cache debt and
corrections; `tools.ts` the `update_plan` tool.

**Preserved here.** The economics, constant for constant and branch for branch:
`cacheWriteReadRatio` 12.5, first-compaction request scale 2, subsequent margin
1.5, 16 KiB window reserve, `DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE` 1000, the
remaining-request estimate (mean, `stddevK` upper bound, window bound), the
breakeven and combined-breakeven arithmetic, and the reason codes
`non_positive_saving`, `window_protection`, `economic`, `deferred_economic`,
`deferred_subsequent_margin`, `deferred_carried_debt`, `horizon_unavailable`,
`cache_ratio_unavailable`. Plan parsing keeps `MAX_PLAN_STEPS` 128,
`MAX_PLAN_STRING_BYTES` 16384, the marker, and the array-or-`undefined` return.
`DEFAULT_KEEP_RECENT_TOKENS` is 20000 and the validation ("positive safe integer")
is upstream's.

**Divergences.**

| Change | Why |
|---|---|
| The tool is named `plan_update`, and `compact_check` exposes the verdict | Upstream's plan tool is `update_plan`; the port's name keeps the mechanism prefix in the plugin's own namespace, and `compact_check` exists because this route cannot hook `turn_end` (the agent-extension route can — see "The hook surface, precisely") — the agent asks for the measurement instead. |
| `compact_check` reports the verdict, writes the carry-forward brief, and tells the user to run `/compact`; it never compacts | PI-Desktop's native compaction is a user action only (a plugin cannot start it, and `/compact` is not callable from a plugin). The plugin therefore says plainly what the economics decided and hands the decision over, instead of pretending it compacted. |
| The plugin never emits `native_not_compactable` | Upstream downgrades a positive decision with that code when *its host's* native compaction is not feasible for the branch (`nativeCompactionFeasible(context.sessionManager.getBranch(), …)`). A plugin cannot inspect the host's branch or its compactor's feasibility, so that code is unreachable here; whether PI-Desktop can compact is stated to the user rather than guessed at. |
| Plan and economics state live in `plan.json` (+ `compaction-brief.md`) under the plugin data directory, keyed by session bucket | Upstream appends its state to the session entries (`appendOnlineState`) and restores it from them (`restoreOnlineState`). A plugin cannot append to the host's session log, so the same per-session state is rebuilt in files. |
| `keepRecentTokens` is a setting (default 20000) rather than an option | Upstream takes it from extension options; a plugin has no options object, so the constant is surfaced where a user can change it. |
| Window protection is computed from the host's model window when it is known (`models.list`) and the reason says so when it is not (`horizon_unavailable` / `cache_ratio_unavailable`) | A plugin cannot observe the host's request accounting directly; the numbers come from the context it can read, and the decision refuses to guess when they are missing. |

## Cross-cutting divergences

| Aspect | Upstream | Here | Why |
|---|---|---|---|
| Configuration | `sol-pi.json` in the agent dir (or the project), read once per session; defaults all `false` | The same keys as declared settings, resolved through `plugin.getSettings()`, defaulting to `false` when a user has never touched them | A plugin cannot read the agent's config file (no filesystem permission), and the host already has a settings surface. Upstream's keys are kept so the two can be compared line by line; `version` is dropped (the host owns schema versioning) and `keepRecentTokens` is added (see above). |
| Storage root | `<session-directory>/sol-pi/<session-id>` | `<plugin-data-directory>/sessions/<bucket>` where bucket = sanitised session id + 8 hex of its sha256 | A plugin is given its own data directory and never the session directory. The hash suffix keeps two session ids that sanitise to the same string from colliding into one archive. |
| Project root | `pi` resolves a path against a trusted cwd, so upstream never has to ask where it is | `workspace.get()` first (the window's project; the bare `{ path, name }` and a `{ workspace: { … } }` envelope are both accepted), else the folder the **session** records, `session.get({ id }).session.projectPath` | `workspace.get()` returns `null` whenever the window has no project open — ordinary in PI-Desktop — and a plugin that trusted it alone would refuse every path-based tool inside a chat that does have a folder. The session's own folder is the same source the host reads to scope its file access per session (ADR 0016/D093). The refusal fires only when neither has one, and names both attempts: `No project is open, so there is no project root to work in.` then `This session does not record a project folder either.` / `Session lookup failed too: …` (a failed lookup is disclosed, not read as "no folder") / `No session was available to ask.` |
| A session id that upstream would reject outright | `runtimeRoot` throws on an unsafe session id or a missing session directory | An absent id becomes the bucket `shared`; an unsafe one is sanitised, and the hash suffix keeps it distinct | A plugin's panel and command invocations have no session id at all, and a plugin that threw there would simply be unusable. Archiving still refuses when the plugin has no data directory (`NO_DATA_DIR`). |
| Progress reporting | Status line via `context.ui.setStatus` (`⚡ mechanism · saving`) | Work panel (`views/`) plus the `text` of each result | The plugin contract has toasts and a panel, not a status line. The savings figures are the same ones, computed the same way. |
| Permissions | Extension code runs with the agent's own access | `ui.view, ui.panel, clipboard.write, agent.tool.register, agent.prompt.inject, agent.complete, session.read, models.list` — no `fs`, no `net`, no `desktop`, no `browser` | The plugin needs no raw filesystem or network access: archives go under the data directory the host hands it, commands run through the host's own shell path, and the one model call goes through `agent.complete`. `clipboard.write` is used from the panel (the host serves that channel itself behind the permission), and `notify` is not requested at all: the host's own `PERMISSION_API_HINTS` ties it to the notification APIs, not to `ui.showToast`, which is all this plugin uses. |
| Model call | Provider configured by the extension, via the host's completion API | `agent.complete` with `includeSessionContext: false` | Upstream never sends session context to the reducer either; a plugin must ask for that explicitly, and the gate asserts the flag. |

## Security posture (unchanged, and checked)

All four mechanisms ship **disabled**, exactly as upstream's `DEFAULT_CONFIG` does
(`actionFusion`, `observationPack`, `evidencePreservingReducer`,
`onlineContextCompact` all `false`). Every tool that belongs to a disabled
mechanism refuses and names the setting that would enable it, and the gate asserts
each refusal by name — including that a refused call writes nothing to disk. The
credential guards are upstream's: credential directories and credential-looking
files are refused before a mutation, and a log that looks like a secret is never
sent to a model. The only commands the plugin runs are the ones the agent passes to
`fused_edit`'s `then_run`, with upstream's timeout and stream caps.

## Not ported

| Upstream | Why |
|---|---|
| The hook surface itself (`context`, `tool_result`, `turn_end`, `session_start`, `session_before_tree`, `session_tree`, `before_provider_request`, `input`, `agent_settled`, `session_compact`, `session_shutdown`) | Not reachable from the plugin code this port ships: a plugin's own process API has no agent event. It *is* reachable by contributing an ExtensionAPI module (`agent.extension`), which this port deliberately does not do — see "The hook surface, precisely". Each hook is replaced by an explicit tool (`obs_pack scan`, `compact_check`) or dropped with the behaviour it triggered. |
| Overriding the host's `edit` / `write` | Refused on *both* routes, and by name: a plugin cannot replace a host tool, and the agent-side extension loader rejects a reserved tool name with `rejected_registration: tool name "edit" is already taken`. See Action Fusion above. |
| Running native compaction, and `nativeCompactionFeasible` | Not possible from a plugin; see Online Context Compact above. |
| Appending/restoring state through session entries | Not exposed to plugins; state is kept in files. |
| TUI rendering (`renderSolPiTool`, `showSolPiSavings`, the status line) | Replaced by the work panel and by the result text. |


## The hook surface, precisely

The wording matters here, because the two routes differ and only one of them is used.

**A plugin's own code gets no agent hook.** `globalThis.pi` is built by `buildApi()` in
`out/main/plugin-host-process.js`, and its only event surface is `events.on` / `events.off`.
Four places in the host post an event frame to a plugin process, and between them they
carry seven names: `plugin:settingsChanged` (after `setSettings`), `bus.message`,
`net:websocket:<type>`, `session:modelChanged`, `session:turnEnded`, `appearance:changed`,
`workspace:changed`. None of them carries a tool result or a provider request;
`session:turnEnded` carries only `{ sessionId, turnId, reason }`. `session.getLlmContext`,
and `agent.complete` with `includeSessionContext`, read the session id from the plugin's
*in-flight tool call* (`readSessionContext`) and refuse otherwise:
`INVALID_ARGUMENT: session context is only available during tool execution`.

**The agent hook surface exists one layer down.** The agent runs in a sidecar that embeds
the same extension runtime `pi` uses, and a manifest can contribute ExtensionAPI modules:

```json
"contributes": { "agentExtensions": ["src/hook.js"] },
"permissions": ["agent.extension"]
```

Up to 8 entries per plugin, `.ts`/`.mts`/`.js`/`.mjs`, resolved inside the plugin root;
`PluginRuntime.registerAgentExtensions` records them and *"the modules are loaded by the
agent sidecar at the next turn"*. The host passes them per project
(`trustedExtensions: plugins.getAgentExtensions().filter(pluginActiveInProject…),
source: "plugin"`), and the sidecar loads them into the same runner that emits the
lifecycle events. That runner's own table (in the sidecar bundle) classifies every event
a handler may ask for:

| Class | Events |
|---|---|
| `result` — the return value changes what happens | `before_agent_start`, `context`, `before_provider_request`, `tool_call`, `tool_result`, `session_before_compact` |
| `mutation` | `before_provider_headers` |
| `notification` — informational only | `session_start`, `session_shutdown`, `session_info_changed`, `after_provider_response`, `agent_start`, `agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_start`, `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `session_compact`, `session_compact_failed` |
| `deferred` — **recognised but never emitted by PI-Desktop**; subscribing reports `unsupported_api: event "<name>" is not emitted by Desktop` | `project_trust`, `resources_discover`, `model_select`, `thinking_level_select`, `session_before_fork`, `input`, `user_bash`, `session_before_switch`, `session_before_tree`, `session_tree`, `ui_prompt_start`, `ui_prompt_end` |

| Upstream hook | Status | What it would give the port |
|---|---|---|
| `context` (ObservationPack's projection layer) | emitted, `result` | automatic replacement of already-replayed results — what `obs_pack scan` stands in for |
| `tool_result` (the reducer's trigger) | emitted, `result` | automatic candidate detection instead of an explicit `reduce_evidence` call |
| `before_provider_request`, `turn_end`, `agent_settled`, `session_compact`, `session_start`, `session_shutdown` (OCC) | emitted (`turn_end` · `agent_settled` · `session_compact` · `session_*` as notifications) | measuring the economics at every turn end instead of when `compact_check` is called |
| `input`, `session_before_tree`, `session_tree` (OCC's prompt rewrite and tree guard) | **deferred: never emitted** | nothing — unavailable on either route |
| `pi.registerTool({ name: "edit"｜"write", … })` (Action Fusion) | refused: `rejected_registration: tool name "edit" is already taken` (reserved names are the session's tool catalog) | nothing — the fused parameter can only ever live on a *separate* tool |

**Why this port ships only the plugin route.** Contributing an agent extension means
asking for `agent.extension` — the host's own description: *"Runs ExtensionAPI modules
inside the agent process with the same access as the agent's own tools. Enable only code
you trust."* Everything here is otherwise a tool call the user can read in the transcript,
with no code inside the agent process and all four mechanisms off by default; trading that
for automaticity is a posture change, not a bug fix, so it is the user's decision rather
than a default. The cost of the choice is visible in the table above: `obs_pack scan` and
`compact_check` exist *because* this route has no hook.

All of it is checkable on a local install: `buildApi()` in
`app.asar/out/main/plugin-host-process.js`, the four event-frame sites and `Lq` in the
app and sidecar bundles, and `registerAgentExtensions` in `PluginRuntime`.

## What proves what

`bash scripts/verify.sh --mutations` runs all of it: 18 files parse, the manifest
is byte-identical to what `lib/metadata.js` generates, 60 `node:test` assertions
pass, the 54-check offline gate passes against a strict stub of the real host API
(an invented API throws), and 8 mutations of this plugin are each caught by name.

The gate is deliberately adversarial about the claims in this document: that a
disabled mechanism refuses, that a refused call changes nothing on disk, that a
fabricated quote is never applied, that a credential-bearing log never reaches a
model, that an archive pages back byte-exact, that a scan does not touch its own
fused verdict, and that the shipped manifest matches the code that loads it.

## Known limitations (true of the port, not of upstream)

- A scan sees at most 8000 characters per tool result, so a result whose head is
  short but whose tail is huge is archived as the part the host exposed, and says
  so.
- Error results are not distinguishable in the context a plugin can read, so a scan
  cannot tell a failing result from a passing one; it packs by size and replay
  count only.
- `compact_check` measures and advises; it cannot compact.
- The economics needs a request horizon before it can price anything. When the plan
  has no completed boundaries yet, the decision says `horizon_unavailable` and
  stops there rather than guessing — this is upstream's behaviour, and it means the
  first verdicts arrive only after work has actually happened.