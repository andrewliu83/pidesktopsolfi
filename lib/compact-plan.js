"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 * Ported from NVlabs/SoL-Pi `src/sol-pi/extensions/online-context-compact/plan.ts` (MIT).
 *
 * The working plan, and what counts as a progress boundary. A step that turns
 * `completed` is a point where the conversation can be compacted, because the
 * work it describes is finished and only its evidence still needs to survive.
 */

const PLAN_STATUSES = ["pending", "in_progress", "completed"];

const MAX_PLAN_STEPS = 128;
const MAX_PLAN_STRING_BYTES = 16384;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value) {
  return (
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= MAX_PLAN_STRING_BYTES
  );
}

function isPlanStatus(value) {
  return PLAN_STATUSES.some((status) => status === value);
}

/**
 * Accept a plan only in the exact shape the tool documents: every step carries
 * exactly id/goal/status, ids are unique, and nothing is unbounded. A plan that
 * fails here is rejected outright rather than half-recorded.
 */
function parsePlanSteps(value) {
  if (!Array.isArray(value) || value.length > MAX_PLAN_STEPS) return undefined;
  const steps = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      Object.keys(item).length !== 3 ||
      !isBoundedString(item.id) ||
      !isBoundedString(item.goal) ||
      !isPlanStatus(item.status)
    ) {
      return undefined;
    }
    steps.push({ id: item.id, goal: item.goal, status: item.status });
  }
  if (new Set(steps.map((step) => step.id)).size !== steps.length) return undefined;
  return steps;
}

/**
 * What changed between two plans: which steps just completed (the boundaries),
 * and structural advice that keeps the plan usable as a compaction signal.
 */
function analyzePlanTransition(previous, next) {
  const previousById = new Map(previous.map((step) => [step.id, step]));
  const completedSteps = [];
  const advice = [];

  for (const step of next) {
    const prior = previousById.get(step.id);
    if ((!prior || prior.status !== "completed") && step.status === "completed") {
      completedSteps.push(step);
    }
    if (prior && prior.goal !== step.goal) {
      advice.push(`Plan step ${JSON.stringify(step.id)} changed goal; reuse an id only for the same goal.`);
    }
  }

  const inProgress = next.filter((step) => step.status === "in_progress").length;
  if (inProgress > 1) advice.push("Keep at most one plan step in_progress.");
  if (inProgress === 0 && next.some((step) => step.status === "pending")) {
    advice.push("Mark one pending plan step in_progress before starting it.");
  }

  return { completedSteps, advice };
}

/** The snapshot the agent gets back, in the same shape upstream prints. */
function formatPlanSnapshot(steps) {
  return `<sol-pi-plan task_status="active">${JSON.stringify({ steps })}</sol-pi-plan>`;
}

module.exports = {
  PLAN_STATUSES,
  MAX_PLAN_STEPS,
  MAX_PLAN_STRING_BYTES,
  isRecord,
  isBoundedString,
  isPlanStatus,
  parsePlanSteps,
  analyzePlanTransition,
  formatPlanSnapshot,
};
