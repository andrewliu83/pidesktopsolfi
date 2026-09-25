# Changelog

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
