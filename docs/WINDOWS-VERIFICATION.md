# Windows compatibility verification

## Scope and environment

This report covers the compatibility fixes against port version 0.2.0, based on
commit `50ef7a0`. Local checks ran on Windows with Node.js 24.21.0 and Git for
Windows. It is a local verification report, not a claim that remote CI or other
operating systems have passed.

## Fixed defects

### Command quoting and lifecycle

The previous Windows invocation combined Node's argument quoting with
`cmd.exe /s /c` parsing. Commands with a quoted executable and script path could
lose output or incorrectly appear successful. The runner now constructs the
command string explicitly with `windowsVerbatimArguments` and disables cmd
AutoRun through `/d`.

Windows timeout/abort uses `taskkill.exe /pid <pid> /t /f` to terminate the normal
shell descendant tree. Spawn errors are retained, already-aborted calls do not
start, and completion clears termination timers. A hard shutdown deadline bounds
waiting when inherited output pipes do not close. That fallback reports:

> Output pipes did not close after termination; background-process cleanup could not be confirmed

It does not claim to clean up detached or orphaned workers after their parent
shell has exited. The unreferenced-worker example returned normally on this
machine; the stuck-pipe branch is separately covered with a deterministic stub.

### Canonical hook data root

The old directory heuristic accepted any existing `sessions` directory. A
normal host root already has one, so a fresh hook could cache the host root while
tools and the panel used the plugin root. That split made automatic archives
unavailable to tool recall and could read the wrong settings file.

The hook now derives exactly one directory:

`<PI_DESKTOP_DATA_DIR>/plugins/data/local.sol-pi`

It uses that directory even before it exists and refuses a missing host root
rather than guessing. Regression tests cover fresh host layout, cached resolution,
and isolation from host-level settings. This is not a Windows-only defect.

### Portable verification

Tests use native path separators, explicit directory aliases, Windows junctions
without requiring symlink privileges, and CRLF-compatible frontmatter matching.
The offline compaction check requires `/compact` only for a positive verdict.

`scripts/verify.mjs` replaces shell glob expansion and retains the shell wrapper.
The workflow targets Windows, macOS and Linux with Node 22 and 24. The mutation
gate still requires Bash, tar, grep and sed; on Windows the runner uses Git for
Windows Bash when present, or `SOL_PI_TEST_BASH` if explicitly supplied.

## Reproduce

From the repository root:

```powershell
node scripts/verify.mjs --mutations
git diff --check
```

Observed local result:

- 71/71 unit tests passed, including real-process quoting and process-tree tests.
- 64/64 offline checks passed.
- 15/15 deliberately broken mutations were caught.
- Source syntax and manifest/metadata consistency checks passed.
- `git diff --check` passed.

## Desktop acceptance and limits

See [live acceptance](LIVE-ACCEPTANCE.md) for development-directory installation,
automatic projection and exact recall evidence. The desktop end-to-end run kept
Action Fusion disabled: its refusal was verified, while enabled command execution
was exercised by the local runner tests, not the Desktop tool path.

The installed Electron executable and trusted extension runner were also tested
in isolation with the real Windows absolute-path extension identifier and a fresh
host root containing `sessions`: first two sends stayed full, the third used a
placeholder, bytes were archived exactly, and status used the canonical root.
That isolated harness is supporting evidence, not a substitute for the live run.

`PluginCheck` and `PluginPack` could not resolve a workspace in the verification
conversation. No new `.piplug` or packaging-check result is claimed. The reducer
and compaction planner were not enabled or exercised in the live run. These
results demonstrate functionality, not measured model-billing savings.
