"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * Tool descriptors are pure data: the single source of truth for every tool the
 * plugin gives the agent. `lib/metadata.js` derives `contributes.agentTools`
 * from this list, and `main.js` registers exactly this list and asserts that the
 * shipped manifest still agrees with it. A partial rename therefore cannot ship.
 */

const THEN_RUN_SCHEMA = {
  type: "object",
  description:
    "Command to run next on this file after the mutation succeeds — e.g. run, build, start/restart, install, or check it; optional timeout in seconds. Skipped if the mutation fails; a non-zero exit is reported but keeps the mutation.",
  properties: {
    command: { type: "string", description: "Command to run in the project root." },
    timeout: {
      type: "number",
      description:
        "Timeout in seconds. Omitted means no timeout of its own; the host still ends the whole tool call at 110s.",
    },
  },
  required: ["command"],
  additionalProperties: false,
};

const FUSED_EDIT = {
  name: "fused_edit",
  risk: "high",
  planSafeActions: [],
  description:
    "Mutate one project file and, in the same call, run the follow-up command that validates it. " +
    "Use it instead of a separate edit/write plus bash pair whenever the next action after the edit is a known command " +
    "(build, test, run, lint, restart). Returns one combined observation, so the model decision between two turns disappears. " +
    "`action: \"edit\"` replaces old_string with new_string (exact match, must be unique unless replace_all); " +
    "`action: \"write\"` replaces the whole file with content. " +
    "When then_run is given and the mutation fails, or when the file changes underneath the fused call, the command is skipped and the result is marked [then_run:skipped]; " +
    "a command that exits non-zero keeps the mutation and is marked [then_run:failed]. " +
    "Paths are relative to the project root; credentials (.env*, .ssh/, .aws/, *.pem) and .git/ are refused.",
  schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["edit", "write"],
        description: "edit replaces a unique substring; write replaces the whole file.",
      },
      path: { type: "string", description: "Project-relative file path." },
      old_string: { type: "string", description: "edit: exact text to replace." },
      new_string: { type: "string", description: "edit: replacement text." },
      replace_all: {
        type: "boolean",
        description: "edit: replace every occurrence instead of requiring a unique match.",
      },
      content: { type: "string", description: "write: the complete new file content." },
      then_run: THEN_RUN_SCHEMA,
    },
    required: ["action", "path"],
    additionalProperties: false,
  },
};

const OBS_PACK = {
  name: "obs_pack",
  risk: "medium",
  planSafeActions: ["scan", "list"],
  description:
    "Keep a large tool result reachable without replaying it. " +
    "`action: \"pack\"` archives text (or a file) under a stable observation id and returns the exact placeholder to continue with, so the bytes leave the context while the evidence stays local and recallable. " +
    "`action: \"scan\"` lists the oversized tool results in the live session context, archives them and returns their placeholders — use it when a long turn has accumulated logs you no longer need in full. " +
    "`action: \"list\"` reports what this project already has archived. " +
    "Archived bytes are never deleted automatically; read them back exactly with obs_recall.",
  schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["pack", "scan", "list"], description: "pack, scan or list." },
      text: { type: "string", description: "pack: the text to archive." },
      path: { type: "string", description: "pack: project-relative file to archive instead of text." },
      tool: { type: "string", description: "pack: tool name to record as the source." },
      tool_call_id: { type: "string", description: "pack: tool call id to record as the source." },
      min_bytes: {
        type: "number",
        description: "scan: only report results at least this large (default 10240).",
      },
      limit: { type: "number", description: "scan/list: maximum entries to report (default 20)." },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

const OBS_RECALL = {
  name: "obs_recall",
  risk: "low",
  planSafeActions: [],
  description:
    "Read a stored large tool result by observation id and byte offset. " +
    "Returns an exact page plus a next_offset header; keep calling with next_offset until eof=true. " +
    "Use it instead of re-running the command or re-reading the file that produced an archived observation.",
  schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Observation id from a placeholder, e.g. obs_ab12…." },
      offset: { type: "number", description: "Byte offset to start at; default 0." },
      max_bytes: {
        type: "number",
        description: "Page size in bytes; hard-capped at the built-in page size.",
      },
    },
    required: ["id"],
    additionalProperties: false,
  },
};

const REDUCE_EVIDENCE = {
  name: "reduce_evidence",
  risk: "high",
  planSafeActions: [],
  description:
    "Turn a long build/test log into a compact receipt whose every retained quotation is verified byte for byte against the archived original. " +
    "Give exactly one source: `text`, or `path`, or `observation_id` from obs_pack. " +
    "Pass `command` and `is_error` so the receipt can be checked against what actually ran. " +
    "A receipt is only returned when the schema matches, the source hash matches, the status matches is_error, every quote is found in the archive, and the receipt is smaller than the original; " +
    "otherwise the original text is returned unchanged with the reason, so a failed reduction never hides evidence. " +
    "Requires the evidence-preserving reducer mechanism and a configured reducer model; it spends model quota and may send the log to that model.",
  schema: {
    type: "object",
    properties: {
      text: { type: "string", description: "The log text to reduce." },
      path: { type: "string", description: "Project-relative file holding the log." },
      observation_id: { type: "string", description: "An obs_pack handle holding the log." },
      command: { type: "string", description: "The command that produced the log." },
      is_error: { type: "boolean", description: "True when the command failed." },
      reducer_model: {
        type: "string",
        description: "providerId/modelId override for this call; defaults to the plugin setting.",
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
};

const PLAN_UPDATE = {
  name: "plan_update",
  risk: "low",
  planSafeActions: [],
  description:
    "Replace the complete working plan. A newly completed step is recorded as a progress boundary — a point where context compaction is evaluated against its real economics. " +
    "Send every step on every call; reuse an id only for the same goal. " +
    "Returns the recorded plan snapshot and any structural advice, and reports whether compaction is currently worth it.",
  schema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 128,
        description: "The complete plan.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Stable step id." },
            goal: { type: "string", description: "What the step achieves." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["id", "goal", "status"],
          additionalProperties: false,
        },
      },
      progress: {
        type: "object",
        description: "Evidence for the step that just completed.",
        properties: {
          files_changed: { type: "array", items: { type: "string" } },
          verification: { type: "array", items: { type: "string" } },
          decisions: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    required: ["steps"],
    additionalProperties: false,
  },
};

const COMPACT_CHECK = {
  name: "compact_check",
  risk: "medium",
  planSafeActions: [],
  description:
    "Measure whether compacting this conversation would pay for itself right now, and write the carry-forward brief that survives the compaction. " +
    "Reports the measured context size, the remaining horizon, the break-even request count, the verdict and its reason. " +
    "It cannot compact on its own: PI-Desktop keeps native compaction under the user's command, so the answer names the checkpoint to run (the /compact command) and the brief path to continue from. " +
    "Call it after finishing a plan step, or when the conversation is long and you are about to continue with a lot of work left.",
  schema: {
    type: "object",
    properties: {
      keep_recent_tokens: {
        type: "number",
        description: "Tokens kept verbatim at the tail of the conversation (default 20000).",
      },
      remaining_boundaries: {
        type: "number",
        description: "Remaining plan steps; defaults to the plan recorded through plan_update.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

const TOOL_DESCRIPTORS = Object.freeze([
  FUSED_EDIT,
  OBS_PACK,
  OBS_RECALL,
  REDUCE_EVIDENCE,
  PLAN_UPDATE,
  COMPACT_CHECK,
]);

const TOOL_NAMES = Object.freeze(TOOL_DESCRIPTORS.map((tool) => tool.name));

module.exports = { TOOL_DESCRIPTORS, TOOL_NAMES };