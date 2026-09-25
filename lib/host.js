"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * The only place this plugin touches the host.
 *
 * Every call here is a documented PI-Desktop plugin API (host 0.15.x). Keeping
 * them in one module means the offline gate can substitute a single object and
 * still exercise the real decision paths, and it means an invented API name
 * fails loudly at load instead of at the first tool call.
 */

const { readConfig } = require("./config.js");
const paths = require("./paths.js");

let cachedDataPath = null;

/** Clear the cached data directory (used by tests and by plugin reload). */
function resetCache() {
  cachedDataPath = null;
}

/**
 * The plugin's own data directory, minted by the host. Nothing is written
 * outside it, and the host's fs API cannot reach it either.
 */
async function dataPath(host) {
  if (cachedDataPath) return cachedDataPath;
  const resolved = await host.plugin.getDataPath();
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw Object.assign(new Error("PI-Desktop did not provide a plugin data directory."), {
      code: "NO_DATA_DIR",
    });
  }
  cachedDataPath = resolved;
  return resolved;
}

async function workspace(host) {
  const info = await host.workspace.get();
  if (!info || typeof info !== "object") {
    throw Object.assign(new Error("No project is open, so there is no project root to work in."), {
      code: "NO_WORKSPACE",
    });
  }
  const root = typeof info.path === "string" && info.path ? info.path : null;
  if (!root) {
    throw Object.assign(new Error("The open project has no resolved folder path."), {
      code: "NO_WORKSPACE",
    });
  }
  return {
    path: root,
    name: typeof info.name === "string" && info.name ? info.name : root.split(/[\\/]/).filter(Boolean).at(-1) || root,
    projectId: typeof info.projectId === "string" ? info.projectId : null,
    roots: Array.isArray(info.roots) ? info.roots : [],
  };
}

/** Session-scoped archive root for one tool call. */
async function sessionRoot(host, ctx) {
  return paths.sessionRoot(await dataPath(host), ctx?.sessionId);
}

async function config(host) {
  const resolved = await readConfig(host);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error), { code: "SETTINGS_INVALID" });
  }
  return resolved.config;
}

async function settings(host) {
  const stored = await host.plugin.getSettings();
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

async function updateSettings(host, patch) {
  await host.plugin.setSettings(patch);
  return await settings(host);
}

/** The live model context, only readable while one of our tools is running. */
async function sessionContext(host) {
  return await host.session.getLlmContext();
}

/** Models the user is signed in for, used only for the context-window figure. */
async function models(host) {
  try {
    const listed = await host.models.list();
    return Array.isArray(listed) ? listed : [];
  } catch {
    return [];
  }
}

module.exports = {
  resetCache,
  dataPath,
  workspace,
  sessionRoot,
  config,
  settings,
  updateSettings,
  sessionContext,
  models,
  paths,
};
