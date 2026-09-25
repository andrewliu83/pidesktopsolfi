---
name: SoL-Pi ObservationPack
description: Use when a tool result or file is too large to keep inline — obs_pack archives it and returns a placeholder, obs_recall reads the exact bytes back page by page. Covers the 10 KiB threshold, paging and when recall still works.
---

# ObservationPack (`plugin_local_sol_pi_obs_pack`, `plugin_local_sol_pi_obs_recall`)

Context gets one placeholder instead of thousands of log lines; the bytes themselves stay on disk, content-addressed, and come back exactly when you ask for them.

## `obs_pack`

- `action: "pack"` with `text` (or `path` for a project file) archives the bytes under a stable id (`obs_<sha24>`) and returns the placeholder to continue with, plus `original_bytes`, `lines`, `tokens`, and `removed_tokens`. Keep the placeholder; drop the original.
- Anything under **10240 bytes** is left alone — packing it costs more than it saves. The call says so and returns your text unchanged.
- `action: "scan"` looks at the session context for oversized tool results and returns their placeholders. Upstream's rule is kept: a result is worth packing when it has already been sent at least twice, because that is when the replay cost is real.
- `action: "list"` reports what this session already has archived.
- `tool` and `tool_call_id` record where a packed result came from, so the ledger says which command produced which archive.

Requires the `observationPack` setting for `pack` and `scan`.

## `obs_recall`

Read a stored observation by `id` and byte `offset`. The result carries `next_offset` and `eof`; keep calling with the new offset until `eof` is true. Pages are capped (16 KiB / 400 lines per page) and the header always states the exact bytes and lines you got, so a page cannot be mistaken for the whole thing.

Use `obs_recall` instead of re-running the command or re-reading the file that produced the archive. Re-running is slower, changes nothing about the answer, and can have side effects.

`obs_recall` and `obs_pack action: "list"` keep working even when the mechanism is switched off: evidence that has already been archived must stay readable even if the user stops packing new results. This is a deliberate divergence from upstream, which registers no recall hook at all when the mechanism is disabled.

## Limits worth knowing

- **PI-Desktop caps a projected tool result at 8000 characters**, so `action: "scan"` sees at most that much of any single result and cannot archive what it cannot see. If you still hold the full text, `action: "pack"` it directly — that path has no such cap.
- Archives live under the plugin's data directory, keyed by session, and are **never deleted automatically**. Nothing in this plugin prunes them, and no other mechanism reads them unless you ask.
- Observation ids are content-derived and validated before any file is opened; a malformed id is refused rather than guessed at.

## How to work

1. You get a huge result you no longer need in full → `obs_pack action: "pack"` with `text`, keep the placeholder, cite `original_bytes` and `removed_tokens` when you report the saving.
2. You need one detail back → `obs_recall` the id at offset 0, then follow `next_offset` until you have the region you need. Do not page in the whole archive just to quote one line.
3. You want to know what this session has archived → `obs_pack action: "list"`, or the SoL-Pi panel, which shows the same ledger with byte and token totals per pack.

Never describe an archive you did not personally read back with `obs_recall` as if you had verified its contents. The placeholder proves the bytes exist; it does not tell you what they say.
