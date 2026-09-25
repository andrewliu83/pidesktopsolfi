# Changelog

## 0.2.0 — the hook surface, used; and the two switches that cost nothing, on

The 0.1.2 note ended by saying that shipping hook code "remains the user's decision
rather than a default". This release makes that decision, and it is narrower than the
sentence sounds:

- **`contributes.agentExtensions` declares `hooks/agent-hooks.js`**, a module PI-Desktop
  loads *inside its agent process*; the new `agent.extension` permission (the ninth) is
  what allows it. Its `context` handler is upstream's ObservationPack projection, run
  through this port's own libraries so the two routes cannot drift — `FULL_SENDS = 2`,
  the 10 KiB threshold, the exact placeholder, the shared `[then_run:…]` guard, and the
  `full` / `placeholder` ledger events. Its `turn_end` handler appends one line to
  `hook-route/measurements.jsonl` and returns **nothing**, because the runtime replaces
  a result only when it gets one: a measurement cannot change a conversation.
- **`observationPack` and the new `turnMeasurement` ship on.** Both were chosen because
  they cannot invent content: packing replaces a result the agent has *already received
  twice* (every byte archived first, pageable back with `obs_recall`), and the
  measurement only writes down what a turn cost. `actionFusion`,
  `evidencePreservingReducer` and `onlineContextCompact` stay off, and every refusal
  still names the setting to enable.
- **The panel says which route is live.** `hookRouteState` reads the module's
  `status.json` — written at load time into the shared bucket, and per session once a
  request has been served — and the observations table names the route that packed each
  one, so "why is this empty?" has an answer instead of a guess.
- **Three defects the harness found, fixed before shipping:** the per-turn record was
  being appended to the *observation* ledger (one file would let a turn record inflate
  the packed counts), `status.json` was written without creating its directory (a fresh
  session's panel would have said nothing at all), and the panel's saving total had no
  assertion against a later packing of the same observation overwriting it.

Verification grew with the surface: `eval/agent-hooks-harness.js` loads the module the
way the sidecar does (a temporary installation root, synthetic message arrays) and adds
10 checks to the offline gate — 64 now — while the mutation gate gained 7 mutants
(15/15 caught), including mutants for the two defects above. Unit tests: 61.

`README.md` and `docs/PORT-NOTES.md` were rewritten wherever they said this port does not
ship the hook route. `docs/PORT-NOTES.md` → "The hook route as built" states what the
module does, what it is allowed to touch, and its one resolver difference: the data root
comes from `PI_DESKTOP_DATA_DIR`, because the ExtensionContext the sidecar builds has no
`getSessionDir()` and upstream's `runtimeRoot(ctx)` therefore cannot resolve in Desktop.

## 0.1.2 — the hook claim, stated exactly

`docs/PORT-NOTES.md` said PI-Desktop exposes none of upstream's hooks. That was wrong as
written, and the deep check that replaced it is now in the repository:

- **What is true:** a plugin's *own* code receives no agent event. Its API
  (`buildApi()` in `out/main/plugin-host-process.js`) carries exactly seven event names,
  none of them a tool result or a provider request, and `session.getLlmContext` reads its
  session id from the plugin's *in-flight tool call* — refusing otherwise with
  `INVALID_ARGUMENT: session context is only available during tool execution`.
- **What was missing:** PI-Desktop embeds the same extension runtime upstream is written
  against. A manifest can contribute ExtensionAPI modules with
  `contributes.agentExtensions` plus the `agent.extension` permission, the host hands them
  to the agent sidecar per project, and that runner's event table classifies `context`,
  `tool_result`, `before_provider_request` and `tool_call` as `result` hooks — they exist,
  and they fire.
- **New section** `docs/PORT-NOTES.md` → "The hook surface, precisely": the plugin-route
  event catalog, the extension event table by class (`result` / `mutation` /
  `notification` / `deferred`), upstream hook by upstream hook, the events PI-Desktop
  recognises but never emits (`input`, `session_before_tree`, `session_tree`, …), and the
  loader's refusal of a reserved tool name — `tool name "edit" is already taken`. That last
  one is why the fused parameter can only ever live on a *separate* tool, on either route.
- **The posture is pinned:** tests now assert that no `agent.extension` is requested and
  that `contributes.agentExtensions` stays empty. Shipping hook code remains the user's
  decision rather than a default, because it means running code inside the agent process
  with the agent's own access.

No tool behaviour changed in this release. The documentation ships inside the package
(`README.md`, `CHANGELOG.md`, `docs/PORT-NOTES.md`), so the version moved with it.

## 0.1.1 — the session's own project folder answers too

`workspace.get()` is the *window's* project, and it is `null` whenever the window has
none open — an ordinary state in PI-Desktop, not an error. Every path-based tool
therefore resolved no project root and refused, even inside a chat that has a folder of
its own.

- `workspace.get()` is accepted in both shapes the host uses: the bare
  `{ path, name, roots }` and a `{ workspace: { … } }` envelope.
- When it answers `null`, the project the **session** records is used instead —
  `session.get({ id }).session.projectPath`, the same source the host reads to scope a
  session's file access. `fused_edit`, `obs_pack action "path"` and
  `reduce_evidence path` now work with no project open in the window.
- The refusal happens only when neither source has a folder, and it says which two were
  tried: *"No project is open, so there is no project root to work in."* followed by
  *"This session does not record a project folder either."*, *"Session lookup failed
  too: …"* (a failed lookup is disclosed, never treated as "no folder"), or *"No session
  was available to ask."*

Three gate checks and one mutation (`session.get({ id: sessionId })` → `session.get({ id:
"" })`) hold this in place, so the fallback cannot be dropped without the gate failing:
54 checks and 8 mutations in total. The panel is unchanged — it lists what the tools
actually wrote, so it stays empty until something is packed.

## 0.1.0 — first PI-Desktop port

Ported from [NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) `sol-pi` 0.1.0 (MIT).

- **Action Fusion** (`fused_edit`): one call applies a mutation and runs its
  validation command, with the upstream `[then_run:succeeded|failed|skipped]`
  markers. Per-file queue, hash guard before the command, atomic writes, and the
  upstream refusal of absolute paths, `..`, and credential paths and directories.
  Upstream's `@`-prefixed paths, `file://` URLs and unicode-space normalisation are
  accepted, then forced back inside the project root.
- **ObservationPack** (`obs_pack`, `obs_recall`): the 10 KiB rule, the
  `obs_<sha24>` derivation from `toolName\0toolCallId\0contentHash`, the
  content-addressed store with size and hash checks, the exact placeholder text,
  and byte or line paging with the 16 KiB / 400 line caps.
- **Evidence-Preserving Reducer** (`reduce_evidence`): every receipt field is
  checked against the archived source before it is trusted — schema, source hash,
  status, evidence kinds — and every quote must appear in the original text. A
  receipt that fails any check returns the original text untouched.
- **Online Context Compact** (`plan_update`, `compact_check`): plan boundaries,
  the carry-forward brief, and the compaction economics
  (`cacheWriteReadRatio` 12.5, first-compaction scale 2, subsequent margin 1.5,
  16 KiB window reserve, the eight reason codes the decision function can return).
  Upstream's ninth code, `native_not_compactable`, is applied by its extension when
  the *host's* native compaction is not feasible — a plugin cannot observe that, so
  the port says so to the user instead of emitting it.
- Work-panel view, four commands, five skills, eight settings, and an offline
  verification gate plus mutation gate.

### Deliberate differences from upstream

See `docs/PORT-NOTES.md` for the full list and the reason for each one.

- All four mechanisms ship **disabled**, and every tool that belongs to a
  disabled mechanism refuses with the setting's name.
- PI-Desktop has no context-projection hook, so the trigger for ObservationPack
  and the reducer moved to the agent (`obs_pack`, `reduce_evidence`) and to a scan
  of the live session context.
- A plugin cannot run the host's native `/compact`, so `compact_check` reports the
  verdict, writes the brief, and tells the user to run `/compact`.
