---
name: SoL-Pi Evidence Reducer
description: Use when a long build, test, lint or typecheck log needs condensing — reduce_evidence returns a receipt whose quoted lines are verified byte-for-byte against the archived original, or nothing. The only mechanism that calls a model.
---

# Evidence-Preserving Reducer (`plugin_local_sol_pi_reduce_evidence`)

A receipt you can trust more than a summary: every quoted line is checked byte for byte against the original log before the receipt is accepted, and a failing log that comes back without failure evidence is thrown away.

Requires the `evidencePreservingReducer` setting. It is off by default and it is **the only mechanism here that spends quota and sends text to a model** — treat enabling it as a decision for the user, not a convenience for you.

## What it accepts

- `text`: the log body to reduce. Keep this to build/test/lint/typecheck-shaped output.
- `command`: the command that produced the log. The reducer only proceeds for diagnostic commands — arbitrary pipelines and one-off scripts are refused.
- `is_error: true` when the command failed. A failing log whose receipt carries no failure evidence is discarded.
- `reducer_model` (optional): a `providerId/modelId` pair, overriding the configured reducer model for this call.

Refusals that happen **before** anything leaves the machine: log smaller than the minimum worth a model call, log over the reducer's 600,000-character limit, and logs that look like they contain a credential. Each is reported with the reason, and your original text is returned untouched.

## The receipt, and why it can be trusted

The receipt is only accepted when all of these hold:

- it is JSON matching `sol_pi_evidence_receipt_v1`;
- it carries the `source_sha256` of the archived original, matching the log byte for byte;
- every quoted line appears **exactly** in the archived log (a quoted line that cannot be found kills the receipt);
- a log that failed comes back with failure evidence;
- the receipt is strictly smaller than the original.

If any check fails, the mechanism **fails open**: `applied: false`, the reason, and your original text, unchanged and clearly labelled. That is the designed outcome, not an error to retry around. Do not loop on a rejected receipt — try a tighter log, or work from the original.

## Cost, and the host's limits

- The call goes through PI-Desktop's one-shot completion with the configured reducer model (`evidencePreservingReducerProvider` / `evidencePreservingReducerModel`). Upstream's default model is preserved; if the installation does not offer it, the call refuses with `reducer-model-unavailable` and nothing is spent.
- PI-Desktop rate-limits one-shot completions to **8 per 60 seconds per plugin** and ends a slow one at 90 seconds. The reducer reports a timeout as `model-call-timeout` rather than retrying.
- The original is archived, addressed by its own content hash, before the model is called. Archiving happens even when the reduction is later rejected, so the evidence survives a refusal.

## Working with it

1. Reduce only when the full log is genuinely noise: a long dependency install, a thousand passing tests, a repeated warning wall.
2. Report the receipt as a receipt — quote its evidence, state that quotes were verified against the archived original, and give `source_bytes` → `receipt_bytes`.
3. When it refuses, say so plainly ("the log looks like it contains a credential, so it was not sent") and continue with the original text.
4. The SoL-Pi panel lists every reducer decision — candidate, provider response, applied, fallback — with the reason and the source digest, so the user can audit a reduction without asking you.
