"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * Append-only JSONL record of what a mechanism decided, mirroring upstream's
 * ledger and journal. Entries never enter the model context; they exist so a
 * user can see which results were packed, which were delegated, and why each
 * fallback happened.
 */

const { appendFile, mkdir } = require("node:fs/promises");
const { dirname } = require("node:path");

/** A ledger bound to one file. Calling it appends one timestamped line. */
function createLedger(path) {
  return async (entry) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(
      path,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  };
}

/**
 * A ledger that cannot break the mechanism it records: a failure to write is
 * reported through `onError` and then ignored, because losing a log line must
 * never cost the agent its observation.
 */
function createSafeLedger(path, onError) {
  const ledger = createLedger(path);
  return async (entry) => {
    try {
      await ledger(entry);
    } catch (error) {
      if (onError) onError(error);
    }
  };
}

module.exports = { createLedger, createSafeLedger };