#!/usr/bin/env node
/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * Regenerate manifest.json from lib/metadata.js.
 *
 * `manifest.json` is generated, never hand-edited: the plugin's own load path
 * re-checks the file against the metadata module and refuses to load when they
 * disagree, so this script is the only supported way to change the manifest.
 *
 * Usage:
 *   node scripts/sync-manifest.mjs          # write manifest.json
 *   node scripts/sync-manifest.mjs --check  # fail if it is out of date
 */

import { createRequire } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "manifest.json");

const metadata = require(join(root, "lib", "metadata.js"));
const manifest = metadata.buildManifest();
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

const check = process.argv.includes("--check");

if (check) {
  let current = null;
  try {
    current = await readFile(manifestPath, "utf8");
  } catch {
    console.error("manifest.json is missing; run: node scripts/sync-manifest.mjs");
    process.exit(1);
  }
  if (current !== serialized) {
    console.error("manifest.json is out of date with lib/metadata.js; run: node scripts/sync-manifest.mjs");
    process.exit(1);
  }
  console.log("manifest.json matches lib/metadata.js");
  process.exit(0);
}

await writeFile(manifestPath, serialized, "utf8");
console.log(`wrote ${manifestPath}`);
