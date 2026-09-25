---
name: SoL-Pi Overview
description: Use when a long PI-Desktop turn is burning context, a tool result is huge, an edit needs immediate validation, a diagnostic log needs condensing, or the user asks about SoL-Pi. Explains which mechanism to reach for and what is on.
---

# SoL-Pi for PI-Desktop

SoL-Pi is NVIDIA's agent-efficiency work, ported here as a PI-Desktop plugin. It gives you four mechanisms, each aimed at one way a long agent turn wastes context. **All four ship disabled.** They are opt-in because two of them change how you call tools and one of them spends quota.

Check what is on before relying on anything: run `plugin_local_sol_pi_plan_update`'s sibling tool `plugin_local_sol_pi_compact_check` only after the user has enabled that mechanism, or read the SoL-Pi panel (`SoL-Pi` view in the work panel, or the `SoL-Pi: Open` command). A disabled mechanism refuses with a message naming the setting to change — a refusal is not a bug to work around, it is the user saying "not now".

## The four mechanisms and their tools

| Mechanism | Setting key | Tools | What it buys |
| --- | --- | --- | --- |
| Action Fusion | `actionFusion` | `plugin_local_sol_pi_fused_edit` | One call does the edit and the command that validates it, so no model decision is spent between them |
| ObservationPack | `observationPack` | `plugin_local_sol_pi_obs_pack`, `plugin_local_sol_pi_obs_recall` | A huge result leaves context but stays readable, byte for byte, by page |
| Evidence-Preserving Reducer | `evidencePreservingReducer` | `plugin_local_sol_pi_reduce_evidence` | A long build/test/lint log becomes a receipt whose quotes are checked against the original |
| Online Context Compact | `onlineContextCompact` | `plugin_local_sol_pi_plan_update`, `plugin_local_sol_pi_compact_check` | Plan steps and boundaries plus a paid-for-by-arithmetic verdict on whether compacting now is worth it |

The user turns them on in the panel, in PI-Desktop's plugin settings, or with the `SoL-Pi: Enable the two local mechanisms` command (Action Fusion + ObservationPack only — the other two need explicit intent). `SoL-Pi: Disable every mechanism` turns everything off again.

## Choosing a mechanism

- After an edit you already know the follow-up command for (build, test, run, lint, restart) → `fused_edit` with `then_run`. This is the single biggest saving and the most common one.
- A tool result is huge and you are done reading it in full → `obs_pack` (`action: "pack"`) and keep the placeholder. Later, `obs_recall` with `next_offset` reads the exact bytes back.
- A turn has accumulated oversized results you no longer need inline → `obs_pack` with `action: "scan"` lists and packs them.
- A build/test/lint log is long and only its first error and failure lines matter → `reduce_evidence`. It is the one tool here that can spend money or quota.
- The user is running a long task and asks whether to compact → `compact_check`; if the arithmetic says compact, hand the returned brief to the user and tell them to run `/compact`.

## Honest differences from upstream SoL-Pi

These are real, and you should not paper over them:

1. **Compaction is advice, not action.** Upstream SoL-Pi compacts the conversation itself. A PI-Desktop plugin cannot trigger native compaction — that is a user action (`/compact`). `compact_check` therefore writes a carry-forward brief and tells the user to compact; it never compacts for them.
2. **The mechanisms are tools here.** Upstream hooks fire automatically inside the agent runtime. PI-Desktop exposes tool registration, prompt skills and a one-shot completion, so each mechanism became a tool you call deliberately. Nothing fires behind your back.
3. **PI-Desktop caps one tool result at 8000 characters** when it projects the session, so `obs_pack` `action: "scan"` can only see that much of any single result. It says so when it matters; packing a result you still hold in full is always preferable.
4. **Plugin tools are unavailable in Plan and Goal mode.** PI-Desktop 0.15.x refuses plugin tools in those modes, so do not plan around them there.
5. **Observation archives are per session**, under the plugin's own data directory, keyed by session id, and are never deleted automatically.

## Non-negotiables

- Never archive or reduce text that contains credentials. `reduce_evidence` refuses logs that look like secrets; `fused_edit` refuses `.env*`, `.ssh/`, `.aws/`, `*.pem`, `*.key` and `.git/`.
- Evidence first: if a mechanism cannot verify what it produced, it returns the original text and says why. Trust the original.
- Say what you did. When you pack, reduce or plan, the user should be able to see the same ledger entries the panel shows.
