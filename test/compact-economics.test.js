"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const economics = require("../lib/compact-economics.js");

const E = economics.DEFAULT_COMPACTION_ECONOMICS;

const base = (overrides = {}) => ({
  completedBoundaryRequestCounts: [4, 6],
  remainingBoundaries: 2,
  contextTokens: 20000,
  contextWindowTokens: 200000,
  averageContextTokenIncrement: 4000,
  writeTokens: 3000,
  archiveTokens: 6000,
  memoTokens: 1000,
  cacheWriteReadRatio: 12.5,
  priorCompactionCount: 0,
  carriedDebtTokens: 0,
  cacheDebtRepaymentTokens: 0,
  economics: E,
  ...overrides,
});

test("the upstream economics constants are the ones that ship", () => {
  assert.deepEqual(E, {
    remainingRequestScale: 1,
    remainingRequestStddevK: 0,
    windowReserveTokens: 16384,
    firstCompactionRequestScale: 2,
    subsequentCompactionMargin: 1.5,
  });
  assert.equal(economics.MINIMUM_VARIANCE_SAMPLES, 3);
  assert.equal(economics.SMALL_SAMPLE_SCALE, 0.5);
});

test("the horizon is the mean per boundary, scaled, and capped by the window", () => {
  const plain = economics.estimateRemainingRequests({
    completedBoundaryRequestCounts: [4, 6],
    remainingBoundaries: 2,
    scale: 1,
    standardDeviationK: 0,
    contextTokens: 20000,
    contextWindowTokens: null,
    averageContextTokenIncrement: null,
  });
  assert.equal(plain.requestsPerBoundaryMean, 5);
  assert.equal(plain.requestsPerBoundaryLowerBound, 5);
  assert.equal(plain.unboundedExpectedRemainingRequests, 11);
  assert.equal(plain.windowRequestUpperBound, null);
  assert.equal(plain.expectedRemainingRequests, 11);

  const scaled = economics.estimateRemainingRequests({
    completedBoundaryRequestCounts: [4, 6],
    remainingBoundaries: 2,
    scale: 2,
    standardDeviationK: 0,
    contextTokens: 20000,
    contextWindowTokens: null,
    averageContextTokenIncrement: null,
  });
  assert.equal(scaled.unboundedExpectedRemainingRequests, 21);

  const capped = economics.estimateRemainingRequests({
    completedBoundaryRequestCounts: [4, 6],
    remainingBoundaries: 2,
    scale: 1,
    standardDeviationK: 0,
    contextTokens: 20000,
    contextWindowTokens: 30000,
    averageContextTokenIncrement: 3000,
  });
  assert.equal(capped.windowRequestUpperBound, 3);
  assert.equal(capped.expectedRemainingRequests, 3);

  const noIncrement = economics.estimateRemainingRequests({
    completedBoundaryRequestCounts: [4, 6],
    remainingBoundaries: 2,
    scale: 1,
    standardDeviationK: 0,
    contextTokens: 20000,
    contextWindowTokens: 30000,
    averageContextTokenIncrement: 0,
  });
  assert.equal(noIncrement.windowRequestUpperBound, null);
  assert.equal(noIncrement.expectedRemainingRequests, 11);
});

test("a risky lower bound needs samples; a small sample is halved", () => {
  const enough = economics.estimateRemainingRequests({
    completedBoundaryRequestCounts: [2, 4, 6],
    remainingBoundaries: 3,
    scale: 1,
    standardDeviationK: 1,
    contextTokens: 0,
    contextWindowTokens: null,
    averageContextTokenIncrement: null,
  });
  assert.equal(enough.requestsPerBoundaryMean, 4);
  // variance = ((2-4)^2 + 0 + (6-4)^2) / 2 = 4, so the lower bound is 4 - 2 = 2
  assert.equal(enough.requestsPerBoundaryLowerBound, 2);
  assert.equal(enough.unboundedExpectedRemainingRequests, 7);

  const tooFew = economics.estimateRemainingRequests({
    completedBoundaryRequestCounts: [2, 4],
    remainingBoundaries: 3,
    scale: 1,
    standardDeviationK: 1,
    contextTokens: 0,
    contextWindowTokens: null,
    averageContextTokenIncrement: null,
  });
  // two samples is below MINIMUM_VARIANCE_SAMPLES, so the mean is halved instead
  // mean 3, halved to 1.5, and 1 + floor(1.5 * 3 boundaries) = 5
  assert.equal(tooFew.requestsPerBoundaryLowerBound, 1.5);
  assert.equal(tooFew.unboundedExpectedRemainingRequests, 5);
});

test("a first compaction that pays for itself inside the horizon is economic", () => {
  const decision = economics.decideCompaction(base());
  assert.equal(decision.compact, true);
  assert.equal(decision.reason, "economic");
  assert.ok(Math.abs(decision.breakevenRequests - 6.9) < 1e-9);
  assert.equal(decision.effectiveHorizonRequests, 22);
  assert.equal(decision.incrementalCacheCostRatio, 11.5);
});

test("a first compaction that cannot pay for itself is deferred", () => {
  const decision = economics.decideCompaction(base({ writeTokens: 30000 }));
  assert.equal(decision.compact, false);
  assert.equal(decision.reason, "deferred_economic");
  assert.ok(decision.breakevenRequests > decision.effectiveHorizonRequests);
});

test("no saving means no compaction, however full the window is", () => {
  const decision = economics.decideCompaction(base({ archiveTokens: 1000, contextTokens: 190000 }));
  assert.equal(decision.compact, false);
  assert.equal(decision.reason, "non_positive_saving");
});

test("a nearly full window is protected regardless of the arithmetic", () => {
  const decision = economics.decideCompaction(
    base({ writeTokens: 300000, contextTokens: 200000 - E.windowReserveTokens }),
  );
  assert.equal(decision.compact, true);
  assert.equal(decision.reason, "window_protection");
});

test("an unknown horizon or cache ratio is named, not guessed", () => {
  const noHorizon = economics.decideCompaction(base({ completedBoundaryRequestCounts: null }));
  assert.equal(noHorizon.compact, false);
  assert.equal(noHorizon.reason, "horizon_unavailable");
  assert.equal(noHorizon.expectedRemainingRequests, null);

  const noRatio = economics.decideCompaction(base({ cacheWriteReadRatio: null }));
  assert.equal(noRatio.compact, false);
  assert.equal(noRatio.reason, "cache_ratio_unavailable");
  assert.equal(noRatio.breakevenRequests, null);
});

test("after the first compaction the margin and the carried debt both have to clear", () => {
  const margin = economics.decideCompaction(base({ priorCompactionCount: 1, writeTokens: 3200 }));
  assert.equal(margin.compact, false);
  assert.equal(margin.reason, "deferred_subsequent_margin");

  const debt = economics.decideCompaction(
    base({ priorCompactionCount: 1, carriedDebtTokens: 25000 }),
  );
  assert.equal(debt.compact, false);
  assert.equal(debt.reason, "deferred_carried_debt");
  assert.ok(debt.combinedBreakevenRequests > debt.expectedRemainingRequests);

  const clear = economics.decideCompaction(base({ priorCompactionCount: 1 }));
  assert.equal(clear.compact, true);
  assert.equal(clear.reason, "economic");
});
