# SoL-Pi for PI-Desktop

A **PI-Desktop plugin** that ports the four mechanisms of
[NVlabs/SoL-Pi](https://github.com/NVlabs/SoL-Pi) — Action Fusion,
ObservationPack, the Evidence-Preserving Reducer, and Online Context Compact —
onto the PI-Desktop plugin API.

It is a port, not a wrapper: the thresholds, byte limits, id and hash
derivations, receipt schema, marker strings, reason codes and economics
constants are the upstream ones, and `docs/PORT-NOTES.md` lists every place where
PI-Desktop forced a different design together with the reason.

Everything is **off until you turn it on**. Nothing here talks to the network.

```
fused_edit      mutate a file and run its validation command in one call
obs_pack        archive a large result, or scan the live context for candidates
obs_recall      read an archived result back, exactly, by byte or line
reduce_evidence turn a long log into a checked receipt, or keep the original
plan_update     record the plan and mark progress boundaries
compact_check   decide whether compacting now pays for itself, and write the brief
```

## 中文摘要

把 SoL-Pi 的四个机制移植成 **PI-Desktop 插件**（不是 pi CLI 扩展）：Action
Fusion（一次调用完成改文件 + 跑校验命令）、ObservationPack（大结果存档、按字节
分页召回）、Evidence-Preserving Reducer（长日志压缩成可逐字校验的收据）、Online
Context Compact（计划边界 + 压缩经济学）。

关键点：

- 四个机制**默认全部关闭**，每个工具在对应机制关闭时会明确拒绝并指出设置名；
- 所有阈值、字节上限、id/哈希推导、收据字段、标记字符串、原因码与经济学常数
  都沿用上游，逐条对照见 `docs/PORT-NOTES.md`；
- PI-Desktop 没有上下文投影钩子、插件也无法触发原生 `/compact`，所以触发点被
  诚实地移到 agent（工具）与工作面板，并记录为「移植差异」而不是假装等价；
- 仓库自带离线验收门 + 变异测试门（`bash scripts/verify.sh --mutations`），
  在没有 app、没有网络、没有模型调用的情况下验证 110 项检查。

## Requirements

- PI-Desktop 0.15.x (developed and verified against 0.15.7).
- Node.js 20+ for the verification scripts (developed on 24.x). The plugin itself
  uses Node built-ins only and declares no dependency.

## Install

Both supported routes go through the app's **Plugins** page:

**Develop from this folder.** Plugins page → *Load development plugin* → point at
this directory. The app loads it, watches it, and reloads it whenever a file is
saved here — that is the fastest way to try a change.

**Install it the way a user would.** Package it, then install the package:

```bash
bash scripts/verify.sh                              # optional: prove it first
```

Then ask the agent to run `PluginPack` on this directory (or run
`pnpm pi-plugin pack .`), which writes
`dist/local.sol-pi-0.1.0.piplug`. Install that file from the Plugins page; the app
asks you to grant `agent.tool.register` and `agent.prompt.inject` on the way in.

Copying this folder into `~/.pi-desktop/plugins/installed/` by hand is **not** one
of those routes: the app keeps its own registry of installed plugins, so a dropped
folder is invisible to it. Use one of the two above.

The folder must keep its shape either way: `manifest.json` and `main.js` at the
top level.

Then open the panel (`SoL-Pi: Open panel`) or run one of the commands below, and
turn on the mechanisms you want. The conservative preset —

```
SoL-Pi: Enable local mechanisms   (solPi.enableLocal)
```

— enables **Action Fusion and ObservationPack only**: both act locally, and
neither spends a model call. The reducer (`evidencePreservingReducer`) and the
compaction economics (`onlineContextCompact`) stay off until you enable them
deliberately.

## Settings

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `actionFusion` | boolean | `false` | Lets `fused_edit` run the follow-up command |
| `observationPack` | boolean | `false` | Lets `obs_pack` and `obs_recall` archive and page results |
| `evidencePreservingReducer` | boolean | `false` | Lets `reduce_evidence` spend one model call |
| `onlineContextCompact` | boolean | `false` | Lets `plan_update` and `compact_check` work |
| `evidencePreservingReducerProvider` | string | `openai-codex` | Provider id for the reducer call (upstream's default) |
| `evidencePreservingReducerModel` | string | `gpt-5.6-luna` | Model id for the reducer call |
| `cacheWriteReadRatio` | number | `12.5` | Cache write-to-read price ratio used by the economics |
| `keepRecentTokens` | number | `20000` | Recent tokens kept verbatim when compaction is evaluated |

The keys keep their upstream names on purpose: a settings file that worked with
SoL-Pi keeps its meaning here. The reducer's default model key is upstream's
`openai-codex/gpt-5.6-luna`; if your PI-Desktop has no such provider, point
`evidencePreservingReducerProvider` / `Model` at a model you do have — the
refusal tells you so when a call cannot be made.

## Commands

| Command | What it does |
| --- | --- |
| `solPi.open` | Opens the work panel |
| `solPi.enableLocal` | Enables Action Fusion and ObservationPack only |
| `solPi.disableAll` | Turns all four mechanisms off |
| `solPi.compactBrief` | Writes the carry-forward brief and tells you to run `/compact` |

## Tools

### `fused_edit` — Action Fusion

One call: apply the mutation, then run the command that proves it.

```json
{
  "action": "edit",
  "path": "src/parser.ts",
  "old_string": "parse(input)",
  "new_string": "parse(input, options)",
  "then_run": { "command": "npm test -- parser" }
}
```

- Refuses absolute paths and `..`, and refuses credential paths (`.ssh`, `.aws`,
  `.git`, `.gnupg`, `.kube`) and credential-looking file names (`.env*`, `*.pem`,
  `*.key`, `id_rsa*`, `*credentials*`, `*.p12`, `*.pfx`).
- Accepts the forms upstream accepts — `@src/app.js`, a `file://` URL, unicode
  spaces — resolves them, and then forces the result back inside the project root.
- Writes atomically (temporary file + rename), serialises concurrent calls to the
  same file, and re-hashes the file before running the command.
- A command that fails keeps the mutation and reports
  `[then_run:failed]` with its exit code; a mutation that fails skips the command
  with `[then_run:skipped]`.

### `obs_pack` / `obs_recall` — ObservationPack

A large tool result leaves the context but never the machine.

```json
{ "action": "pack", "text": "<a very long result>", "tool": "bash" }
{ "action": "scan" }
{ "action": "list" }
```

```json
{ "id": "obs_1f0c…", "offset": 0, "max_bytes": 16384 }
```

- The threshold is upstream's: results **larger than 10 KiB** participate.
- The id is upstream's derivation: `obs_` plus the first 24 hex digits of
  `sha256("toolName\0toolCallId\0sha256(text)")`, written to a content-addressed
  file whose size and hash are re-checked on every reuse.
- Pages are exact bytes: `obs_recall` returns the text plus a header carrying
  `next_offset` and `eof`. Reassembling every page reproduces the original byte
  for byte (the gate asserts this).
- `scan` never rewrites your conversation — it reads the live context, finds tool
  results that have already been replayed at least twice, archives them and hands
  you the placeholders to use. It also never packs its own `[then_run:…]` results
  or an existing reducer receipt.

### `reduce_evidence` — Evidence-Preserving Reducer

```json
{ "text": "<a long failing log>", "command": "npm test", "is_error": true }
```

- The raw log is archived first; every receipt field is then checked against that
  archive: schema, source hash, status that matches `is_error`, allowed evidence
  kinds, and **every quote must appear in the original text**.
- A receipt that fails any check is discarded and you get the original text back,
  unchanged — there is no partial reduction.
- A log that looks like it carries a credential (`api_key=`, `authorization:`,
  `bearer`, `access_token`, `secret=`) is never sent to a model at all.
- A command that is not a build/test/lint command is refused before anything is
  archived.

### `plan_update` / `compact_check` — Online Context Compact

```json
{
  "steps": [
    { "id": "port", "goal": "port the four mechanisms", "status": "completed" },
    { "id": "ship", "goal": "push the repo", "status": "in_progress" }
  ],
  "progress": { "verification": ["bash scripts/verify.sh"] }
}
```

```json
{ "keep_recent_tokens": 20000, "remaining_boundaries": 3 }
```

- A step that turns `completed` is a **boundary**: the plan snapshot, the brief
  path, and the state are written to disk so the work survives the checkpoint.
- `compact_check` decides with upstream's economics: the break-even request count
  from the cache write-to-read ratio (12.5), the first-compaction scale (2), the
  subsequent margin (1.5), the 16 KiB window reserve, and the carry-forward debt.
  It reports one of the upstream reason codes (`economic`, `window_protection`,
  `non_positive_saving`, `horizon_unavailable`, `cache_ratio_unavailable`,
  `deferred_subsequent_margin`, `deferred_carried_debt`, `deferred_economic`).
  (upstream's ninth code, `native_not_compactable`, depends on the *host's* own
  compaction being infeasible, which a plugin cannot observe — `docs/PORT-NOTES.md`)
- **A plugin cannot run the host's native compaction.** `compact_check` therefore
  measures, decides, writes the brief — and tells you to run `/compact` yourself.
  That is an honest adaptation, not a silent no-op.

## Where the data lives

Everything is per session, under the plugin's own data directory
(`pi.plugin.getDataPath()`, i.e. `~/.pi-desktop/plugins/data/local.sol-pi/`):

```
sessions/<bucket>/observation-pack/objects/<id>.txt
sessions/<bucket>/observation-pack/ledger.jsonl
sessions/<bucket>/evidence-preserving-reducer/objects/<hh>/<sha256>.txt
sessions/<bucket>/evidence-preserving-reducer/journal.jsonl
sessions/<bucket>/online-context-compact/plan.json
sessions/<bucket>/online-context-compact/compaction-brief.md
```

The panel lists these buckets and can read any archive back in exact pages.

## Verification

```bash
bash scripts/verify.sh              # syntax, manifest freshness, unit tests, offline gate
bash scripts/verify.sh --mutations   # …plus the mutation gate
```

What that proves, and how:

| Step | What it checks |
| --- | --- |
| Syntax | All 18 source files parse |
| Manifest freshness | `manifest.json` is byte-identical to what `lib/metadata.js` generates; the plugin also re-checks this at load time and refuses to load on drift |
| Unit tests | 60 `node:test` assertions over config resolution, the observation store and paging, receipt validation, the economics decisions, plan parsing, and path containment |
| Offline gate | 54 checks that load the plugin against a **strict stub of the real host API** (an invented API throws), then exercise every tool, every refusal, the panel channels, the commands, and unload |
| Mutation gate | Breaks one guarantee at a time (opt-in removed, manifest drift, a byte dropped from an archive, receipt verification skipped, an invented host API, the credential guard weakened, the fused-result guard disarmed, the session-project fallback disarmed) and requires the gate to fail **by name**: 8/8 caught |

The gate is deliberately adversarial about this plugin's own claims: it asserts
that a disabled mechanism refuses, that a refused call changes nothing on disk, a
fabricated quote never gets applied, a credential-bearing log never reaches a
model, and no oversized tool result is ever returned as a quiet success.

PI-Desktop's own packaging check (`PluginCheck`) passes on this directory and
reports two warnings, both expected:

- *high-risk permissions require an explicit user grant* — `agent.tool.register`
  and `agent.prompt.inject` are what make the six tools and the post-compaction
  instruction possible at all. The host asks you to grant them when you install.
- *`clipboard.write` is declared but `main.js` never calls `clipboard.writeText`* —
  the call happens in the panel (`views/app.js`), and the host serves that channel
  itself behind this permission. Removing the permission would break the Copy
  button, so the warning is a limit of the static check, not a dead permission.
  (`notify` was removed for exactly the opposite reason: nothing needed it.)

## Security posture

- Least privilege: `ui.view`, `ui.panel`, `clipboard.write`,
  `agent.tool.register`, `agent.prompt.inject`, `agent.complete`, `session.read`,
  `models.list`. No filesystem, network, desktop-control or browser permission is
  requested; file access is project-relative and re-checked on the real path.
  `clipboard.write` is the panel's Copy button (the host serves that channel behind
  this permission), and `notify` is deliberately absent: this plugin only shows
  toasts, and the host does not gate `ui.showToast` on the notification APIs.
- No network access of its own: the only model access is the host's
  `pi.agent.complete`, with the reducer's own prompt marking the log as untrusted
  data and one shot per call.
- All four mechanisms ship disabled, and refusals name the setting to enable.
- Archive files are written `0600` inside `0700` directories.

## Honest limitations

- **No context hook.** PI-Desktop gives a plugin no way to rewrite the message
  projection, so nothing is replaced behind your back: `obs_pack` and
  `reduce_evidence` are called by the agent (or by the scan) and hand back the
  text to use. The archive format, the id derivation and the paging contract are
  unchanged, which is what makes an archived result still readable the same way.
- **`scan` sees what a plugin can see.** The host hands a plugin at most 8000
  characters of one tool result, so a scan uses that as its floor and says so in
  its output; a result you still hold in full can be packed directly with
  `action: "pack"`.
- **Error results are not detectable in the context view.** Upstream keeps a
  failing tool result verbatim; the plugin cannot see the `isError` flag from
  `getLlmContext()`, so `scan` cannot apply that rule — the gate documents this
  rather than pretending otherwise.
- **No native compaction.** See `compact_check` above: the plugin prepares the
  checkpoint, the user runs `/compact`.
- **`obs_recall`, `obs_pack list` and `obs_pack pack` stay usable while
  ObservationPack is off** on purpose: evidence you already archived must never be
  stranded because a setting was turned off. Everything that *spends* or *scans*
  refuses.

## Repository layout

```
manifest.json          generated from lib/metadata.js (never hand-edited)
main.js                plugin entry: tools, commands, panel channels
lib/                   the ported mechanisms and the host adapter
views/                 the work-panel UI (no remote resources, no inline script)
skills/                five skills PI-Desktop loads for the agent
test/                  node:test unit tests
eval/host-stub.js      strict stub of the PI-Desktop plugin API
eval/offline-check.js  the offline gate
eval/mutation-check.sh proves the gate fails on a broken plugin
scripts/verify.sh      one command for everything above
docs/PORT-NOTES.md     mechanism-by-mechanism port map and every divergence
```

## License

MIT — see `LICENSE`. Ported from SoL-Pi, Copyright (c) 2026 NVIDIA CORPORATION &
AFFILIATES, also MIT — see `THIRD_PARTY_NOTICES.md`.
