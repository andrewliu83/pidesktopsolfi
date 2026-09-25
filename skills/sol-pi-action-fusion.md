---
name: SoL-Pi Action Fusion
description: Use when an edit's next step is a known command (run, build, test, lint, restart, install) — one fused_edit call replaces an edit followed by a separate command call. Covers refusal rules and the then_run result markers.
---

# Action Fusion (`plugin_local_sol_pi_fused_edit`)

Two turns of work collapse into one call: mutate a file, then immediately run the command that tells you whether the mutation was any good. The model decision that used to happen between the edit and the check simply does not exist any more.

Requires the `actionFusion` setting. When it is off the tool refuses; use your normal edit and shell tools instead and do not retry.

## When it pays

- You already know the follow-up command: `npm test`, `pytest -q`, `go build ./...`, `cargo check`, `make`, `python script.py`, a lint or typecheck, a dev-server restart.
- The check is fast (well under the host's 110-second tool limit) and its output is what you would read next anyway.

## When not to use it

- You do not yet know what command should follow — explore first, then edit normally.
- The change spans several files: `fused_edit` touches exactly one file per call.
- The follow-up is a long-running server or watch loop. Start it separately; a 110-second timeout will only burn the call.
- The path is a credential or VCS-internal file. It will be refused (see below).

## Arguments

- `action: "edit"` with `path`, `old_string`, `new_string`, and optionally `replace_all: true`. Without `replace_all` the `old_string` must appear exactly once, or the call fails without touching the file.
- `action: "write"` with `path` and `content` replaces the whole file.
- `then_run: { command, timeout? }` — `command` runs in the project root; `timeout` is in **seconds**. Omitted means the command has no timeout of its own, but the host still ends the whole call at 110 seconds.

## Reading the result

- `[then_run:succeeded]` — mutation applied, command exited 0. The command output follows.
- `[then_run:failed]` — command exited non-zero. **The mutation is kept**; the failure is reported, along with the exit code and the output. A failing check after a correct edit is normal; fix it in the next call.
- `[then_run:skipped]` — the mutation failed, or the file changed underneath the call, so the command never ran. Fix the edit (or re-read the file) rather than assuming the command told you anything.
- The result also reports `exit_code` and the mutation's byte delta, so you can quote the change back to the user without re-reading the file.

## Refusals, and why

- **Absolute paths, `..`, and paths escaping the project root** (including through a symlink) — the tool only ever writes inside the project.
- **Credentials and VCS internals**: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`, `*.p12`, `*.pfx`, and any path whose segments include `.ssh`, `.aws`, `.git`, `.gnupg`, `.kube`.
- **A stale edit**: if the file's hash changed between the read the tool performs and the write, the write is refused, and the `then_run` command is not run against a file nobody verified.
- **Shell timeouts over the tool budget**, and per-stream output beyond 200 KiB (the tail is kept; the cap is stated in the result).

Every refusal names the rule it hit. Do not work around a refusal by copying the same content through another channel.

## Examples

Edit and test in one call:

```
action: "edit"
path: "src/parser.js"
old_string: "if (depth > MAX_DEPTH) return null;"
new_string: "if (depth > MAX_DEPTH) throw new DepthError(depth);"
then_run: { command: "npm test -- parser", timeout: 90 }
```

Write and typecheck:

```
action: "write"
path: "src/deep.ts"
content: "..."
then_run: { command: "npx tsc --noEmit", timeout: 120 }
```

If the edit does not stand on its own — no `then_run` — pass no `then_run` at all rather than inventing a command to fill the slot. An unused mutation is cheap; a wrong command costs a whole call and can leave a server running.
