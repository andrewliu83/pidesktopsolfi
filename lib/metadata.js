"use strict";

/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 PI-Desktop SoL-Pi port contributors
 * SPDX-License-Identifier: MIT
 *
 * Single metadata source for the plugin. `manifest.json` is generated from this
 * file by `scripts/sync-manifest.mjs`, and `main.js` re-checks the shipped
 * manifest against it at load time, so name/description/schema drift cannot
 * survive a rename.
 */

const { TOOL_DESCRIPTORS } = require("./tool-descriptors.js");

const ID = "local.sol-pi";
const NAME = "SoL-Pi";
const VERSION = "0.2.0";
const DESCRIPTION =
  "NVIDIA SoL-Pi's four agent-efficiency mechanisms ported to PI-Desktop: fused edit+run tool calls, observation packing with exact paged recall, evidence-verified log reduction, and economics-checked context compaction planning. Since 0.2.0 packing large results and measuring each turn are on by default - both only act on text the model has already been shown - while the reducer and the compaction planner stay off until you turn them on.";
const DESCRIPTION_ZH =
  "把 NVIDIA SoL-Pi 的四个效率机制移植到 PI-Desktop：编辑与验证命令合并成一次工具调用、大结果打包并按页精确回读、带引文校验的日志压缩回执、按经济学判定是否值得压缩上下文。自 0.2.0 起，大结果打包与每回合成本测量默认开启（只作用于模型已看过的文本，不新增内容、不消耗额度）；会花钱的日志压缩与上下文压缩规划默认关闭。";
const AUTHOR = "andrewliu83";
const HOMEPAGE = "https://github.com/andrewliu83/pidesktopsolfi";
const UPSTREAM = "https://github.com/NVlabs/SoL-Pi";

const SAFETY_NOTES =
  "Registers agent tools, prompt skills, and one agent-extension module, and declares exactly the host APIs it uses. " +
  "The fused-edit tool writes one project file and runs one shell command the agent itself supplied, inside the project root only: paths are resolved and confined to the workspace root (symlink escapes refused), and .env*, .ssh/, .aws/, *.pem and .git/ are refused. " +
  "Command output is bounded (200 KiB per stream) and the whole call is capped below the host's 110s tool limit. " +
  "The module declared under contributes.agentExtensions (hooks/agent-hooks.js) is loaded by PI-Desktop inside its agent process, which is the only place this plugin can see a provider request before it is sent: while packing is on it replaces an oversized text tool result in that request's projection only - never in the stored session - archiving the original bytes by observation id for exact paged recall with obs_recall, and while measurement is on it appends one cost line per turn without returning anything to the conversation. " +
  "That module registers no tool, writes only inside this plugin's own data directory, and returns the messages it was given unchanged if any step fails. " +
  "Observation and reducer archives are content-addressed, never deleted automatically, and never sent anywhere. " +
  "The evidence-preserving reducer is the only mechanism that can spend quota or send data outward: it calls the host's one-shot completion with the configured reducer model and the log as prompt input, and it is off until enabled. " +
  "session.read is used during tool execution only, to measure the live model context for packing candidates and compaction economics; nothing read there is transmitted except the log the reducer call is explicitly given. " +
  "The clipboard is written only when you press Copy in the panel, and the plugin reads it never. " +
  "No credentials are read, no network request is made directly, and no telemetry exists. " +
  "The two switches that ship on (packing large results, measuring each turn) can only act on text the model has already been shown: neither adds content nor spends quota.";

const SAFETY_NOTES_ZH =
  "只注册智能体工具、提示技能与一个智能体扩展模块，并只申报真正用到的宿主 API。" +
  "合并编辑工具会写入一个项目文件并执行一条由智能体自己给出的 shell 命令，且只在项目根内：路径解析后必须仍在工作区根内（拒绝符号链接逃逸），拒绝 .env*、.ssh/、.aws/、*.pem 与 .git/。" +
  "命令输出有上限（每条流 200 KiB），整个调用也被限制在宿主 110 秒工具上限之内。" +
  "contributes.agentExtensions 声明的 hooks/agent-hooks.js 由 PI-Desktop 载入其智能体进程，这是本插件唯一能在请求发出前看到上下文的途径：开启打包时，它只在本次请求的投影里把过大的文本结果替换为占位符（绝不改写已存会话），原始字节按 observation id 存档、可用 obs_recall 按页精确取回；开启测量时，它每回合追加一行成本记录，不向会话返回任何内容。" +
  "该模块不注册任何工具，只在本插件自己的数据目录内写入，任何一步失败都会原样返回消息。" +
  "观测档案与日志档案按内容寻址，绝不自动删除，也不发往任何地方。" +
  "唯一可能消耗额度或向外发送数据的是「保留证据的日志压缩」：它调用宿主的一次性补全，把日志作为提示输入发给所配置的压缩模型，且默认关闭。" +
  "session.read 只在工具执行期间使用，用于测量实时模型上下文以挑选打包候选与判定压缩经济学；读到的内容除被显式交给压缩调用的那份日志外不外发。" +
  "只有在面板上点击「复制」时才会写入剪贴板，且从不读取剪贴板。不读取任何凭据，不直接发起网络请求，没有任何遥测。" +
  "默认开启的两项（大结果打包、每回合成本测量）只作用于模型已经看过的文本，既不新增内容也不消耗额度。";

// Least privilege: the exact host APIs this plugin calls. `ui.view` for the
// work-panel view, `ui.panel` for the panel itself, tool+skill registration, the
// one-shot completion the reducer needs, the live session context the packing
// scan and the compaction economics need, the model list that carries
// context-window sizes, and the clipboard the panel's brief-copy button writes to.
//
// `agent.extension` is the one grant that lets code of this plugin run inside the
// agent process, as the module declared under `contributes.agentExtensions`. It is
// what makes the packing projection and the per-turn measurement possible at all,
// and it is used for those two things only: `hooks/agent-hooks.js` registers no
// tool, writes only under this plugin's data directory, and returns the messages it
// was given whenever anything fails.
//
// `clipboard.write` is kept even though main.js never writes the clipboard: the
// call happens from the panel, and the host serves that channel itself
// (`case "clipboard.writeText"` in its panel dispatcher) behind this permission.
// `notify` is deliberately absent - this plugin only shows toasts
// (`ui.showToast`), which the host does not gate on the notification APIs.
const PERMISSIONS = Object.freeze([
  "ui.view",
  "ui.panel",
  "clipboard.write",
  "agent.tool.register",
  "agent.prompt.inject",
  "agent.extension",
  "agent.complete",
  "session.read",
  "models.list",
]);

const AGENT_TOOLS = Object.freeze(
  TOOL_DESCRIPTORS.map((tool) => ({ name: tool.name, description: tool.description })),
);

const COMMANDS = Object.freeze([
  {
    id: "solPi.open",
    title: "SoL-Pi: Open",
    keywords: ["sol", "sol-pi", "efficiency", "obs", "pack", "compact", "效率", "打包", "压缩"],
    category: "Productivity",
  },
  {
    id: "solPi.enableLocal",
    title: "SoL-Pi: Enable the two local mechanisms",
    keywords: ["sol", "sol-pi", "enable", "action fusion", "observation pack", "开启", "本地机制"],
    category: "Productivity",
  },
  {
    id: "solPi.disableAll",
    title: "SoL-Pi: Disable every mechanism",
    keywords: ["sol", "sol-pi", "disable", "off", "关闭"],
    category: "Productivity",
  },
  {
    id: "solPi.compactBrief",
    title: "SoL-Pi: Write the compaction brief",
    keywords: ["sol", "sol-pi", "compact", "context", "压缩", "上下文", "简报"],
    category: "Productivity",
  },
]);

// Settings keys keep the upstream `sol-pi.json` names so a config that already
// means something in SoL-Pi keeps meaning the same thing here. The defaults diverge
// from upstream in one place, deliberately: `observationPack` and `turnMeasurement`
// ship on, because both only act on text the model has already been shown, while
// `actionFusion`, `evidencePreservingReducer` and `onlineContextCompact` ship off.
const SETTINGS = Object.freeze([
  {
    key: "actionFusion",
    title: "Action Fusion — let fused_edit run the follow-up command",
    type: "boolean",
    default: false,
  },
  {
    key: "observationPack",
    title: "ObservationPack — pack oversized results in the request, recall them by page",
    type: "boolean",
    default: true,
  },
  {
    key: "evidencePreservingReducer",
    title: "Evidence-Preserving Reducer — reduce long logs with a model call",
    type: "boolean",
    default: false,
  },
  {
    key: "onlineContextCompact",
    title: "Online Context Compact — plan boundaries and compaction economics",
    type: "boolean",
    default: false,
  },
  {
    key: "turnMeasurement",
    title: "Per-turn measurement — record what each turn cost, injecting nothing",
    type: "boolean",
    default: true,
  },
  {
    key: "evidencePreservingReducerProvider",
    title: "Reducer provider id",
    type: "string",
    default: "openai-codex",
  },
  {
    key: "evidencePreservingReducerModel",
    title: "Reducer model id",
    type: "string",
    default: "gpt-5.6-luna",
  },
  {
    key: "cacheWriteReadRatio",
    title: "Cache write-to-read price ratio used by the compaction economics",
    type: "number",
    default: 12.5,
  },
  {
    key: "keepRecentTokens",
    title: "Recent tokens kept verbatim when compaction is evaluated",
    type: "number",
    default: 20000,
  },
]);

const VIEWS = Object.freeze([
  {
    id: "solfi",
    title: { en: "SoL-Pi", "zh-CN": "SoL-Pi" },
    icon: "sparkles",
    entry: "views/index.html",
    order: 60,
  },
]);

/**
 * The quick-access panel `solPi.open` opens, and the docked view in the work
 * panel. Both load the same HTML — one control surface, two places to reach it.
 */
const UI = Object.freeze({
  panel: "views/index.html",
  title: { en: "SoL-Pi", "zh-CN": "SoL-Pi" },
  width: 560,
  height: 680,
  resizable: true,
});

const SKILLS = Object.freeze([
  "skills/sol-pi-overview.md",
  "skills/sol-pi-action-fusion.md",
  "skills/sol-pi-observation-pack.md",
  "skills/sol-pi-evidence-reducer.md",
  "skills/sol-pi-plan-boundaries.md",
]);

/**
 * The one module this plugin contributes to the agent process.
 *
 * It is what gives the port upstream's `context` hook and a per-turn boundary. The
 * host loads contributed modules at the next turn after the grant is given, so a
 * plugin that was just enabled keeps behaving exactly as before until then.
 */
const AGENT_EXTENSIONS = Object.freeze(["hooks/agent-hooks.js"]);

function buildManifest() {
  return {
    schemaVersion: 1,
    id: ID,
    name: NAME,
    version: VERSION,
    description: DESCRIPTION,
    i18n: {
      "zh-CN": {
        name: NAME,
        description: DESCRIPTION_ZH,
        safetyNotes: SAFETY_NOTES_ZH,
      },
    },
    author: AUTHOR,
    homepage: HOMEPAGE,
    categories: ["productivity", "developer-tools", "community"],
    changelog:
      "0.2.0: the hook surface is used, and the two mechanisms that cost nothing now ship on. " +
      "contributes.agentExtensions declares hooks/agent-hooks.js, a module PI-Desktop loads " +
      "inside its agent process, and the new agent.extension permission is what allows it. " +
      "Its `context` handler is upstream's ObservationPack projection, run through this " +
      "port's own library so the two routes cannot drift: a large text tool result is sent " +
      "in full for its first two provider requests, then replaced by the exact placeholder " +
      "while the original bytes stay archived for paged recall. Because the hook sees the " +
      "whole result instead of the host's 8000-character projection of it, upstream's " +
      "10 KiB threshold, its isError rule and its reducer-receipt rule apply exactly. Its " +
      "`turn_end` handler records what each turn cost and returns nothing at all, so a " +
      "measurement cannot change a conversation. Defaults: observationPack and " +
      "turnMeasurement on (both act only on text the model has already been shown), while " +
      "actionFusion, evidencePreservingReducer and onlineContextCompact stay off. Flipping " +
      "a switch in the panel takes effect on the next provider request, and without the " +
      "grant every route behaves exactly as 0.1.2 did. " +
      "0.1.2: the port notes now state the hook situation exactly instead of absolutely. " +
      "A plugin's own code receives no agent event at all — its API carries seven, none of " +
      "them about a tool result or a provider request — while PI-Desktop does expose the " +
      "upstream hook surface, to ExtensionAPI modules contributed through " +
      "contributes.agentExtensions with the agent.extension permission. This port " +
      "deliberately ships none of those, and the new PORT-NOTES section 'The hook surface, " +
      "precisely' lists every event by class (result, mutation, notification, and the ones " +
      "recognised but never emitted) together with what each upstream hook would have given " +
      "the port. The permission set and the empty contributed-module list are now pinned by " +
      "tests, so neither can drift unnoticed. " +
      "0.1.1: path-based tools now resolve the project folder the way the host does. When the window has no project open but the session records one, the session's projectPath is used, so fused_edit, obs_pack path and reduce_evidence path work instead of refusing; a lookup that fails is disclosed in the refusal rather than hidden. Also: obs_pack scan no longer packs its own fused-call results. 0.1.0: first PI-Desktop port of NVlabs/SoL-Pi. Six agent tools covering the four upstream mechanisms — fused_edit (Action Fusion), obs_pack/obs_recall (ObservationPack), reduce_evidence (Evidence-Preserving Reducer) and plan_update/compact_check (Online Context Compact) — plus five skills, a work-panel view, and an offline verification gate. Upstream defaults are preserved: all four mechanisms ship disabled.",
    safetyNotes: SAFETY_NOTES,
    main: "main.js",
    contributes: {
      views: VIEWS,
      commands: COMMANDS,
      agentTools: AGENT_TOOLS,
      skills: SKILLS,
      settings: SETTINGS,
      agentExtensions: AGENT_EXTENSIONS,
    },
    ui: UI,
    permissions: PERMISSIONS,
    engines: { piDesktop: ">=0.15.0" },
    activationEvents: ["onStartup", "onCommand:solPi.open"],
  };
}

module.exports = {
  ID,
  NAME,
  VERSION,
  DESCRIPTION,
  DESCRIPTION_ZH,
  AUTHOR,
  HOMEPAGE,
  UPSTREAM,
  PERMISSIONS,
  AGENT_TOOLS,
  COMMANDS,
  SETTINGS,
  VIEWS,
  UI,
  SKILLS,
  SAFETY_NOTES,
  SAFETY_NOTES_ZH,
  buildManifest,
  AGENT_EXTENSIONS,
};