# PI-Desktop live acceptance

## Installation and defaults

The user loaded the persistent repository through the official development-plugin
UI, granted the requested permissions, and restarted PI-Desktop after the data-root
fix. The registry reported `local.sol-pi` 0.2.0 as development-source, globally
enabled and ready; logs also showed successful load/hot-reload.

Registry readiness alone is not acceptance. The following checks used the
installed tools and actual automatic hook output.

The default settings were retained: ObservationPack and turn measurement on;
Action Fusion, the reducer and compaction planning off.

## Installed tool checks

- A 162-byte synthetic sample was correctly skipped below threshold.
- An 11,514-byte sample containing Chinese text and emoji produced a 486-byte
  placeholder. Recall returned pages of 8,192 and 3,322 bytes; joining them
  reproduced the original bytes and SHA-256 exactly.
- Disabled Action Fusion refused before either file mutation or command execution.

## Automatic projection to recall

Initial testing exposed the split-root bug described in
[Windows verification](WINDOWS-VERIFICATION.md). After the fix and full restart:

1. New hook status, turn measurements and automatic observation ledger events
   appeared under
   `<host-data>/plugins/data/local.sol-pi/sessions/<bucket>/`.
2. The legacy host-level session ledger and measurements stopped updating.
3. An observation actually projected by the hook was successfully read through the
   installed `obs_recall` tool from the canonical plugin storage.

This closes the live automatic-projection-to-recall path; it is not inferred from
an isolated harness or a ready flag.

## Existing archives

For this local installation, 16 plugin-owned legacy archive objects (301,177 bytes)
were copied into canonical session storage and byte-checked with SHA-256. Their
ledger was merged; historical measurements were kept separately. Originals were
retained and status files were not copied. Installed recall also read a migrated
archive successfully.

This was a local recovery operation, not a migration shipped by this PR. Users
with old split-root archives should preserve originals and verify any manual
recovery before removing data; the code fix routes new writes but does not move
existing archives automatically.

## Limits

- Development-directory installation was verified; packaging was not rerun.
- Enabled Action Fusion execution was not tested through the Desktop tool path.
- The reducer and compaction planner were intentionally not exercised.
- No billing reduction or cross-platform Desktop behavior is claimed.
- Local logs, session identifiers, archives and ad-hoc harnesses are not included
  in this repository.
