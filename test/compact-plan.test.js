"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const plan = require("../lib/compact-plan.js");

const steps = [
  { id: "a", goal: "port the mechanisms", status: "completed" },
  { id: "b", goal: "write the gate", status: "in_progress" },
];

test("the plan limits are the upstream ones", () => {
  assert.deepEqual(plan.PLAN_STATUSES, ["pending", "in_progress", "completed"]);
  assert.equal(plan.MAX_PLAN_STEPS, 128);
  assert.equal(plan.MAX_PLAN_STRING_BYTES, 16384);
});

test("a plan is accepted only in the documented shape", () => {
  assert.deepEqual(plan.parsePlanSteps(steps), steps);
  assert.deepEqual(plan.parsePlanSteps([]), []);

  const rejected = [
    undefined,
    "steps",
    { 0: steps[0] },
    [{ id: "a", goal: "g", status: "done" }],
    [{ id: "a", goal: "g" }],
    [{ id: "a", goal: "g", status: "pending", extra: true }],
    [{ id: "", goal: "g", status: "pending" }],
    [{ id: "a", goal: "", status: "pending" }],
    [{ id: "a", goal: 7, status: "pending" }],
    [{ id: "a", goal: "g", status: "pending" }, { id: "a", goal: "h", status: "pending" }],
    [{ id: "a", goal: "g".repeat(16385), status: "pending" }],
    Array.from({ length: 129 }, (_, index) => ({ id: `s${index}`, goal: "g", status: "pending" })),
  ];
  for (const value of rejected) {
    assert.equal(plan.parsePlanSteps(value), undefined, `${JSON.stringify(value)} must be refused`);
  }
});

test("a step that turns completed is the boundary", () => {
  const transition = plan.analyzePlanTransition(
    [{ id: "a", goal: "port the mechanisms", status: "in_progress" }, steps[1]],
    steps,
  );
  assert.equal(transition.completedSteps.length, 1);
  assert.equal(transition.completedSteps[0].id, "a");
  assert.deepEqual(transition.advice, []);

  const repeat = plan.analyzePlanTransition(steps, steps);
  assert.deepEqual(repeat.completedSteps, [], "an already completed step is not a new boundary");
});

test("the transition advice keeps the plan usable as a compaction signal", () => {
  const renamed = plan.analyzePlanTransition(
    [{ id: "a", goal: "old goal", status: "completed" }],
    [{ id: "a", goal: "new goal", status: "completed" }],
  );
  assert.ok(renamed.advice.some((line) => line.includes("changed goal")));

  const twoRunning = plan.analyzePlanTransition(
    [],
    [
      { id: "a", goal: "g", status: "in_progress" },
      { id: "b", goal: "h", status: "in_progress" },
    ],
  );
  assert.ok(twoRunning.advice.some((line) => line.includes("at most one")));

  const nothingRunning = plan.analyzePlanTransition([], [
    { id: "a", goal: "g", status: "pending" },
  ]);
  assert.ok(nothingRunning.advice.some((line) => line.includes("Mark one pending")));
});

test("the snapshot carries the marker upstream prints", () => {
  const snapshot = plan.formatPlanSnapshot(steps);
  assert.match(snapshot, /^<sol-pi-plan task_status="active">/);
  assert.match(snapshot, /<\/sol-pi-plan>$/);
  const payload = JSON.parse(snapshot.replace(/^<sol-pi-plan task_status="active">/, "").replace(/<\/sol-pi-plan>$/, ""));
  assert.deepEqual(payload, { steps });
});
