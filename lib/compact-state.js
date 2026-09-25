"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 * Ported from NVlabs/SoL-Pi `src/sol-pi/extensions/online-context-compact/state.ts` (MIT).
 *
 * The state that makes the compaction decision possible: how many requests each
 * finished boundary took, how fast the context is growing, how many compactions
 * already happened, and what cache debt is still being repaid.
 *
 * Upstream persists this as a custom session entry next to the conversation. A
 * PI-Desktop plugin cannot append to the session transcript, so the same record
 * is kept as validated JSON in the plugin's own per-session directory. The shape,
 * the validation and every transition stay identical, which is what the tests
 * pin down.
 */

const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { dirname } = require("node:path");

const { parsePlanSteps } = require("./compact-plan.js");

const ONLINE_STATE_ENTRY = "sol-pi-online-context-state-v1";

function initialOnlineState() {
  return {
    version: 1,
    epoch: 0,
    plan: [],
    pendingProgress: [],
    requestCount: 0,
    lastBoundaryRequestCount: 0,
    completedBoundaryRequestCounts: [],
    lastContextTokens: null,
    positiveContextDeltaTotal: 0,
    positiveContextDeltaCount: 0,
    nativeCompactionCount: 0,
    cacheDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
  };
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function stringArray(value) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return [...value];
}

function progressSummary(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value;
  const filesChanged = stringArray(record.filesChanged);
  const verification = stringArray(record.verification);
  const decisions = stringArray(record.decisions);
  const nextWork = stringArray(record.nextWork);
  if (
    typeof record.stepId !== "string" ||
    typeof record.goal !== "string" ||
    !filesChanged ||
    !verification ||
    !decisions ||
    !nextWork
  ) {
    return undefined;
  }
  return { stepId: record.stepId, goal: record.goal, filesChanged, verification, decisions, nextWork };
}

/** Accept a stored state only if every field is in range; otherwise start over. */
function parseOnlineState(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value;
  const plan = parsePlanSteps(record.plan);
  const pendingProgress = Array.isArray(record.pendingProgress)
    ? record.pendingProgress.map(progressSummary)
    : undefined;
  const completedBoundaryRequestCounts = Array.isArray(record.completedBoundaryRequestCounts)
    ? record.completedBoundaryRequestCounts
    : undefined;
  if (
    record.version !== 1 ||
    !plan ||
    !pendingProgress ||
    pendingProgress.some((item) => item === undefined) ||
    !completedBoundaryRequestCounts ||
    !completedBoundaryRequestCounts.every(nonNegativeInteger) ||
    !nonNegativeInteger(record.epoch) ||
    !nonNegativeInteger(record.requestCount) ||
    !nonNegativeInteger(record.lastBoundaryRequestCount) ||
    record.lastBoundaryRequestCount > record.requestCount ||
    !(record.lastContextTokens === null || nonNegativeInteger(record.lastContextTokens)) ||
    !finiteNonNegative(record.positiveContextDeltaTotal) ||
    !nonNegativeInteger(record.positiveContextDeltaCount) ||
    !nonNegativeInteger(record.nativeCompactionCount) ||
    !finiteNonNegative(record.cacheDebtTokens) ||
    !finiteNonNegative(record.cacheDebtRepaymentTokens)
  ) {
    return undefined;
  }
  return {
    version: 1,
    epoch: record.epoch,
    plan,
    pendingProgress,
    requestCount: record.requestCount,
    lastBoundaryRequestCount: record.lastBoundaryRequestCount,
    completedBoundaryRequestCounts,
    lastContextTokens: record.lastContextTokens,
    positiveContextDeltaTotal: record.positiveContextDeltaTotal,
    positiveContextDeltaCount: record.positiveContextDeltaCount,
    nativeCompactionCount: record.nativeCompactionCount,
    cacheDebtTokens: record.cacheDebtTokens,
    cacheDebtRepaymentTokens: record.cacheDebtRepaymentTokens,
  };
}

/** Load the state for this session; a missing or corrupt file starts from scratch. */
async function loadOnlineState(path) {
  try {
    const raw = await readFile(path, "utf8");
    return parseOnlineState(JSON.parse(raw)) ?? initialOnlineState();
  } catch {
    return initialOnlineState();
  }
}

async function saveOnlineState(path, state) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

/** One more observed request, with the context size it carried. */
function recordProviderRequest(state, contextTokens) {
  const delta = state.lastContextTokens === null ? 0 : contextTokens - state.lastContextTokens;
  const cacheDebtTokens = Math.max(0, state.cacheDebtTokens - state.cacheDebtRepaymentTokens);
  return {
    ...state,
    requestCount: state.requestCount + 1,
    lastContextTokens: contextTokens,
    positiveContextDeltaTotal: state.positiveContextDeltaTotal + Math.max(0, delta),
    positiveContextDeltaCount: state.positiveContextDeltaCount + (delta > 0 ? 1 : 0),
    cacheDebtTokens,
    cacheDebtRepaymentTokens: cacheDebtTokens === 0 ? 0 : state.cacheDebtRepaymentTokens,
  };
}

/** A completed step was observed: close the boundary and store its progress. */
function recordBoundary(state, plan, progress) {
  const interval = Math.max(0, state.requestCount - state.lastBoundaryRequestCount);
  return {
    ...state,
    plan: [...plan],
    pendingProgress: progress ? [...state.pendingProgress, progress] : state.pendingProgress,
    lastBoundaryRequestCount: state.requestCount,
    completedBoundaryRequestCounts: [...state.completedBoundaryRequestCounts, interval],
  };
}

function recordCompaction(state, debt) {
  return {
    ...state,
    epoch: state.epoch + 1,
    plan: [],
    pendingProgress: [],
    lastContextTokens: null,
    positiveContextDeltaTotal: 0,
    positiveContextDeltaCount: 0,
    nativeCompactionCount: state.nativeCompactionCount + 1,
    cacheDebtTokens: Math.max(0, debt.debtTokens),
    cacheDebtRepaymentTokens: Math.max(0, debt.repaymentTokens),
  };
}

/** A steering correction or a user rewrite invalidates the boundary history. */
function recordCorrection(state) {
  return {
    ...state,
    epoch: state.epoch + 1,
    plan: [],
    pendingProgress: [],
    lastBoundaryRequestCount: state.requestCount,
    completedBoundaryRequestCounts: [],
    lastContextTokens: null,
    positiveContextDeltaTotal: 0,
    positiveContextDeltaCount: 0,
    cacheDebtTokens: 0,
    cacheDebtRepaymentTokens: 0,
  };
}

module.exports = {
  ONLINE_STATE_ENTRY,
  initialOnlineState,
  parseOnlineState,
  loadOnlineState,
  saveOnlineState,
  recordProviderRequest,
  recordBoundary,
  recordCompaction,
  recordCorrection,
};
