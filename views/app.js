/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * The SoL-Pi panel. Every value comes from the plugin over `pluginBridge.invoke`
 * and is rendered with DOM APIs: archive text is arbitrary command output, so it
 * is never treated as markup.
 */

const bridge = window.pluginBridge;

const els = {
  subtitle: document.getElementById("subtitle"),
  version: document.getElementById("version"),
  banner: document.getElementById("banner"),
  mechanisms: document.getElementById("mechanisms"),
  bucket: document.getElementById("bucket"),
  totals: document.getElementById("totals"),
  observations: document.getElementById("observations"),
  receipts: document.getElementById("receipts"),
  plan: document.getElementById("plan"),
  planMeta: document.getElementById("plan-meta"),
  brief: document.getElementById("brief"),
  readerCard: document.getElementById("reader-card"),
  readerTitle: document.getElementById("reader-title"),
  readerMeta: document.getElementById("reader-meta"),
  readerBody: document.getElementById("reader-body"),
};

const MECHANISMS = [
  {
    key: "actionFusion",
    title: "Action Fusion",
    hint: "fused_edit writes one file and runs the validating command in the same call.",
  },
  {
    key: "observationPack",
    title: "ObservationPack",
    hint: "Large results are archived and read back by page instead of replayed.",
  },
  {
    key: "evidencePreservingReducer",
    title: "Evidence-Preserving Reducer",
    hint: "Long diagnostic logs are condensed by a model call, with quotes verified. Spends quota.",
  },
  {
    key: "onlineContextCompact",
    title: "Online Context Compact",
    hint: "Plan steps, compaction boundaries, and the arithmetic that says whether compacting pays.",
  },
];

let view = { payload: null, bucket: null, reader: null };

function fail(message) {
  els.banner.hidden = false;
  els.banner.textContent = message;
}

function clearFail() {
  els.banner.hidden = true;
  els.banner.textContent = "";
}

async function invoke(channel, payload) {
  if (!bridge || typeof bridge.invoke !== "function") {
    throw new Error("pluginBridge is unavailable — this page is not running inside PI-Desktop.");
  }
  return await bridge.invoke(channel, payload ?? {});
}

async function refresh(bucket) {
  try {
    const payload = await invoke("sol.state", bucket ? { bucket } : {});
    clearFail();
    render(payload);
    return payload;
  } catch (error) {
    fail(String(error?.message ?? error));
    return null;
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Which route packed something, in the panel's own words.
 *
 * The two routes are not interchangeable: `agent-extension` is the hook module
 * inside the agent process, which sees a tool result in full, while `tool` is a
 * call the agent made on purpose.
 */
function routeLabel(route) {
  if (route === "agent-extension") return "hook route";
  if (route === "tool") return "tool call";
  return route ? String(route) : "—";
}

/**
 * What the hook route says about itself, or why there is nothing to say.
 *
 * "loaded" is deliberately weaker than "live": the module announces itself as
 * soon as the agent process loads it, which is not the same as having served a
 * request in the session the panel is showing.
 */
function hookRouteLabel(hook) {
  if (!hook) return "unknown";
  if (hook.error) return "status unreadable";
  if (hook.live) return "live";
  if (hook.announced) return "loaded, no request here yet";
  return "not loaded";
}

function formatWhen(value) {
  if (typeof value !== "string" || !value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function cell(text, className) {
  const td = document.createElement("td");
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function buttonCell(label, onClick) {
  const td = document.createElement("td");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ghost small";
  button.textContent = label;
  button.addEventListener("click", onClick);
  td.appendChild(button);
  return td;
}

function render(payload) {
  view.payload = payload;
  els.version.textContent = `v${payload.version ?? "?"}`;

  const workspace = payload.workspace ? payload.workspace.name : null;
  els.subtitle.textContent = [
    payload.enabled?.length ? `on: ${payload.enabled.join(", ")}` : "every mechanism is off",
    workspace ? `project: ${workspace}` : "no project open",
  ].join(" · ");

  if (payload.config_error) fail(payload.config_error);

  renderMechanisms(payload);
  renderBuckets(payload);
  renderTotals(payload);
  renderObservations(payload);
  renderReceipts(payload);
  renderPlan(payload);
  els.brief.textContent =
    typeof payload.brief === "string" && payload.brief.trim()
      ? payload.brief
      : "No brief yet. Ask the agent to run compact_check once the mechanism is on.";
}

function renderMechanisms(payload) {
  els.mechanisms.replaceChildren();
  for (const mechanism of MECHANISMS) {
    const item = document.createElement("li");
    item.className = "mechanism";

    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = payload.config?.[mechanism.key] === true;
    input.addEventListener("change", async () => {
      input.disabled = true;
      try {
        await invoke("sol.setSettings", {
          patch: { [mechanism.key]: input.checked },
          bucket: view.bucket,
        });
        await refresh(view.bucket);
      } catch (error) {
        fail(String(error?.message ?? error));
        input.checked = !input.checked;
      } finally {
        input.disabled = false;
      }
    });

    const box = document.createElement("div");
    const title = document.createElement("span");
    title.className = "mechanism-title";
    title.textContent = mechanism.title;
    const hint = document.createElement("span");
    hint.className = "mechanism-hint";
    hint.textContent = mechanism.hint;
    const code = document.createElement("code");
    code.textContent = mechanism.key;
    box.append(title, hint, code);

    label.append(input, box);
    item.appendChild(label);
    els.mechanisms.appendChild(item);
  }
}

function renderBuckets(payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  els.bucket.replaceChildren();
  if (!sessions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "nothing archived yet";
    els.bucket.appendChild(option);
    els.bucket.disabled = true;
    return;
  }
  els.bucket.disabled = false;
  for (const session of sessions) {
    const option = document.createElement("option");
    option.value = session.bucket;
    option.textContent =
      session.error
        ? `${session.bucket} (unreadable)`
        : `${session.bucket} — ${session.observations ?? 0} packed, ${formatWhen(session.updated_at)}`;
    option.selected = session.bucket === payload.bucket;
    els.bucket.appendChild(option);
  }
}

function renderTotals(payload) {
  view.bucket = payload.bucket ?? null;
  const totals = payload.totals ?? {};
  const hook = payload.hook_route ?? null;
  const entries = [
    // Which route is live comes first: it is the answer to "why is nothing here
    // yet?" - either the module has not run, or it simply has not packed.
    ["Hook route", hookRouteLabel(hook)],
    ["Turns measured", hook?.measured_turns ?? 0],
    ["Packed observations", totals.observations ?? 0],
    ["Read back", totals.recalled ?? 0],
    ["Archived bytes", formatBytes(totals.archived_bytes ?? 0)],
    ["Tokens kept out", totals.tokens_kept_out ?? 0],
    ["Reductions applied", totals.reducer_applied ?? 0],
    ["Reducer fallbacks", totals.reducer_fallbacks ?? 0],
  ];
  els.totals.replaceChildren();
  for (const [label, value] of entries) {
    const box = document.createElement("div");
    box.className = "total";
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = label;
    box.append(strong, span);
    els.totals.appendChild(box);
  }
}

function renderObservations(payload) {
  els.observations.replaceChildren();
  const rows = Array.isArray(payload.observations) ? payload.observations : [];
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = cell("Nothing packed in this session yet.", "empty");
    td.colSpan = 7;
    tr.appendChild(td);
    els.observations.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(
      cell(row.id ?? "—", "mono"),
      cell(row.tool ?? "—"),
      cell(routeLabel(row.route)),
      cell(formatBytes(row.original_bytes), "num"),
      cell(String(row.removed_tokens ?? "—"), "num"),
      cell(formatWhen(row.packed_at)),
      buttonCell("Read", () => openReader("observation", row.id, 0, "Archived observation")),
    );
    els.observations.appendChild(tr);
  }
}

function renderReceipts(payload) {
  els.receipts.replaceChildren();
  const rows = Array.isArray(payload.receipts) ? payload.receipts : [];
  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = cell("No reduction has been attempted in this session.", "empty");
    td.colSpan = 6;
    tr.appendChild(td);
    els.receipts.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement("tr");
    const bytes =
      row.receipt_bytes != null
        ? `${formatBytes(row.source_bytes)} → ${formatBytes(row.receipt_bytes)}`
        : formatBytes(row.source_bytes);
    const digest = typeof row.digest === "string" ? row.digest : "";
    tr.append(
      cell(row.kind ?? "—"),
      cell(row.reason ?? (row.evidence_count != null ? `${row.evidence_count} evidence items` : "—")),
      cell(bytes, "num"),
      cell(digest ? `${digest.slice(0, 12)}…` : "—", "mono"),
      cell(formatWhen(row.at)),
      digest
        ? buttonCell("Read log", () => openReader("reducer", digest, 0, "Archived source log"))
        : cell("—"),
    );
    els.receipts.appendChild(tr);
  }
}

function renderPlan(payload) {
  const plan = payload.plan;
  els.plan.replaceChildren();
  els.planMeta.textContent = plan
    ? `${plan.request_count ?? 0} requests · ${plan.native_compactions ?? 0} compactions`
    : "no plan recorded yet";

  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  if (!steps.length) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No plan recorded. Ask the agent to run plan_update once the mechanism is on.";
    els.plan.appendChild(item);
    return;
  }
  for (const step of steps) {
    const item = document.createElement("li");
    const status = document.createElement("span");
    status.className = `status status-${String(step.status ?? "pending")}`;
    status.textContent = String(step.status ?? "pending");
    const text = document.createElement("span");
    const id = document.createElement("code");
    id.textContent = String(step.id ?? "");
    text.append(id, document.createTextNode(String(step.goal ?? "")));
    item.append(status, text);
    els.plan.appendChild(item);
  }
}

async function openReader(kind, id, offset, title) {
  try {
    const page = await invoke("sol.readArchived", { bucket: view.bucket, kind, id, offset });
    view.reader = { kind, id, offset, page };
    els.readerCard.hidden = false;
    els.readerTitle.textContent = title;
    els.readerMeta.textContent =
      `${page.kind} ${page.id} · offset ${page.offset} → ${page.next_offset} · ` +
      `${page.bytes} bytes, ${page.lines} lines${page.eof ? " · end of archive" : ""}`;
    els.readerBody.textContent = page.text || "(empty page)";
    clearFail();
  } catch (error) {
    fail(String(error?.message ?? error));
  }
}

document.getElementById("refresh").addEventListener("click", () => refresh(view.bucket));

document.getElementById("preset-local").addEventListener("click", async () => {
  await invoke("sol.applyPreset", { preset: "local", bucket: view.bucket })
    .then(() => refresh(view.bucket))
    .catch((error) => fail(String(error?.message ?? error)));
});

document.getElementById("preset-off").addEventListener("click", async () => {
  await invoke("sol.applyPreset", { preset: "off", bucket: view.bucket })
    .then(() => refresh(view.bucket))
    .catch((error) => fail(String(error?.message ?? error)));
});

els.bucket.addEventListener("change", () => refresh(els.bucket.value));

document.getElementById("reader-prev").addEventListener("click", () => {
  const reader = view.reader;
  if (!reader) return;
  const back = Math.max(0, (reader.page?.offset ?? 0) - (reader.page?.bytes || 16384));
  openReader(reader.kind, reader.id, back, els.readerTitle.textContent);
});

document.getElementById("reader-next").addEventListener("click", () => {
  const reader = view.reader;
  if (!reader) return;
  openReader(reader.kind, reader.id, reader.page?.next_offset ?? 0, els.readerTitle.textContent);
});

document.getElementById("reader-close").addEventListener("click", () => {
  view.reader = null;
  els.readerCard.hidden = true;
  els.readerBody.textContent = "";
});

document.getElementById("brief-copy").addEventListener("click", async () => {
  const text = els.brief.textContent ?? "";
  if (!text.trim()) return;
  try {
    await invoke("clipboard.writeText", { text });
    clearFail();
  } catch (error) {
    fail(
      `Could not write to the clipboard (${String(error?.message ?? error)}). ` +
        "Select the brief text and copy it by hand.",
    );
  }
});

refresh();
