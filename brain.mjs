import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync, readFileSync, existsSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { CFG } from "./config.mjs";
import { initRuntime, switchEdition, onEditionSwitch, sdkEdition, loadSdk, editionAvailable } from "./sdk.mjs";
import { sanitize, isBroken, isEmptyResult, isSilence } from "./sanitize.mjs";
import { buildMemoryOptions, makeGate, MEMORY_FILE, scrubNotes, noteExcerpt, allEntries, stampUnknownUid, recordSpeaker, enforceProvenance, filterEntryLines, unwrapToolText, recallMemory } from "./memory.mjs";
import { roleOf, checkToolCall, rateCheck, canDo, toolAllowed, imageBudgetTake, urlCheck } from "./auth.mjs";
import { loadImage } from "./media.mjs";
import { cacheGetBytes, cachePutBytes, loadImageCached } from "./media-cache.mjs";
import { createChatQueue } from "./chat-queue.mjs";
import { appendJsonl } from "./jsonl.mjs";
import { createSerialFinalizer } from "./post-turn.mjs";
import { summarizeGroup, consolidateColdWithSdk } from "./session-memory.mjs";
import { searchHistory } from "./history.mjs";
import { addJob, listJobs, cancelJob, repeatLabel, readState } from "./scheduler.mjs";
// 显式用 zod/v4 子路径：SDK 的 zod-compat 同时兼容 v3/v4，钉在 v4 避免落到不同的 zod 实例
import { z } from "zod/v4";

const HERE = dirname(fileURLToPath(import.meta.url));
const layers = await import(pathToFileURL(join(CFG.layersDir, "layers.mjs")).href);
// SDK 双轨：QODER_EDITION 选初始轨（cn/global）；限额耗尽时 switchEdition 自动换轨（8h CD）。
// rt 是"当前轨道"引用——每次构造会话前取 rt.query/rt.auth()，切轨后由回调/tryFailover 刷新。
let rt = await initRuntime();
// L3 与真实工具面必须一致（I9）：SDK 没有进程内 MCP 工厂时，MCP 工具装不上，
// 能力声明里也要同步移除，不能让她说"我能翻记录/能挂定时"而实际没有这些工具。
const MCP_TOOL_OK = typeof rt.createSdkMcpServer === "function" && typeof rt.tool === "function";
const MCP_CHAT_TOOLS = ["SearchHistory", "RecallMemory", "ScheduleTask", "ListScheduledTasks", "CancelScheduledTask"];
const CHAT_TOOLS = MCP_TOOL_OK ? CFG.chatTools : CFG.chatTools.filter((t) => !MCP_CHAT_TOOLS.includes(t));
if (!MCP_TOOL_OK) console.log("[SDK] 进程内 MCP 工具不可用（工厂缺失），已从 L3 能力声明中移除历史/长期记忆检索、定时任务");
// 切轨清理（审查修复）：不强关在途会话（避免打断正在回复的轮次、丢记忆、误触发整轮重发），
// 只标 stale + 刷新 rt——在途轮自然跑完（若旧轨已限额会被识别为静默），下一轮 get() 重建为新轨；
// rt 刷新放回调首行，保证重建引用的就是新轨。记事本/转录是本地文件，跨轨不丢。
onEditionSwitch(async () => {
  rt = await initRuntime();
  let n = 0;
  for (const [key, s] of sessions) { s.stale = true; n++; recordTurn(key, { phase: "failover", to: sdkEdition() }); }
  console.log(`[SDK] 已标记 ${n} 个会话待重建，下一轮各群自动开新会话（记事本/转录不受影响）`);
});
const SYSTEM_PROMPT = layers.buildSystemPrompt({ character: CFG.character, tools: CFG.tools, chatTools: CHAT_TOOLS });
// 净化时要把内部工具名替换掉（模型偶尔会把 WebFetch 这种词直接说出去）
const TOOL_WORDS = [...new Set([...CFG.tools, ...CFG.chatTools, ...CFG.hardDenied])];
const SAN_OPT = { maxChars: CFG.replyMaxChars, maxSentences: CFG.replyMaxSentences, toolNames: TOOL_WORDS };

// ImageGen 的最终文本常把本地路径、尺寸一起念出来；路径不发给用户（图由适配层单独发），
// 只留一句短评。这个函数只在真有图时调用，避免误伤普通聊天里的路径词。
function stripImagePaths(text) {
  const t = String(text ?? "")
    .replace(/[A-Za-z]:[\\/][^\n`"'）)，。；;]*/g, " ")
    .replace(/file:\/\/\S+/gi, " ")
    .replace(/[（(][^）)]*(?:尺寸|规格|像素)[^）)]*[）)]/g, " ")
    .replace(/[，,。；;：:]?\s*(?:已)?保存在(?:当前目录|本地|这里)?\s*[:：]?/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .replace(/[，,：:；;]\s*$/, "")
    .trim();
  return t || "画好了，给你。";
}

// ImageSearch 的最终文本经常是带链接/表格的结果列表；只留一句短话，图由适配层发第一张。
function cleanSearchReply(text, results = []) {
  const title = String(results[0]?.title ?? "").trim().slice(0, 24);
  let t = String(text ?? "");
  t = t.replace(/[\[\(（【]{1,2}\s*pick\s*[:：]\s*\d+\s*[\]\)）】]{1,2}/gi, " ");
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  t = t.replace(/https?:\/\/\S+/gi, " ");
  t = t.replace(/^\s*\|.*$/gm, " ");
  t = t.replace(/来源说明[\s\S]*$/g, " ");
  t = t.replace(/[ \t]{2,}/g, " ").trim();
  if (!t || t.length > 60 || /查看图片|序号|尺寸|来源|以下|列表|第[一二三四五12345]张/i.test(t)) {
    t = title ? `找到了一张：${title}` : "找到了，你看看这张。";
  }
  return t;
}

// 模型用 [pick:N] 指定语义最符合的结果；把选中项挪到 searchImages[0]，
// 适配层只发第一项，所以不需要额外改发送侧。标记永远不进入可见回复。
export function applySearchPick(m) {
  if (!m?.searchImages?.length) return m;
  const raw = String(m.result ?? "");
  const marker = /[\[\(（【]{1,2}\s*pick\s*[:：]\s*(\d+)\s*[\]\)）】]{1,2}/i.exec(raw);
  let n = marker ? Number(marker[1]) : 0;
  if (!n) {
    const cn = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5 };
    const m2 = /第\s*([一二三四五1-5])\s*张/.exec(raw);
    if (m2) n = cn[m2[1]] || Number(m2[1]) || 0;
  }
  m.result = raw.replace(/[\[\(（【]{1,2}\s*pick\s*[:：]\s*\d+\s*[\]\)）】]{1,2}/gi, " ").trim();
  if (Number.isInteger(n) && n >= 1 && n <= m.searchImages.length) {
    m.searchPick = n;
    m.searchImages = [m.searchImages[n - 1], ...m.searchImages.filter((_, i) => i !== n - 1)];
  }
  return m;
}

const hasMedia = (m) => Boolean(m?.images?.length || m?.searchImages?.length || m?.draw);
const SEE_WEB = /[\[\(（【]{1,2}\s*see[-_ ]?web\s*[\]\)）】]{1,2}/i;
const EDGE_PATHS = [
  process.env.EDGE_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const EDGE = EDGE_PATHS.find((p) => existsSync(p));

// 清理截图临时文件：taskkill/删 profile 不再占截图返回路径（WP2）。
// 用异步 execFile/fs.promises，避免在事件循环上同步阻塞；失败只记日志。
function cleanupScreenshot({ child, file, profile }) {
  try { child.kill(); } catch {}
  if (child?.pid) {
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  }
  fsp.rm(file, { force: true }).catch(() => {});
  fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
  const t = setTimeout(() => { fsp.rm(file, { force: true }).catch(() => {}); fsp.rm(profile, { recursive: true, force: true }).catch(() => {}); }, 10_000);
  t.unref?.();
}

// 进程上次退出可能留下 Edge profile；每次截图前顺手扫掉 30 分钟前的残留。
function sweepScreenshotTemp(dir = join(tmpdir(), "xiaoqian-web-shot")) {
  try {
    if (!existsSync(dir)) return;
    const cutoff = Date.now() - 30 * 60_000;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) fsp.rm(p, { recursive: true, force: true }).catch(() => {});
      } catch {}
    }
  } catch {}
}

// 网页视觉：只对已通过 urlCheck 的公网 URL 用本机 Edge headless 截一张。
// 模型自己决定要不要（在 WebFetch 回复末尾写 [see-web]）；截图只进模型，不落聊天。
async function screenshotWebPage(url, { chatKey = "" } = {}) {
  const g = await urlCheck(url);
  if (!g.ok) throw new Error(`网页地址不安全：${g.reason}`);
  const cacheKey = `screenshot:${url}|1280x2000`;
  if (CFG.mediaCache && chatKey) {
    const hit = cacheGetBytes(groupDir(chatKey), cacheKey, CFG.mediaCacheTtlMs);
    if (hit) return { mediaType: hit.mediaType, data: hit.bytes.toString("base64") };
  }
  if (!EDGE) throw new Error("没找到 msedge.exe（可用 EDGE_PATH 指定）");
  const dir = join(tmpdir(), "xiaoqian-web-shot");
  mkdirSync(dir, { recursive: true });
  sweepScreenshotTemp(dir);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const file = join(dir, `shot-${stamp}.png`);
  const profile = join(dir, `profile-${stamp}`);
  // 不要等 Edge 退出：B 站这类页面会在 7–8 秒写好截图，但浏览器进程继续跑，
  // execFile 的 25s timeout 会把“已经成功的截图”当失败并删掉。这里改为轮询文件。
  const child = spawn(EDGE, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
    "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`,
    "--window-size=1280,2000",
    "--virtual-time-budget=8000",
    `--screenshot=${file}`,
    url,
  ], { windowsHide: true, stdio: "ignore" });
  let lastSize = -1;
  let result = null;
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        let size = 0;
        try { size = statSync(file).size; } catch {}
        if (size > 0 && size === lastSize) {
          const data = readFileSync(file);
          if (!data.length) throw new Error("截图是空的");
          if (data.length > CFG.imageMaxBytes) throw new Error(`截图太大 ${data.length} 字节`);
          if (CFG.mediaCache && chatKey) cachePutBytes(groupDir(chatKey), cacheKey, { bytes: data, mediaType: "image/png", ext: ".png", urlCheckOk: true });
          result = { mediaType: "image/png", data: data.toString("base64") };
          return result;
        }
        lastSize = size;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("截图超时（15s 内没有稳定文件）");
  } finally {
    if (CFG.screenshotAsyncCleanup) cleanupScreenshot({ child, file, profile });
    else {
      try { execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {}); } catch {}
      try { rmSync(file, { force: true }); } catch {}
      try { rmSync(profile, { recursive: true, force: true }); } catch {}
    }
  }
}

// 候选图下载：ImageSearch 结果一到就可以先跑，隐藏在第一段模型回复期间（WP4）。
async function fetchSearchCandidates(results, { chatKey = "" } = {}) {
  const dir = chatKey ? groupDir(chatKey) : "";
  const fetched = await Promise.all((results ?? []).slice(0, 5).map(async (r) => {
    try {
      const img = dir
        ? await loadImageCached(r.url, { dir, key: `search:${r.url}`, ttlMs: CFG.searchCacheTtlMs })
        : await loadImage(r.url);
      if (!img?.data) return null;
      return { ...r, data: img.data, mediaType: img.mediaType };
    } catch (e) {
      console.log(`[视觉挑选] 候选图下载失败：${e.message}`);
      return null;
    }
  }));
  return fetched.filter(Boolean);
}

// 第二轮视觉挑选：下载候选图，按顺序连标题一起喂给模型，让它按画面选一张。
// 失败（下载不足 2 张/第二轮超时）返回 null，调用方退回标题挑选或第一张。
async function pickByVision(s, m, ctx) {
  const results = (m.searchImages ?? []).slice(0, 5);
  const candidates = ctx?.searchCandidatesPromise
    ? await ctx.searchCandidatesPromise
    : await fetchSearchCandidates(results, { chatKey: ctx?.chatKey });
  if (candidates.length < 2) return null;
  const list = candidates.map((c, i) => `${i + 1}. ${String(c.title ?? "").replace(/\s+/g, " ").slice(0, 40)}`).join("\n");
  const content = [
    { type: "text", text: `（系统：下面是刚才搜到的候选图，按顺序 1..${candidates.length}，你能看图。请按主人刚才的要求挑一张最符合的，只回一句不超过 20 字的短话，并在最后单独一行写 [pick:N]；不要列表、链接、来源。）\n${list}` },
    ...candidates.map((c) => ({ type: "image", source: { type: "base64", media_type: c.mediaType, data: c.data } })),
  ];
  let vm;
  try {
    vm = await settle(s, s.ask(content, ctx));
  } catch (e) {
    if (e.timedOut && e.entry) await cancelTurn(s, e.entry);
    console.log(`[视觉挑选] 失败：${e.message ?? e}`);
    return null;
  }
  // 限额时挑选调用也只会返回空：直接退回标题/第一张，别把空 result 当挑选结果（2026-10-31）
  if (isQuotaMessage(quotaTextOf(vm))) {
    console.log("[视觉挑选] 命中限额，退回标题挑选");
    return null;
  }
  const meta = candidates.map(({ data, mediaType, ...rest }) => rest);
  const picked = applySearchPick({ result: vm.result, searchImages: meta });
  const pick = picked.searchPick ?? 1;
  s.toolLog.push({ stage: "视觉挑选", name: "ImageSearch", role: ctx.role, user: ctx.userId ?? "?", candidates: candidates.length, pick });
  if (s.toolLog.length > 40) s.toolLog.shift();
  return { result: picked.result, searchImages: picked.searchImages, searchPick: pick };
}

// 一群一目录：SDK 的会话与记忆都按 cwd 分家，这就是隔离边界。
// onebot 的旁路缓冲（recent.jsonl）也落在这里，所以导出给适配层复用同一个映射。
export const GROUPS_ROOT = join(HERE, CFG.groupsDir);
const GROUPS_DIR = GROUPS_ROOT;
export function groupDir(chatKey) {
  const slug = chatKey.replace(/[^A-Za-z0-9一-鿿_-]+/g, "_").slice(0, 40);
  const hash = [...chatKey].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 7).toString(36).slice(0, 6);
  const dir = join(GROUPS_DIR, `${slug}-${hash}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const idFile = (dir) => join(dir, "session.json");
function readSessionId(dir) {
  try {
    const j = JSON.parse(readFileSync(idFile(dir), "utf8"));
    return { sessionId: j.sessionId, turns: j.turns ?? 0 };
  } catch { return { sessionId: "", turns: 0 }; }
}
function writeSessionId(dir, sessionId, turns) {
  try { writeFileSync(idFile(dir), JSON.stringify({ sessionId, turns, updatedAt: Date.now() }, null, 1)); }
  catch (e) { console.log(`[会话索引写盘失败] ${e.message}`); }
}

// 本地转录：不花额度不调模型，只追加 JSONL，供 summarize.mjs 当原料。
// 正常路径只 append；超过 2×上限才压缩一次（WP9a），避免每轮读全量重写。
function appendTranscript(dir, obj) {
  const file = join(dir, CFG.transcriptFile);
  if (!appendJsonl(file, obj, { max: CFG.transcriptMaxLines })) console.log("[转录写入失败]");
}

// 每轮脱敏指标：不写正文/URL/token；回复、跳过、丢弃、兜底、发送各一条，用 turnId 关联。
export function recordTurn(chatKey, obj) {
  if (!CFG.turnsLog) return false;
  try {
    return appendJsonl(join(groupDir(chatKey), CFG.turnsFile), { ts: Date.now(), chatKey, ...obj }, { max: CFG.turnsMaxLines });
  } catch { return false; }
}

function makeStream() {
  const buf = [];
  let waiting = null, done = false;
  return {
    push: (v) => {
      if (waiting) { const r = waiting; waiting = null; r({ value: v, done: false }); }
      else buf.push(v);
    },
    close: () => { done = true; if (waiting) { const r = waiting; waiting = null; r({ value: undefined, done: true }); } },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (buf.length) return Promise.resolve({ value: buf.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => { waiting = res; });
        },
      };
    },
  };
}

// ---------- 运行时 hook（模块级导出：SDK hooks 与离线测试 hooks.test.mjs 共用同一份逻辑） ----------
// 归因：优先按 tool_use_id 认领这一轮是谁（assistant 的 tool_use 块先于回调出现时才能命中），
// 命中不了才退队首，再没有在途轮次就按 guest（fail-closed）。台账写清楚用的哪种，别让归因看起来比实际可靠。
function resolveHookCtx(session, idOrNull) {
  const byId = idOrNull ? session.ctxByTool.get(String(idOrNull)) : null;
  const ctx = byId ?? session.pending[0]?.ctx ?? { role: "guest" };
  const via = byId ? "toolUseID" : session.pending[0]?.ctx ? "队首" : "无在途";
  return { ctx, via };
}
function logJudge(session, rec) {
  session.toolLog.push(rec);
  if (session.toolLog.length > 40) session.toolLog.shift();
}

// WP12：同一 tool_use_id + 输入的 checkToolCall 只跑一次；canUseTool 与 PreToolUse 共享。
// 缓存的是判定结果（allow/deny/resolvedPath），不是 hook 响应；两层仍各自执行。
export function checkToolCallCached(session, name, input, toolUseID, role) {
  const run = () => checkToolCall(role ?? session.pending?.[0]?.ctx?.role ?? "guest", name, input, { memRoot: session.memRoot });
  if (!CFG.dualCheckCache) return run();
  if (!session.decisions) session.decisions = new Map();
  let digest = "";
  try { digest = createHash("sha256").update(JSON.stringify(input ?? {})).digest("hex").slice(0, 16); } catch { digest = "?"; }
  // 协议通常带 tool_use_id；缺少时用同轮 name+role+输入摘要兜底（缓存每轮清空）
  const key = `${toolUseID ? String(toolUseID) : `noid:${name}:${role ?? "?"}`}|${name}|${digest}`;
  const hit = session.decisions.get(key);
  if (hit) return hit;
  const p = run();
  // 缓存的 Promise 可能被多个消费者共享；挂一个 no-op catch 防止无消费者时的 unhandledRejection，
  // 原 Promise 的 reject 语义仍完整传播给每个 await/then 的调用方
  p.catch(() => {});
  session.decisions.set(key, p);
  if (session.decisions.size > 60) session.decisions.delete(session.decisions.keys().next().value);
  return p;
}
function denyHook(session, { name, ctx, via, reason }) {
  logJudge(session, { stage: "判定", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: false, reason });
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

// Grep/Glob 的执行前围栏：owner-only、pattern 不许带路径、搜索根强制覆写为本群记事本目录。
// canUseTool 对这两个内置工具不触发——实弹探针证实，判定行缺失——这里是运行时唯一闸门。
export function judgeSearchInput(session, input) {
  const name = input?.tool_name ?? "?";
  const { ctx, via } = resolveHookCtx(session, input?.tool_use_id);
  const deny = (reason) => denyHook(session, { name, ctx, via, reason });
  if (ctx.role !== "owner") return deny("本子是她自己的事，只有主人能翻和改");
  const ti = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)|^[a-zA-Z]:[\\/]/.test(String(ti.pattern ?? ""))) return deny("搜索词里不许带路径");
  logJudge(session, { stage: "判定", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: true, reason: "path 已覆写为本群记事本目录" });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...ti, path: session.memRoot },
    },
  };
}

// SearchHistory 的执行前硬门（2026-11-03）：实弹探针确认 MCP 工具**不走 canUseTool**
// （必须 permissionPolicy=always_allow 才执行，探针里 canUseTool 的 allow 被无视），所以 hooks 是
// 唯一执行闸门；handler 内另有一道角色复核（钩子异常/未投递时也不放行）。只判角色；
// 查询词的清洗/截断在 history.mjs 里做（不依赖模型传参可信）。
export function judgeHistory(session, input) {
  const name = input?.tool_name ?? "SearchHistory";
  const base = String(name).replace(/^mcp__xqhistory__/, "");
  const isRecall = base === "RecallMemory";
  const { ctx, via } = resolveHookCtx(session, input?.tool_use_id);
  const deny = (reason) => denyHook(session, { name, ctx, via, reason });
  if (!toolAllowed(ctx.role, isRecall ? "RecallMemory" : "SearchHistory")) return deny(isRecall ? "这个角色不能翻长期记忆" : "这个角色不能翻本群聊天记录");
  logJudge(session, { stage: "判定", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: true, reason: isRecall ? "只读长期记忆" : "只读本群转录" });
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

// 定时任务三件套的执行前硬门（2026-11-03）：全员可用（guest 除外），配额在 handler 里按
// 创建者+当天跨会话合计校验（非主人每人每天 1 个，主人不限）。MCP 工具只走 hooks，所以这里是角色闸门。
export function judgeScheduleTools(session, input) {
  const name = input?.tool_name ?? "ScheduleTask";
  const base = String(name).replace(/^mcp__xqschedule__/, "");
  const { ctx, via } = resolveHookCtx(session, input?.tool_use_id);
  const deny = (reason) => denyHook(session, { name, ctx, via, reason });
  if (!["owner", "admin", "member"].includes(String(ctx.role))) return deny("这个身份不能挂/看/取消定时任务");
  if (!toolAllowed(ctx.role, base)) return deny("这个角色不能挂/看/取消定时任务");
  logJudge(session, { stage: "判定", name: base, role: ctx.role, user: ctx.userId ?? "?", via, ok: true, reason: "定时任务工具" });
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

// ImageGen 的执行前硬门：只 owner、每轮最多 CFG.imageGenMaxPerTurn 张、每日预算。
// 实弹探测确认 ImageGen 不走 canUseTool，只触发 PreToolUse，所以这里就是唯一运行时闸门。
export function judgeImageGen(session, input) {
  const name = input?.tool_name ?? "ImageGen";
  const { ctx, via } = resolveHookCtx(session, input?.tool_use_id);
  const deny = (reason) => denyHook(session, { name, ctx, via, reason });
  if (ctx.scheduled) return deny("定时任务只能说话，不能画图");
  if (ctx.role !== "owner") return deny("画图只给主人用");
  if (ctx.draw) return deny("这张已经在后台画了，画好会发");
  if ((ctx.imageCalls ?? 0) >= CFG.imageGenMaxPerTurn) return deny("这一轮只画一张");
  const budget = imageBudgetTake({ userId: ctx.userId, chatKey: ctx.chatKey });
  if (!budget.ok) return deny(budget.reason);
  const prompt = String(input?.tool_input?.prompt ?? input?.tool_input?.description ?? "").trim();
  if (!prompt) return deny("没给画图提示词");
  ctx.imageCalls = (ctx.imageCalls ?? 0) + 1;
  ctx.draw = { prompt: prompt.slice(0, 800), name: String(input?.tool_input?.name ?? "image") };
  logJudge(session, { stage: "排队", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: true, reason: "后台画图", chars: prompt.length });
  // 不执行内置 ImageGen：主回合立即结束，真正生成交给 generateImage 的后台 SDK 会话
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "好，画图已排队，画好会发图" } };
}

// ImageSearch 也绕过 canUseTool（同 WebSearch/ImageGen），这里按 toolPolicy 判角色。
export function judgeImageSearch(session, input) {
  const name = input?.tool_name ?? "ImageSearch";
  const { ctx, via } = resolveHookCtx(session, input?.tool_use_id);
  if (ctx.scheduled) return denyHook(session, { name, ctx, via, reason: "定时任务只能说话，不能找图" });
  if (!toolAllowed(ctx.role, name)) return denyHook(session, { name, ctx, via, reason: "这个角色不能找图" });
  logJudge(session, { stage: "判定", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: true, reason: "role" });
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

// 文件工具兜底闸门：Read/Write/Edit/MultiEdit 原本只有 canUseTool 一层，
// 而它的实弹触发台账从未取得。hooks 再拦一层，
// 与 canUseTool 共用同一套 checkToolCall 判定（owner-only + pathWithin + resolvedPath 回填）。
export function judgeFileTool(session, input) {
  const name = input?.tool_name ?? "?";
  const { ctx, via } = resolveHookCtx(session, input?.tool_use_id);
  const ti = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  // 审计修复：判定本身抛错（理论上极少）时按 fail-closed 处理——hook 侧拒绝，绝不因异常放行
  return checkToolCallCached(session, name, ti, input?.tool_use_id, ctx.role).then(
    (v) => {
      if (v.behavior === "deny") return denyHook(session, { name, ctx, via, reason: v.message ?? "记事本之外不许动" });
      logJudge(session, { stage: "判定", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: true, reason: v.resolvedPath ? "path 已回填为围栏内绝对路径" : "allow" });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          ...(v.resolvedPath && Object.keys(ti).length ? { updatedInput: { ...ti, file_path: v.resolvedPath } } : {}),
        },
      };
    },
    (e) => denyHook(session, { name, ctx, via, reason: `判定异常，按拒绝处理：${String(e?.message ?? e).slice(0, 60)}` }),
  );
}

// WebFetch 兜底闸门（审核 F-02）：urlCheck 原本只在 canUseTool 里跑（G6 从未实弹）。
// hook 里再跑同一判定，私网/回环/非 http(s)/怪端口在这里也会被拒。
// 注意 checkToolCall 是 async（urlCheck 要做 DNS 解析）：这里必须 await，否则判定恒为 allow
export function judgeWebFetch(session, input) {
  const name = "WebFetch";
  const { ctx, via } = resolveHookCtx(session, input?.tool_use_id);
  const ti = input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  // 判定异常同样 fail-closed（见 judgeFileTool）
  return checkToolCallCached(session, name, ti, input?.tool_use_id, ctx.role).then(
    (v) => {
      if (v.behavior === "deny") return denyHook(session, { name, ctx, via, reason: v.message ?? "这个地址不抓" });
      logJudge(session, { stage: "判定", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: true, reason: "url" });
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
    },
    (e) => denyHook(session, { name, ctx, via, reason: `判定异常，按拒绝处理：${String(e?.message ?? e).slice(0, 60)}` }),
  );
}

// Grep/Glob 的工具结果回灌前过滤（PostToolUse）：只留匹配 ENTRY 形状的行
// （memory.filterEntryLines）：散文丢弃、敏感行丢弃、未批准的规矩不出现。
// tool_response 形状由 memory.unwrapToolText 归一（实测是 {llmContent,...}，不是 TS 声明的 {results}）
export function filterSearchResultImpl(session, input) {
  const text = unwrapToolText(input?.tool_response);
  const filtered = filterEntryLines(text);
  const from = [...text].length, kept = [...filtered].length;
  if (from !== kept) logJudge(session, { stage: "结果过滤", name: input?.tool_name ?? "?", from, kept });
  // 空结果要跟"命中了但全被滤掉"分开说：真没搜到不能说成命中，否则她会以为本子里藏着东西
  let out = filtered;
  if (!out) {
    const zeroHit = !text.trim() || /no (matches|files) found/i.test(text);
    out = zeroHit ? "（本子里没搜到）" : "（搜索命中了内容，但没有可展示的结构化条目）";
  }
  return { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: out } };
}

// ---------- 日限额识别（2026-10-29 复读排障） ----------
// 免费档 Chat 日限额耗尽时 SDK 不抛错：限额提示以 assistant 文本返回、result 为空（subtype=error_during_execution）。
// 原行为：判空 → 重试 → 仍空 → broken → 每条消息都回同一句兜底（群里复读）。
// 现在：识别后静默跳过 + 限频打一次真实原因；日限额每日自动重置，不需要人工干预。
// 2026-10-31 补：cn 轨的真实文案是 "You've reached your **credit** usage limit..."，且塞在 result 的
// **errors 数组**里（result/assistantText 都是空）——旧正则只认 daily 变体、旧判定只查两个文本字段，
// 于是 23:19 额度耗尽后连发 5 条 broken 兜底（三条一模一样）。两个缺口一起补。
export const QUOTA_RE = /reached your (?:daily |credit )?usage limit|daily usage limit|credit usage limit|quota (?:has been )?exceeded/i;
export function isQuotaMessage(v) { return QUOTA_RE.test(String(v ?? "")); }
// 限额文案可能出现在 assistantText 或 errors（数组/字符串/对象）任一处。
// result 是她的回复正文，**默认不纳入**——否则她复述/转述那句英文报错就会被判限额并真切轨（8h CD）。
// 只有 subtype=error_during_execution（执行失败帧，没有正常回复可发）才把 result 也算上。
export function quotaTextOf(m) {
  const e = m?.errors;
  const err = Array.isArray(e) ? e.join(" ") : (e && typeof e === "object" ? JSON.stringify(e) : e);
  const parts = [m?.assistantText, err];
  if (String(m?.subtype ?? "") === "error_during_execution") parts.push(m?.result);
  return parts.filter(Boolean).join("\n");
}
let lastQuotaLogAt = 0;
export function quotaNotice(kind = "限额") {
  const t = Date.now();
  if (t - lastQuotaLogAt < 10 * 60_000) return;   // 同类原因 10 分钟内只打一次，别刷日志
  lastQuotaLogAt = t;
  console.log(`[模型] ${kind}：本轮静默跳过（不回兜底句），明日自动恢复`);
}

// 限额时的双轨 failover：切到另一轨（8h CD，见 sdk.mjs）并刷新运行时引用；
// 切换失败（另一轨凭据不可用/冷却中）时维持静默，quotaNotice 限频提示。
// 切轨成功后当前轮仍静默返回，下一轮消息自动走新轨（onEditionSwitch 已清内存会话）。
async function tryFailover() {
  let ok = false;
  try { ok = await switchEdition("免费档 Chat 日限额已用完"); }
  catch (e) { console.log(`[SDK] 切轨尝试失败：${String(e?.message ?? e).slice(0, 120)}`); }
  if (!ok) quotaNotice("免费档 Chat 日限额已用完");
  try { rt = await initRuntime(); } catch {}
  return ok;
}

class BrainSession {
  constructor(key) {
    this.key = key;
    this.dir = groupDir(key);
    this.memRoot = join(this.dir, CFG.memoryDir);
    const stored = readSessionId(this.dir);
    this.resumed = false;
    if (stored.sessionId && stored.turns < CFG.rotateAfterTurns) this.resumed = true;
    else if (stored.sessionId) {
      console.log(`[轮换] ${key} 已聊 ${stored.turns} 轮 ≥ ${CFG.rotateAfterTurns}，开新会话（旧上下文不再带上，记事本保留）`);
      // 重启后才发现已到轮换阈值：旧会话不在内存里，由构造器补一次摘要。
      queueRotationSummary(key, this.dir);
    }
    this.src = makeStream();
    this.pending = [];
    this.dead = false;
    this.lastUsed = Date.now();
    this.turns = this.resumed ? stored.turns : 0;
    this.memLog = { gate: [], gen: [], consume: [] };
    this.toolLog = [];
    this.ctxByTool = new Map();
    this.toolNameById = new Map();
    this.lastSpeaker = null;
    const memory = CFG.memoryEnabled
      ? buildMemoryOptions(this.dir, {
          // 门的 uid 认队首那一轮（正在生成的这一轮是谁），不认"最后开口的人"：
          // 后台生成迟一轮时 lastSpeaker 已经是下一个说话者了
          gate: makeGate(this.memLog.gate, () => this.pending[0]?.ctx?.userId ?? this.lastSpeaker),
          onGen: (r) => this.memLog.gen.push({ status: r.status, written: (r.writtenFiles || []).map((f) => String(f.path).split(/[\\/]/).pop()), credits: r.usage?.credits ?? null }),
          onConsume: (r) => this.memLog.consume.push({ files: (r.files || []).map((f) => `${f.id}:${f.status ?? "?"}`) }),
          consolidate: (d) => consolidateColdWithSdk(d),
        })
      : undefined;
    // SearchHistory（2026-11-03）：进程内 MCP 工具，目录闭包在本会话 dir 上——模型传什么参数都
    // 跳不出本群。SDK 没暴露工厂时（老版本/BYOK 基础轨异常）安全降级为不装该工具。
    const historyServer = typeof rt.createSdkMcpServer === "function" && typeof rt.tool === "function"
      ? rt.createSdkMcpServer({
          name: "xqhistory",
          version: "1.0.0",
          tools: [rt.tool(
            "SearchHistory",
            "检索本群她接过话的历史原话（只读，最多 5 条）。对方问「之前说过什么」「上次那个」「你还记得谁说…」而记事本里没有时用。",
            {
              query: z.string().describe("要查找的关键词或短语（1-100 字）"),
              days: z.number().int().min(1).max(30).optional().describe("往回查几天，默认 7"),
            },
            async ({ query, days }) => {
              // 第二道闸（审查 S1）：钩子异常/未投递时也不放行。同群串行 → 队首就是当前轮。
              const role = this.pending[0]?.ctx?.role ?? "guest";
              if (!toolAllowed(role, "SearchHistory")) {
                return { content: [{ type: "text", text: "这个角色不能翻本群聊天记录。" }], isError: true };
              }
              const text = searchHistory(this.dir, query, { days });
              logJudge(this, { stage: "工具", name: "SearchHistory", role, user: this.pending[0]?.ctx?.userId ?? "?", via: "-", ok: true, reason: `q=${String(query ?? "").slice(0, 20)}` });
              return { content: [{ type: "text", text }] };
            },
            // 实弹验证（2026-11-03）：MCP 工具不走 canUseTool，必须 permissionPolicy=always_allow
            // 才能执行；角色闸门由 PreToolUse 的 judgeHistory 兜住（探针确认钩子会拦、tool_name=SearchHistory）
            { annotations: { readOnlyHint: true }, exposedName: "SearchHistory", alwaysLoad: true, permissionPolicy: "always_allow" },
            rt.tool(
              "RecallMemory",
              "检索本群长期记忆（只读，最多 5 条）。对方问以前约定、偏好、长期事实而【你记得的】里没有时用；长期记忆细节不常驻上下文。",
              {
                query: z.string().describe("要查找的关键词或短语（1-100 字）"),
              },
              async ({ query }) => {
                // 第二道闸：钩子异常/未投递时也不放行。同群串行 → 队首就是当前轮。
                const role = this.pending[0]?.ctx?.role ?? "guest";
                if (!toolAllowed(role, "RecallMemory")) {
                  return { content: [{ type: "text", text: "这个角色不能翻长期记忆。" }], isError: true };
                }
                const text = recallMemory(this.dir, query);
                logJudge(this, { stage: "工具", name: "RecallMemory", role, user: this.pending[0]?.ctx?.userId ?? "?", via: "-", ok: true, reason: `q=${String(query ?? "").slice(0, 20)}` });
                return { content: [{ type: "text", text }] };
              },
              { annotations: { readOnlyHint: true }, exposedName: "RecallMemory", alwaysLoad: true, permissionPolicy: "always_allow" },
            ),
          )],
        })
      : null;
    // 定时任务三件套（2026-11-03）：全员可挂，非主人每人每天跨会话合计 1 个（主人不限）。
    // 配额在 handler 里用创建者+当天校验；PreToolUse 只做身份闸门。
    const scheduleServer = MCP_TOOL_OK
      ? rt.createSdkMcpServer({
          name: "xqschedule",
          version: "1.0.0",
          tools: [
            rt.tool(
              "ScheduleTask",
              "给这个会话挂一个定时任务：到点系统会叫你，你现场说一句。time 用 24 小时制 HH:MM；repeat 用 daily（每天）、weekdays（工作日）、weekly:0-6（0=周日）、once（仅一次，必须同时给 date=YYYY-MM-DD）。非主人每人每天最多挂 1 个，主人不限。",
              {
                time: z.string().describe("24 小时制 HH:MM，例如 12:00"),
                repeat: z.string().optional().describe("daily / weekdays / weekly:0-6（0=周日）/ once，默认 daily"),
                date: z.string().optional().describe("仅 once 需要：YYYY-MM-DD（一次性任务的日期）"),
                prompt: z.string().describe("到点要做什么或说什么，最多 200 字"),
              },
              async ({ time, repeat, date, prompt }) => {
                const ctx = this.pending[0]?.ctx ?? { role: "guest" };
                if (!toolAllowed(ctx.role, "ScheduleTask")) return { content: [{ type: "text", text: "这个身份不能挂定时任务。" }], isError: true };
                const r = addJob(this.dir, { chatKey: this.key, time, repeat, date, prompt, createdBy: ctx.userId, createdByName: ctx.name, role: ctx.role, quotaRoot: GROUPS_ROOT });
                logJudge(this, { stage: "工具", name: "ScheduleTask", role: ctx.role, user: ctx.userId ?? "?", via: "-", ok: r.ok, reason: r.ok ? `${repeatLabel(r.job)} ${r.job.time}` : r.error.slice(0, 40) });
                return {
                  content: [{
                    type: "text",
                    text: r.ok
                      ? `已挂上：${repeatLabel(r.job)} ${r.job.time}，id=${r.job.id}。到点会叫你，不用再提醒对方。`
                      : `没挂上：${r.error}`,
                  }],
                };
              },
              { annotations: { readOnlyHint: false }, exposedName: "ScheduleTask", alwaysLoad: true, permissionPolicy: "always_allow" },
            ),
            rt.tool(
              "ListScheduledTasks",
              "列出这个会话里挂着的定时任务。非主人只看得到自己挂的。",
              {},
              async () => {
                const ctx = this.pending[0]?.ctx ?? { role: "guest" };
                if (!toolAllowed(ctx.role, "ListScheduledTasks")) return { content: [{ type: "text", text: "这个身份不能看定时任务。" }], isError: true };
                const st = readState(this.dir);
                if (st.corrupt) return { content: [{ type: "text", text: "这个会话的任务表损坏，先让主人备份/修复。" }], isError: true };
                const jobs = listJobs(this.dir, { createdBy: ctx.userId, role: ctx.role });
                logJudge(this, { stage: "工具", name: "ListScheduledTasks", role: ctx.role, user: ctx.userId ?? "?", via: "-", ok: true, reason: `n=${jobs.length}` });
                if (!jobs.length) return { content: [{ type: "text", text: "这个会话还没有定时任务。" }] };
                return {
                  content: [{
                    type: "text",
                    text: "这个会话的定时任务：\n" + jobs.map((j) => `- id=${j.id} ｜ ${repeatLabel(j)} ${j.time} ｜ ${j.prompt} ｜ ${j.createdByName || j.createdBy}`).join("\n"),
                  }],
                };
              },
              { annotations: { readOnlyHint: true }, exposedName: "ListScheduledTasks", alwaysLoad: true, permissionPolicy: "always_allow" },
            ),
            rt.tool(
              "CancelScheduledTask",
              "取消一个定时任务，必须提供 id（先用 ListScheduledTasks 查）。非主人只能取消自己挂的。",
              { id: z.string().describe("任务 id，形如 sch-xxxx") },
              async ({ id }) => {
                const ctx = this.pending[0]?.ctx ?? { role: "guest" };
                if (!toolAllowed(ctx.role, "CancelScheduledTask")) return { content: [{ type: "text", text: "这个身份不能取消定时任务。" }], isError: true };
                const r = cancelJob(this.dir, id, { createdBy: ctx.userId, role: ctx.role });
                logJudge(this, { stage: "工具", name: "CancelScheduledTask", role: ctx.role, user: ctx.userId ?? "?", via: "-", ok: r.ok, reason: r.ok ? String(id).slice(0, 20) : r.error.slice(0, 40) });
                return { content: [{ type: "text", text: r.ok ? `已取消 ${id}。` : `没取消：${r.error}` }] };
              },
              { annotations: { readOnlyHint: false }, exposedName: "CancelScheduledTask", alwaysLoad: true, permissionPolicy: "always_allow" },
            ),
          ],
        })
      : null;
    const mcpServers = {};
    if (historyServer) mcpServers.xqhistory = historyServer;
    if (scheduleServer) mcpServers.xqschedule = scheduleServer;
    this.q = rt.query({
      prompt: this.src,
      options: {
        auth: rt.auth(),
        cwd: this.dir,
        model: CFG.model,
        systemPrompt: SYSTEM_PROMPT,
        tools: CFG.tools,
        // allowedTools 留空：列进 allowedTools 的工具会被直接批准、不进 canUseTool
        // （实测 WebSearch 就是这样绕过角色策略的），所有工具都必须过代码判定
        allowedTools: [],
        disallowedTools: CFG.hardDenied,
        canUseTool: (n, i, o) => this.#canUseTool(n, i, o),
        // WP2：Grep/Glob 实测**不走 canUseTool**（同 WebSearch 的绕过行为），所以围栏挂在 hooks 上：
        // PreToolUse 在执行前判角色/覆写 path（updatedInput），PostToolUse 在回灌前滤结果（updatedToolOutput）
        // 兜底（审核 F-01/F-02）：文件工具与 WebFetch 原本只有 canUseTool 一层且其实弹台账从未取得，
        // 这里再挂同一套判定——两层里任何一层失效，另一层仍拦。
        hooks: {
          PreToolUse: [
            { matcher: "Grep|Glob", hooks: [async (input) => judgeSearchInput(this, input)] },
            { matcher: "ImageGen", hooks: [async (input) => judgeImageGen(this, input)] },
            { matcher: "ImageSearch", hooks: [async (input) => judgeImageSearch(this, input)] },
            { matcher: "Read|Write|Edit|MultiEdit", hooks: [async (input) => judgeFileTool(this, input)] },
            { matcher: "WebFetch", hooks: [async (input) => judgeWebFetch(this, input)] },
            { matcher: "SearchHistory|RecallMemory|mcp__xqhistory__SearchHistory|mcp__xqhistory__RecallMemory", hooks: [async (input) => {
              // fail-closed（审查 S1）：判定本身抛错也当拒绝，绝不让异常变成放行
              try { return judgeHistory(this, input); }
              catch (e) {
                return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `判定异常，按拒绝处理：${String(e?.message ?? e).slice(0, 60)}` } };
              }
            }] },
            { matcher: "ScheduleTask|ListScheduledTasks|CancelScheduledTask|mcp__xqschedule__ScheduleTask|mcp__xqschedule__ListScheduledTasks|mcp__xqschedule__CancelScheduledTask", hooks: [async (input) => {
              // 与 SearchHistory 同样的 fail-closed：判定抛错也当拒绝
              try { return judgeScheduleTools(this, input); }
              catch (e) {
                return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `判定异常，按拒绝处理：${String(e?.message ?? e).slice(0, 60)}` } };
              }
            }] },
          ],
          PostToolUse: [{ matcher: "Grep|Glob", hooks: [async (input) => filterSearchResultImpl(this, input)] }],
        },
        permissionMode: "default",
        skills: [],
        mcpServers,
        strictMcpConfig: true,
        settingSources: [],
        plugins: [],
        persistSession: true,
        ...(this.resumed ? { resume: stored.sessionId } : {}),
        ...(memory ? { memory } : {}),
        maxTurns: CFG.maxTurnsPerMessage,
        extraArgs: { "reasoning-effort": CFG.reasoningEffort, ...(CFG.contextWindow ? { "context-window": String(CFG.contextWindow) } : {}) },
      },
    });
    this.loop = this.#run();
  }

  async #canUseTool(name, input, o) {
    // 优先按 toolUseID 认领这一轮是谁（assistant 的 tool_use 块先于回调出现时才能命中），
    // 命中不了才退回队首，并在台账里写清楚用的哪种，别让归因看起来比实际可靠
    const byId = o?.toolUseID ? this.ctxByTool.get(String(o.toolUseID)) : null;
    const ctx = byId ?? this.pending[0]?.ctx ?? { role: "guest" };
    const via = byId ? "toolUseID" : this.pending[0]?.ctx ? "队首" : "无在途";
    // WP2：Grep/Glob 的搜索根由代码写死为本群记事本目录，模型传的 path 一律覆写；
    // pattern 里出现 ../ 或绝对路径直接拒（搜索词不是给你指路用的）
    let work = input;
    if (name === "Grep" || name === "Glob") {
      const pat = String(work?.pattern ?? "");
      if (/(?:^|[\\/])\.\.(?:[\\/]|$)|^[a-zA-Z]:[\\/]/.test(pat)) {
        this.toolLog.push({ stage: "判定", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: false, reason: "pattern 里带了路径" });
        return { behavior: "deny", message: "搜索词里不许带路径", toolUseID: o?.toolUseID };
      }
      work = { ...(work ?? {}), path: this.memRoot };
    }
    const v = await checkToolCallCached(this, name, work, o?.toolUseID, ctx.role);
    const rec = { stage: "判定", name, role: ctx.role, user: ctx.userId ?? "?", via, ok: v.behavior === "allow", reason: v.message ?? "" };
    this.toolLog.push(rec);
    if (this.toolLog.length > 40) this.toolLog.shift();
    if (v.behavior === "deny") return { behavior: "deny", message: v.message, toolUseID: o?.toolUseID };
    // 把校验过的绝对路径回填，避免模型拿相对/带 .. 的路径再解析一次
    const next = v.resolvedPath && work
      ? (name === "Grep" || name === "Glob" ? { ...work, path: v.resolvedPath } : { ...work, file_path: v.resolvedPath })
      : work;
    return { behavior: "allow", updatedInput: next, toolUseID: o?.toolUseID };
  }

  async flushMemory() {
    if (this.dead) return false;
    try {
      const q = this.q.flushMemory?.();
      if (!q) return false;
      // 2026-10-29：5s→20s。国际版网络 RTT 更高，5s 常触发 `[记事本 flush 失败] 超时`；
      // 收尾已后置（WP1），放宽不影响回复主路径，只提高记忆落盘成功率。
      await withTimeout(q, 20_000, "记事本 flush");
      return true;
    } catch (e) {
      console.log(`[记事本 flush 失败] ${e.message ?? e}`);
      return false;
    }
  }

  // 只停当前这一轮，不关会话；取消后这一轮自己的 result 会回来把队首清掉
  async interrupt() {
    if (this.dead) return false;
    if (typeof this.q.interrupt !== "function") { console.log(`[中断不可用] ${this.key}`); return false; }
    try {
      await withTimeout(Promise.resolve(this.q.interrupt()), 8000, "中断");
      return true;
    } catch (e) {
      console.log(`[中断失败] ${e.message ?? e}`);
      return false;
    }
  }

  async #run() {
    let lastAssistantText = "";
    try {
      for await (const m of this.q) {
        if (m.type === "system" && m.subtype === "init" && m.session_id) {
          this.sessionId = m.session_id;
          writeSessionId(this.dir, m.session_id, this.turns);
        }
        if (m.type === "assistant") {
          const who = this.pending[0]?.ctx ?? { role: "guest" };
          // 限额/服务端拒绝的提示藏在 assistant 文本里（result 常为空），带出去给 doAsk 识别
          const t = (m.message?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
          if (t) lastAssistantText = t;
          for (const b of m.message?.content || []) {
            if (b.type !== "tool_use") continue;
            this.toolLog.push({ stage: "发起", name: b.name, role: who.role, user: who.userId ?? "?", input: JSON.stringify(b.input ?? {}).slice(0, 90) });
            if (b.name === "WebFetch" && b.input?.url && who) {
              who.webFetchUrls = who.webFetchUrls ?? [];
              if (!who.webFetchUrls.includes(String(b.input.url))) who.webFetchUrls.push(String(b.input.url));
            }
            if (b.id) {
              this.ctxByTool.set(String(b.id), who);
              if (this.ctxByTool.size > 60) this.ctxByTool.delete(this.ctxByTool.keys().next().value);
              this.toolNameById.set(String(b.id), b.name);
              if (this.toolNameById.size > 60) this.toolNameById.delete(this.toolNameById.keys().next().value);
            }
            // 事后审计：角色策略不允许的工具若真的出现了，记一行「漏判(未拦)」。
            // （历史注：WebSearch 曾因被列进 allowedTools 而绕过 canUseTool；allowedTools 清空后
            //  实弹台账证实它已进判定行。）
            if (!toolAllowed(who.role, b.name)) this.toolLog.push({ stage: "漏判(未拦)", name: b.name, role: who.role, user: who.userId ?? "?" });
          }
          if (this.toolLog.length > 40) this.toolLog.splice(0, this.toolLog.length - 40);
          continue;
        }
        if (m.type === "user") {
          // 工具的 user 回包：ImageGen 的结构化路径在 tool_use_result.filePath（实弹探针确认），
          // 同时 tool_result 文本里也有 "Saved to: ..."；只认结构化字段，避免把别的工具路径当图。
          const blocks = Array.isArray(m.message?.content) ? m.message.content : [];
          const tr = blocks.find((b) => b?.type === "tool_result");
          const toolName = tr ? this.toolNameById.get(String(tr.tool_use_id)) : null;
          const trObj = m.tool_use_result && typeof m.tool_use_result === "object" ? m.tool_use_result : null;
          const filePath = trObj && typeof trObj.filePath === "string" ? trObj.filePath : "";
          const likelyImage = filePath && /[\\/]vibe_images[\\/]/i.test(filePath);
          if ((toolName === "ImageGen" || (!toolName && likelyImage)) && filePath) {
            const ctx = (tr ? this.ctxByTool.get(String(tr.tool_use_id)) : null) ?? this.pending[0]?.ctx;
            if (ctx) {
              ctx.images = ctx.images ?? [];
              if (ctx.images.length < CFG.imageGenMaxPerTurn && !ctx.images.includes(filePath)) ctx.images.push(filePath);
              this.toolLog.push({ stage: "结果", name: "ImageGen", role: ctx.role, user: ctx.userId ?? "?", ok: true, file: filePath.split(/[\\/]/).pop() });
              if (this.toolLog.length > 40) this.toolLog.shift();
            }
          }
          const results = trObj && Array.isArray(trObj.results) ? trObj.results : null;
          const likelySearch = results && results.some((r) => r && typeof r.imageUrl === "string");
          if ((toolName === "ImageSearch" || (!toolName && likelySearch)) && likelySearch) {
            const ctx = (tr ? this.ctxByTool.get(String(tr.tool_use_id)) : null) ?? this.pending[0]?.ctx;
            if (ctx) {
              ctx.searchImages = ctx.searchImages ?? [];
              for (const r of results.slice(0, 5)) {
                if (!r) continue;
                const url = typeof r.imageUrl === "string" ? r.imageUrl : (typeof r.thumbnailUrl === "string" ? r.thumbnailUrl : "");
                if (!url || ctx.searchImages.some((x) => x.url === url)) continue;
                ctx.searchImages.push({ url, title: String(r.title ?? ""), host: String(r.hostname ?? ""), width: Number(r.width ?? 0), height: Number(r.height ?? 0) });
              }
              this.toolLog.push({ stage: "结果", name: "ImageSearch", role: ctx.role, user: ctx.userId ?? "?", ok: true, count: ctx.searchImages.length });
              if (this.toolLog.length > 40) this.toolLog.shift();
              // WP4：结果一到就预取候选，藏在模型首段回复期间；pickByVision 复用同一个 Promise
              if (CFG.searchPrefetch && ctx.searchImages.length > 1 && !ctx.searchCandidatesPromise) {
                ctx.searchCandidatesPromise = fetchSearchCandidates(ctx.searchImages, { chatKey: ctx.chatKey }).catch(() => []);
              }
            }
          }
          continue;
        }
        if (m.type !== "result") continue;
        m.assistantText = lastAssistantText;   // 限额提示识别用（见 runTurn 开头的 isQuotaMessage）
        // #run 是长驻循环，lastAssistantText 不清空就会跨轮累积：某轮说过限额文案后，
        // 之后的无文本帧（纯工具轮/沉默轮）都会带着旧文案去判限额 → 每条都误判 + 反复试切轨
        lastAssistantText = "";
        this.lastUsed = Date.now();
        this.turns++;
        this.ctxByTool.clear();   // 每轮结束就清空：跨轮留着会把上一轮的工具认给下一轮的人
        this.toolNameById.clear();
        this.decisions?.clear();
        if (this.sessionId) writeSessionId(this.dir, this.sessionId, this.turns);
        const d = this.pending.shift();
        if (d) {
          d.markShifted?.();
          if (d.ctx?.images?.length) m.images = d.ctx.images.slice();
          if (d.ctx?.searchImages?.length) m.searchImages = d.ctx.searchImages.slice();
          if (d.ctx?.draw) m.draw = d.ctx.draw;
          d.resolve(m);
        }
      }
      this.fail = this.fail ?? new Error("会话输入流已结束");
    } catch (e) {
      this.fail = e;
    } finally {
      this.dead = true;
      for (const d of this.pending.splice(0)) { d.markShifted?.(); d.reject(this.fail); }
    }
  }

  ask(content, ctx = { role: "guest" }) {
    if (this.dead) return Promise.reject(this.fail ?? new Error("会话已关闭"));
    const entry = { ctx };
    entry.shifted = new Promise((resolve) => { entry.markShifted = resolve; });
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    this.pending.push(entry);
    this.src.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
    return entry;
  }

  async close() {
    this.dead = true;
    this.src.close();
    try { await this.q.close?.(); } catch {}
  }
}

const sessions = new Map();
// 同群同时只跑一个 turn；排队超过 QUEUE_MAX 条或等超过 QUEUE_STALE_MS 的消息直接丢弃
const chatQueue = createChatQueue({ maxWaiting: CFG.chatQueueMax, staleMs: CFG.chatQueueStaleMs });

function queueRotationSummary(chatKey, dir) {
  if (!CFG.memoryEnabled || !CFG.rotationSummary) return;
  const t0 = Date.now();
  summarizeGroup(dir, { maxChunks: CFG.rotationSummaryMaxChunks, maxCharsPerChunk: CFG.rotationSummaryMaxChars })
    .then((r) => {
      const ms = Date.now() - t0;
      if (r.skipped) {
        console.log(`[会话摘要] ${chatKey} 跳过：${r.skipped}`);
        recordTurn(chatKey, { phase: "rotation-summary", skipped: r.skipped, summaryMs: ms });
        return;
      }
      console.log(`[会话摘要] ${chatKey} ${r.ok ? "完成" : "失败"}：新增 ${r.added ?? 0} 条，本子 ${r.kept ?? 0} 条${r.truncated ? "（还有未处理转录，下次继续）" : ""}${r.error ? `，${redactError(r.error)}` : ""}`);
      recordTurn(chatKey, {
        phase: "rotation-summary", ok: Boolean(r.ok), added: r.added ?? 0, kept: r.kept ?? 0,
        chunks: r.chunks ?? 0, truncated: Boolean(r.truncated), summaryMs: ms,
        ...(r.error ? { error: redactError(r.error) } : {}),
      });
    })
    .catch((e) => {
      const msg = redactError(e?.message ?? e);
      console.log(`[会话摘要] ${chatKey} 失败：${msg}`);
      recordTurn(chatKey, { phase: "rotation-summary", ok: false, error: msg, summaryMs: Date.now() - t0 });
    });
}

function get(key) {
  let s = sessions.get(key);
  // stale：切轨后标记待重建（旧轨 session 对新轨无效）；空闲回收：dead/轮数满/超时同理重建
  if (s && !s.dead && !s.stale && s.turns < CFG.rotateAfterTurns) return s;
  if (s) {
    const shouldSummarize = !s.dead && s.turns >= CFG.rotateAfterTurns;
    sessions.delete(key);
    if (shouldSummarize) {
      writeSessionId(s.dir, "", 0);   // 先清指针，避免新构造器把同一次轮换再摘要一遍
      queueRotationSummary(key, s.dir);
    }
    s.close().catch(() => {});
  }
  if (sessions.size >= CFG.maxLiveSessions) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (oldest) { sessions.delete(oldest[0]); oldest[1].close().catch(() => {}); }
  }
  s = new BrainSession(key);
  sessions.set(key, s);
  return s;
}

export function resetChat(key, { wipeNotes = false } = {}) {
  const dir = groupDir(key);
  const queued = chatQueue.reset(key);
  if (queued) console.log(`[重置] ${key} 丢掉 ${queued} 条排队消息`);
  const old = sessions.get(key);
  const finish = () => {
    writeSessionId(dir, "", 0);
    if (old && sessions.get(key) === old) { sessions.delete(key); old.close().catch(() => {}); }
    if (wipeNotes) {
      const root = join(dir, CFG.memoryDir);
      let n = 0;
      try { if (existsSync(root)) for (const f of readdirSync(root)) { rmSync(join(root, f), { recursive: true, force: true }); n++; } }
      catch (e) { console.log(`[清空失败] ${e.message ?? e}`); }
      appendTranscript(dir, { ts: Date.now(), chatKey: key, system: `记事本已按指令清空（含 ${n} 个主题文件）` });
    }
  };
  // 有 post-turn 在跑时先等它落完再关会话/清本子；无 pending 时保持同步语义
  if (postTurn.has(key)) postTurn.drain(key).finally(finish);
  else finish();
  return dir;
}

export function notesFile(key) { return join(groupDir(key), CFG.memoryDir, MEMORY_FILE); }
export function readNotes(key) { try { return readFileSync(notesFile(key), "utf8"); } catch { return ""; } }
export function memoryLog(key) { const s = sessions.get(key); return s ? s.memLog : null; }
export function toolLogOf(key) { const s = sessions.get(key); return s ? s.toolLog : null; }
export async function flushAll() {
  await postTurn.drainAll();
  for (const s of sessions.values()) await s.flushMemory();
}

setInterval(async () => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (postTurn.has(key)) continue;
    if (now - s.lastUsed > CFG.sessionIdleCloseMs || s.dead) {
      const inflight = s.pending.length;
      sessions.delete(key);
      if (inflight) console.log(`[空闲回收] ${key} 还有 ${inflight} 条在途，仍关闭`);
      s.close().catch(() => {});
    }
  }
}, 60_000).unref?.();

class TimeoutError extends Error {
  constructor(label) { super(`超时 ${label}`); this.timedOut = true; }
}

async function withTimeout(promise, ms, label) {
  let t;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new TimeoutError(label)), ms); })]);
  } finally { clearTimeout(t); }
}

async function settle(session, entry) {
  try {
    return await withTimeout(entry.promise, CFG.requestTimeoutMs, "回答");
  } catch (e) {
    if (e.timedOut) e.entry = entry;
    throw e;
  }
}

// 超时后先取消当前回合，再等它真正从队首移走；取消不了或迟迟不落地才换会话
export async function cancelTurn(session, entry, ms = 8000) {
  if (!session || !entry) return false;
  if (!(await session.interrupt())) return false;
  if (!entry.shifted) return true;
  try { await withTimeout(entry.shifted, ms, "中断落账"); return true; }
  catch (e) { console.log(`[中断落账失败] ${e.message ?? e}`); return false; }
}

async function freshSession(chatKey, userId) {
  await postTurn.drain(chatKey);
  const old = sessions.get(chatKey);
  if (old) {
    sessions.delete(chatKey);
    writeSessionId(old.dir, "", 0);
    await old.close().catch(() => {});
    writeSessionId(old.dir, "", 0);   // close 期间可能又落了一次旧 id
  }
  const s = get(chatKey);
  if (userId) { recordSpeaker(s.dir, userId); s.lastSpeaker = userId; }
  return s;
}

async function dropSession(chatKey, session) {
  await postTurn.drain(chatKey).catch(() => {});
  writeSessionId(session.dir, "", 0);
  await session.close().catch(() => {});
  sessions.delete(chatKey);
}

async function finalize(session, chatKey, uid, { flush = true } = {}) {
  if (CFG.memoryEnabled) {
    if (flush) await session.flushMemory();
    if (uid) stampUnknownUid(session.dir, uid);
    const prov = enforceProvenance(session.dir);
    if (prov.rewritten) console.log(`[记事本来源核验] ${chatKey} 改了 ${prov.rewritten} 条（号没在本群说过话或自封已批准）`);
    const scrub = scrubNotes(session.dir);
    if (scrub.dropped) console.log(`[记事本清洗] ${chatKey} 丢掉 ${scrub.dropped} 条不合规模块`);
  }
}

// WP1：成功/跳过路径的 finalize 后置；同一群串行，下一轮开头 drain。
const postTurn = createSerialFinalizer({
  finalize: (job) => finalize(job.session, job.chatKey, job.uid, { flush: job.flush !== false }),
  onError: (e, job) => console.log(`[${job.chatKey}] post-turn finalize 失败：${String(e?.message ?? e).slice(0, 120)}`),
});
function scheduleFinalize(session, chatKey, uid, turnId, { flush = true } = {}) {
  if (!CFG.flushAfterSend) return finalize(session, chatKey, uid, { flush });
  const p = postTurn.schedule(chatKey, { session, chatKey, uid, turnId, flush });
  p.then((r) => recordTurn(chatKey, {
    turnId, phase: "finalize", finalizeMs: r.ms, finalizeOk: r.ok,
    ...(r.error ? { finalizeError: redactError(r.error) } : {}),
  }));
  return p;
}

let turnSeq = 0;
function nextTurnId(chatKey) {
  return `${chatKey}:${Date.now().toString(36)}:${++turnSeq}`;
}
function toolSummary(logs) {
  return logs.slice(-20).map((x) => ({ stage: x.stage, name: x.name, ok: x.ok, via: x.via })).filter((x) => x.name);
}
function redactError(v) {
  return String(v ?? "")
    .replace(/https?:\/\/\S+/gi, "<url>")
    .replace(/[A-Za-z]:[\\/][^\s"'）)，。；;]*/g, "<path>")
    .slice(0, 120);
}

// 定时任务执行时按“创建时角色”封顶：成员建的旧任务即使创建者后来被提升为 owner，
// 也不会在到点时拿到 owner-only 工具（取当前角色与创建角色里较低的那个）。
const ROLE_RANK = { blocked: 0, guest: 0, member: 1, admin: 2, owner: 3 };
function capRole(current, cap) {
  if (!cap || ROLE_RANK[cap] == null) return current;
  const a = ROLE_RANK[current] ?? 0, b = ROLE_RANK[cap] ?? 0;
  return a <= b ? current : cap;
}

export function ask({ chatKey, text, images = [], runtime = {}, actor = {}, priority = false }) {
  const userId = String(actor.userId ?? runtime?.speaker?.id ?? "");
  const role = capRole(roleOf({ userId, groupId: chatKey.startsWith("g:") ? chatKey.slice(2) : "", platformRole: actor.platformRole }), actor.roleCap);
  const turnId = nextTurnId(chatKey);
  if (!canDo(role, "chat")) {
    recordTurn(chatKey, { turnId, phase: "refused", refused: "chat", role, queueWaitMs: 0 });
    return Promise.resolve({ text: "", refused: "chat", role, chatKey, turnId });
  }
  // 只按条数限流：用的免费档模型，账号配额与她能不能说话无关（见 config.mjs 的说明）
  const rate = rateCheck(userId);
  if (!rate.ok) {
    recordTurn(chatKey, { turnId, phase: "refused", refused: "rate", role, queueWaitMs: 0 });
    return Promise.resolve({ text: CFG.rateLimitedLine, refused: "rate", role, chatKey, turnId });
  }

  // 同一个群一次只跑一个 turn；排队/过期由 chatQueue 处理（QUEUE_STALE_MS 默认 60s，从**入队**起算：
  // 前一个 turn 跑超过 60s 时，排队中的消息到期就会被丢，见 chat-queue.mjs 的 enqueuedAt 判定）
  return chatQueue.enqueue(
    chatKey,
    () => doAsk({ chatKey, text, images, runtime, actor, userId, role, turnId }),
    { chatKey, role, userId, turnId, priority },
  ).then((res) => {
    if (res?.dropped) {
      recordTurn(chatKey, {
        turnId, phase: "drop", dropped: res.dropped, role,
        queueWaitMs: res.queueWaitMs, silent: false, scheduled: Boolean(runtime?.scheduled),
      });
    } else if (res?.turn) {
      recordTurn(chatKey, {
        ...res.turn,
        turnId,
        role,
        queueWaitMs: res.queueWaitMs ?? 0,
        totalMs: res.turn.modelMs + (res.queueWaitMs ?? 0),
        scheduled: Boolean(runtime?.scheduled),
      });
    }
    return res;
  });
}

async function doAsk({ chatKey, text, images = [], runtime = {}, actor = {}, userId, role, turnId }) {
  const t0 = Date.now();
  // BYOK 备用模型不一定有视觉能力：未声明 BYOK_VL=1 时不要把 base64 图硬塞给第三方端。
  if (sdkEdition() === "byok" && !CFG.byokIsVl && images.length) {
    console.log(`[BYOK] 模型未声明视觉，本轮丢弃 ${images.length} 张输入图`);
    images = [];
  }
  // 先等上一轮 finalize 落完，再 get/recordSpeaker/noteExcerpt；保证记忆可见性与 provenance 顺序。
  await postTurn.drain(chatKey);
  let session = get(chatKey);
  const toolStart = session.toolLog.length;
  if (userId) { recordSpeaker(session.dir, userId); session.lastSpeaker = userId; }
  const ctx = { role, userId, chatKey, name: actor.name ?? runtime?.speaker?.name ?? "", images: [], searchImages: [], webFetchUrls: [], imageCalls: 0, scheduled: Boolean(runtime?.scheduled) };
  const note = CFG.memoryEnabled ? noteExcerpt(session.dir) : "";
  const content = [{
    type: "text",
    text: layers.renderRuntime({
      ...runtime,
      // 身份只由上面的 roleOf 计算，不从消息文本取；画图等 owner-only 本事的提示层靠它
      identity: role === "owner" ? "主人" : "",
      speaker: { ...(runtime.speaker ?? {}), id: userId },
      memory: note ? [note] : runtime.memory,
      text,
    }),
  }];
  let imgBytes = 0, imgCount = 0, quoteLabeled = false, forwardLabeled = false;
  for (const img of images) {
    if (imgCount >= CFG.maxImagesPerMessage) break;   // 一条消息塞几十张图会把上下文顶爆
    if (!img?.data || !CFG.imageMediaTypes.includes(img?.mediaType)) continue;
    imgBytes += Math.ceil(img.data.length * 3 / 4);
    if (imgBytes > CFG.imageTotalBytes) break;
    // 当前消息的图排在前面；引用/转发的图接在后面，先给模型一句来源说明
    if (img.origin === "quote" && !quoteLabeled) {
      content.push({ type: "text", text: "（下面的图来自被引用的消息）" });
      quoteLabeled = true;
    }
    if (img.origin === "forward" && !forwardLabeled) {
      content.push({ type: "text", text: "（下面的图来自被转发的消息）" });
      forwardLabeled = true;
    }
    content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.data } });
    imgCount++;
  }

  const runTurn = async (s) => {
    const sanOpt = { ...SAN_OPT, secretFragments: CFG.memoryEnabled ? allEntries(s.dir).map((e) => e.body) : [] };
    const replyText = (m) => {
      if (m?.searchImages?.length) return cleanSearchReply(m.result, m.searchImages);
      return m?.images?.length ? stripImagePaths(m.result) : m.result;
    };
    let m0 = await settle(s, s.ask(content, ctx));
    // 日限额/配额拒绝：先尝试双轨 failover（8h CD），然后静默——不重试不回兜底句
    if (isQuotaMessage(quotaTextOf(m0))) {
      await tryFailover();
      return { msg: m0, san: { text: "", outChars: 0 }, silent: true, quota: true, retried: false };
    }
    const firstText = String(m0.result ?? "");
    const wantsWeb = SEE_WEB.test(firstText)
      || /截图|截个图|页面整体|版面|长什么样|没翻着|翻不着|打不开|看不了|没读到|不配合|页面空/i.test(firstText)
      || /截图|页面整体|版面|长什么样/i.test(text);
    if (wantsWeb) {
      m0.result = firstText.replace(SEE_WEB, " ").trim();
      if (ctx.webFetchUrls?.length) {
        let shot = null;
        try { shot = await screenshotWebPage(ctx.webFetchUrls[ctx.webFetchUrls.length - 1], { chatKey }); }
        catch (e) { console.log(`[网页视觉] 截图失败：${e.message}`); }
        if (shot) {
          try {
            const vm = await settle(s, s.ask([
              { type: "text", text: "（系统：这是刚才网页的截图；如果图对回答有帮助就参考，不需要就按原回答简短重说。不要提截图/工具/系统。）" },
              { type: "image", source: { type: "base64", media_type: shot.mediaType, data: shot.data } },
            ], ctx));
            // 二次调用同样可能撞限额：识别后整轮静默，别让它空 result 覆盖成 broken（2026-10-31）
            if (isQuotaMessage(quotaTextOf(vm))) {
              await tryFailover();
              return { msg: vm, san: { text: "", outChars: 0 }, silent: true, quota: true, retried: false };
            }
            m0.result = vm.result;
            m0.webVision = true;
            s.toolLog.push({ stage: "网页视觉", name: "WebFetch", role: ctx.role, user: ctx.userId ?? "?", ok: true });
            if (s.toolLog.length > 40) s.toolLog.shift();
          } catch (e) {
            if (e.timedOut && e.entry) await cancelTurn(s, e.entry);
            console.log(`[网页视觉] 失败：${e.message ?? e}`);
          }
        }
      }
    }
    if (m0.searchImages?.length > 1) {
      const vision = await pickByVision(s, m0, ctx);
      if (vision) {
        m0.result = vision.result;
        m0.searchImages = vision.searchImages;
        m0.searchPick = vision.searchPick;
      } else {
        m0 = applySearchPick(m0);
      }
    } else {
      m0 = applySearchPick(m0);
    }
    if (isSilence(m0.result) && !hasMedia(m0)) return { msg: m0, san: { text: "", outChars: 0 }, silent: true, retried: false };
    let msg = m0, san = sanitize(replyText(m0), sanOpt), retried = false;
    if (m0.draw) san = { ...san, text: "好，我画一下，画好了发你。" };
    if (!hasMedia(m0) && (isEmptyResult(m0) || isBroken(san, { inputText: text }))) {
      retried = true;
      const retryMsg = await settle(s, s.ask([{ type: "text", text: "（上一条没发出去。重说一次，只发要发到群里的那句话，别解释）" }], ctx));
      // 重试也可能正好撞上限额：认出来就静默，不再往下走成 broken 兜底（2026-10-31）
      if (isQuotaMessage(quotaTextOf(retryMsg))) {
        await tryFailover();
        return { msg: retryMsg, san: { text: "", outChars: 0 }, silent: true, quota: true, retried };
      }
      msg = applySearchPick(retryMsg);
      if (isSilence(msg.result) && !hasMedia(msg)) return { msg, san: { text: "", outChars: 0 }, silent: true, retried };
      san = sanitize(replyText(msg), sanOpt);
    }
    return { msg, san, silent: false, retried };
  };

  let msg, san, retried = false, silent = false, quota = false;
  const turnInfo = (extra = {}) => ({
    phase: "model", modelMs: Date.now() - t0, retried,
    toolCalls: toolSummary(session.toolLog.slice(toolStart)),
    inputImages: images.length,
    quotedImages: images.filter((x) => x?.origin === "quote").length,
    forwardImages: images.filter((x) => x?.origin === "forward").length,
    ...extra,
  });
  const fallback = async (err) => {
    // 限额/配额类错误（SDK 直接 reject 的形态）：先尝试 failover，再静默，不发兜底句
    // 文案可能只在 message / stderr / errors 任一处，全部拼起来判（2026-10-31 补）
    const errText = [err?.message, err?.stderr, Array.isArray(err?.errors) ? err.errors.join(" ") : err?.errors].filter(Boolean).join(" ");
    if (isQuotaMessage(errText)) {
      await tryFailover();
      return {
        text: "", silent: true, quota: true, chatKey, role, ms: Date.now() - t0, turnId,
        turn: turnInfo({ phase: "fallback", silent: true, quotaError: true, timeout: Boolean(err?.timedOut) }),
      };
    }
    // 2026-11-04：去掉兜底文案。超时/后端异常时直接静默，不再发"走神了/没接住"，
    // 避免连续超时把同一句话刷成复读；排障看 turns.jsonl 的 fallback 记录和 [没回] 日志。
    return {
      text: "", error: String(err?.message ?? err),
      chatKey, role, ms: Date.now() - t0, trace: session.toolLog.slice(-4), turnId,
      turn: turnInfo({ phase: "fallback", fallbackReason: redactError(err?.message ?? err), retried: true, timeout: Boolean(err?.timedOut) }),
    };
  };

  try {
    ({ msg, san, retried, silent, quota } = await runTurn(session));
  } catch (e) {
    if (!e.timedOut) {
      const em = String(e?.message ?? e);
      // 带 resume 起来的会话只要出过错就清指针：实测坏 id 会让 worker 直接 code 42 退出
      if (session.resumed || /resume|session|not found|worker runtime exited|transport closed/i.test(em)) writeSessionId(session.dir, "", 0);
      await finalize(session, chatKey, userId, { flush: false }).catch(() => {});
      try {
        session = await freshSession(chatKey, userId);
        ({ msg, san, retried, silent, quota } = await runTurn(session));
        retried = true;
      } catch (e2) {
        if (e2.timedOut && e2.entry) await cancelTurn(session, e2.entry);
        await finalize(session, chatKey, userId, { flush: false }).catch(() => {});
        await dropSession(chatKey, session);
        return await fallback(e2);
      }
    } else {
      // 超时先取消当前回合，不直接回兜底；取消成功就原地重试同一条
      const cancelled = await cancelTurn(session, e.entry);
      await finalize(session, chatKey, userId, { flush: false }).catch(() => {});
      if (!cancelled) {
        // 中断不落地才换新会话；同群串行，不会像以前那样并发炸出多个会话
        try {
          session = await freshSession(chatKey, userId);
          ({ msg, san, retried, silent, quota } = await runTurn(session));
          retried = true;
        } catch (e2) {
          if (e2.timedOut && e2.entry) await cancelTurn(session, e2.entry);
          await finalize(session, chatKey, userId, { flush: false }).catch(() => {});
          await dropSession(chatKey, session);
          return await fallback(e2);
        }
      } else {
        console.log(`[${chatKey}] 回答超时，已中断并重试（${Math.round((Date.now() - t0) / 1000)}s）`);
        try {
          ({ msg, san, retried, silent, quota } = await runTurn(session));
          retried = true;
        } catch (e2) {
          if (e2.timedOut && e2.entry) {
            const ok2 = await cancelTurn(session, e2.entry);
            if (!ok2) await dropSession(chatKey, session);
          } else {
            await dropSession(chatKey, session);
          }
          await finalize(session, chatKey, userId, { flush: false }).catch(() => {});
          return await fallback(e2);
        }
      }
    }
  }

  // 她判断这句不值得接：不发、不转录，也不要当成"坏输出"去关会话
  if (silent && !hasMedia(msg)) {
    scheduleFinalize(session, chatKey, userId, turnId);
    return { text: "", silent: true, quota: Boolean(quota), chatKey, role, ms: Date.now() - t0, turnId, turn: turnInfo({ silent: true, quotaError: Boolean(quota) }) };
  }

  // 有图时即使文字为空也放行：图由适配层单独发，文字只当配文
  if (!hasMedia(msg) && isBroken(san, { inputText: text })) {
    const trace = session.toolLog.slice(-4);
    await finalize(session, chatKey, userId);
    await session.close();
    sessions.delete(chatKey);
    // 2026-11-04：空输出也不再发兜底话，直接静默；关会话让下一条走新会话
    return { text: "", broken: true, error: "空输出", chatKey, role, ms: Date.now() - t0, raw: String(msg.result ?? "").slice(0, 160), trace, turnId, turn: turnInfo({ phase: "broken" }) };
  }

  // 定时任务轮不写转录（2026-11-03）：它不是群友原话，写进去会被 SearchHistory 当成历史发言
  if (!runtime?.scheduled) appendTranscript(session.dir, {
    ts: Date.now(), chatKey, uid: userId, user: runtime?.speaker?.name ?? "", text,
    reply: san.text, tools: msg.tools || "", retried,
    images: (msg.images ?? []).length,
    searchImages: (msg.searchImages ?? []).length,
    searchPick: msg.searchPick ?? null,
    webVision: Boolean(msg.webVision),
    draw: Boolean(msg.draw),
  });
  scheduleFinalize(session, chatKey, userId, turnId);
  return {
    text: san.text,
    images: msg.images ?? [],
    searchImages: msg.searchImages ?? [],
    searchPick: msg.searchPick ?? null,
    webVision: Boolean(msg.webVision),
    draw: msg.draw ?? null,
    chatKey,
    role,
    ms: Date.now() - t0,
    turns: session.turns,
    resumed: session.resumed,
    tools: msg.tools,
    trace: session.toolLog.slice(-4),
    retried,
    leakScrubbed: san.hadLeak,
    truncated: san.truncated,
    turnId,
    turn: turnInfo({ webVision: Boolean(msg.webVision), draw: Boolean(msg.draw), searchCandidates: (msg.searchImages ?? []).length, replyChars: [...(san.text ?? "")].length }),
  };
}

// 异步 ImageGen：主会话的 PreToolUse 只抓提示词，这里用独立 SDK 会话真正生成。
// 不占 chatQueue/主会话；返回本地图片路径，由 adapter 复制到图片输出目录（IMAGE_OUT_DIR）再发送。
export async function generateImage(prompt, { chatKey = "p:async-draw" } = {}) {
  // 2026-11-03：生图固定走 cn 轨。global 免费档对 ImageGen 返回 HTTP 403 / code 112（无生图额度，
  // 实弹探针抓到 pricingUrl），cn 轨实测能出图；文本对话仍按 rt 当前轨走。cn 凭据缺失时回退当前轨。
  let drawRt = rt;
  try {
    if (editionAvailable("cn")) drawRt = await loadSdk("cn");
  } catch (e) {
    console.log(`[画图] cn 轨不可用，回退 ${sdkEdition()}：${String(e?.message ?? e).slice(0, 120)}`);
  }
  const q = drawRt.query({
    prompt: `请用 ImageGen 生成：${prompt}`,
    options: {
      auth: drawRt.auth(),
      cwd: groupDir(chatKey),
      model: CFG.model,
      systemPrompt: "你是绘图执行器。用户给你画图要求，调用 ImageGen 生成一张图片，不要解释。",
      tools: ["ImageGen"],
      allowedTools: ["ImageGen"],
      canUseTool: async () => ({ behavior: "allow" }),
      permissionMode: "default",
      skills: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      plugins: [],
      persistSession: false,
      maxTurns: 2,
      extraArgs: { "reasoning-effort": CFG.reasoningEffort, ...(CFG.contextWindow ? { "context-window": String(CFG.contextWindow) } : {}) },
    },
  });
  let path = "";
  const timer = setTimeout(() => { try { q.interrupt?.(); } catch {} }, 120_000);
  try {
    for await (const m of q) {
      if (m.type === "user" && m.tool_use_result && typeof m.tool_use_result.filePath === "string") {
        path = m.tool_use_result.filePath;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    try { await q.close?.(); } catch {}
  }
  if (!path) throw new Error("ImageGen 没有返回图片");
  return path;
}

export function sessionStats() {
  return {
    live: sessions.size,
    edition: sdkEdition(),
    promptChars: [...SYSTEM_PROMPT].length,
    tools: CFG.tools,
    hardDenied: CFG.hardDenied.length,
    model: CFG.model,
    groupsDir: GROUPS_DIR,
    rotateAfterTurns: CFG.rotateAfterTurns,
    memoryGeneration: CFG.memoryEnabled ? "on" : "off",
    rotationSummary: CFG.memoryEnabled && CFG.rotationSummary ? "on" : "off",
    queue: chatQueue.stats(),
  };
}
