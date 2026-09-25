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

/**
 * The project root a path-based tool may work in.
 *
 * Two sources, because they answer two different questions. `workspace.get()` is
 * the folder the *window* has open, and it is the right answer when a project is
 * open there. A conversation can also run in a folder that is not the window's
 * project - PI-Desktop keeps one project per session (ADR 0016/D093) - and then
 * that call returns null while the session still knows where it belongs. The host
 * reads `session.get(...).session.projectPath` itself to scope its own file
 * access per session, so this does the same, and refuses by name only when neither
 * source has an answer.
 *
 * Both documented shapes are accepted: the bare `{ path, name, roots? }` that the
 * plugin API returns today, and a `{ workspace: { path, ... } }` envelope, so a
 * host that wraps the answer cannot silently turn every path into a refusal.
 */
async function workspace(host, ctx) {
  const info = await host.workspace.get();
  const unwrapped = unwrapWorkspace(info);
  if (unwrapped) return unwrapped;

  const sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId.trim() : "";
  const sessionNote = await sessionProjectNote(host, sessionId);
  if (sessionNote.path) {
    return {
      path: sessionNote.path,
      name: sessionNote.path.split(/[\\/]/).filter(Boolean).at(-1) || sessionNote.path,
      projectId: null,
      roots: [sessionNote.path],
      source: "session",
    };
  }

  const openProject = info && typeof info === "object" ? "The open project has no resolved folder path." : "No project is open, so there is no project root to work in.";
  const detail = sessionNote.error
    ? ` Session lookup failed too: ${sessionNote.error}`
    : sessionId
      ? " This session does not record a project folder either."
      : " No session was available to ask.";
  throw Object.assign(new Error(`${openProject}${detail}`), { code: "NO_WORKSPACE" });
}

/** Accept both the bare and the wrapped workspace payload. */
function unwrapWorkspace(info) {
  const candidate = info && typeof info === "object" && info.workspace && typeof info.workspace === "object" ? info.workspace : info;
  if (!candidate || typeof candidate !== "object") return null;
  const root = typeof candidate.path === "string" && candidate.path.trim() ? candidate.path : null;
  if (!root) return null;
  return {
    path: root,
    name: typeof candidate.name === "string" && candidate.name ? candidate.name : root.split(/[\\/]/).filter(Boolean).at(-1) || root,
    projectId: typeof candidate.projectId === "string" ? candidate.projectId : null,
    roots: Array.isArray(candidate.roots) ? candidate.roots : [],
    source: "workspace",
  };
}

/**
 * The project folder this session belongs to, if the host records one. A lookup
 * that fails is reported as a note rather than swallowed, so the refusal that
 * follows says why both sources came up empty.
 */
async function sessionProjectNote(host, sessionId) {
  if (!sessionId) return { path: null, error: null };
  if (!host.session || typeof host.session.get !== "function") return { path: null, error: null };
  try {
    const record = await host.session.get({ id: sessionId });
    const candidate = record?.session?.projectPath ?? record?.projectPath;
    return { path: typeof candidate === "string" && candidate.trim() ? candidate.trim() : null, error: null };
  } catch (error) {
    return { path: null, error: error?.message ?? String(error) };
  }
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
