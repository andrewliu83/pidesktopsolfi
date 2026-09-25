---
name: SoL-Pi Plan and Compaction Economics
description: Use when a long task needs explicit plan steps and compaction boundaries, or the user asks whether compacting now is worth it — plan_update records boundaries, compact_check returns a verdict and a carry-forward brief.
---

# Online Context Compact (`plugin_local_sol_pi_plan_update`, `plugin_local_sol_pi_compact_check`)

Compaction is expensive: the cache written at the boundary costs a multiple of a cache read, and if the context has little left to run, that cost never comes back. This mechanism decides with arithmetic instead of vibes.

Requires the `onlineContextCompact` setting.

## `plan_update`

Use it to state the plan and to mark where it is safe to compact.

- `steps`: an ordered list of steps, each with a description and a status (`pending`, `in_progress`, `done`, `blocked`, `skipped`). Keep it short — it is a contract with the user, not a transcript.
- `boundaries`: mark completed steps at which compaction is *safe*, e.g. after a milestone lands and its evidence has been recorded. A boundary is a claim that nothing before it is still needed in the live context.
- `completed_boundary` / `cumulative`: the request-count marks that let the arithmetic compare "compacting at the last boundary" with "compacting now".

The tool returns the plan snapshot and the step transitions it recorded, so a status change is visible in the result rather than implied.

## `compact_check`

Returns the verdict, the numbers it came from, and — when compaction is worth it — a carry-forward brief:

- **context tokens** measured from the live session context, and the model's context window, when the host reports one;
- **remaining horizon**: how many requests are left before the window fills at the observed rate, or `horizon_unavailable` when the session has too little history to estimate one (upstream refuses to guess from a tiny sample);
- **worth-it verdict**: `economic` when the saving pays for the cache write, or a specific reason it does not — `non_positive_saving`, `window_protection` (the window is nearly full, so compact regardless), `deferred_subsequent_margin`, `deferred_carried_debt`, `deferred_economic`, `cache_ratio_unavailable`.

Settings that drive it: `cacheWriteReadRatio` (upstream default 12.5) and `keepRecentTokens` (default 20000).

## The honest part: you cannot compact

Upstream SoL-Pi triggers compaction itself. A PI-Desktop plugin cannot: native compaction is a user action. So `compact_check` does the arithmetic, writes the carry-forward brief, and tells the user to run `/compact`. Do not claim you compacted anything, and do not try to imitate compaction by deleting context you cannot actually delete.

What the brief is for: it lists what must survive the boundary — the plan's open steps, the evidence that has been archived (with observation ids), the reducer decisions that applied, and the decisions the user made that no file records. The user pastes it, or keeps it open, when they compact.

## Working with it

1. Long task, several milestones → `plan_update` when the plan is agreed, and again whenever a step's status changes.
2. Record a boundary only when the preceding evidence is archived or already written to a file. A boundary over unrecorded work is how context gets lost.
3. When the user asks about context pressure, run `compact_check`, quote the verdict and its reason code, and hand them the brief if there is one.
4. If the verdict is a `deferred_*` reason, say what it is deferred on. Compacting two steps early can cost more than carrying the context a little longer.
