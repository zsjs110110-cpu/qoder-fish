// Qoder SDK 运行时管理：cn/global 双轨 + BYOK 第三轨。
// QODER_EDITION 选初始轨（cn/global/byok）；Qoder 账号限额耗尽时优先换另一条 Qoder 轨，
// 两条都不可用时才尝试 BYOK（第三方 API Key 由 CLI 的 custom provider 直连第三方，仍是同一个 Agent SDK）。
// 两版协议同源（2026-10-29 实测：canUseTool/hooks/消息流/memory 形状一致；
// 国际版 Qwen3.8-Flash 同 id qfmodel、price=0 FREE）。判定函数（judge*/checkToolCall）与 SDK 解耦。
// 切换语义：账号级配额耗尽 → switchEdition() 换轨 + 清内存会话（旧 session_id 跨轨无效，
// 磁盘残留 session.json 由 brain 的 resume 失败自愈兜底）；防来回抖动的 CD 改为每日零点重置。
// 2026-11-07：模型免费额度用完后 SDK 不报错而是直接计费（烧积分）。brain 把每条回执的
// billable/credits 报给 noteTrackUsage()，本轨标记“免费额度已用完”；下一轮先切另一条免费轨。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// 跨重启保存的“轨道状态”：当天切到的轨 + 自动换轨标记 + 当日耗尽标记 + CD 起点。
// 重启后若当天切过轨，恢复切到的轨（否则会回到已耗尽的启动轨、又被当日 CD 卡住到零点）；
// 跨零点则不恢复，由每日回轨回到 QODER_EDITION 启动默认轨。
const STATE_FILE = join(HERE, CFG.groupsDir, ".edition-state.json");
const IS_TEST = /\.test\.mjs$/i.test(process.argv[1] || "");
let stateLoaded = Boolean(IS_TEST);
let persistState = !IS_TEST;

const runtimes = new Map();          // edition → { edition, query, auth, baseEdition?, isVl }
const switchHistory = [];            // 最近切轨记录，供管理台展示
let active = normalizeEdition(process.env.QODER_EDITION);
let lastSwitchAt = 0;
let lastSwitchAuto = false;          // 上次切轨是不是自动 failover（手动切轨不参与每日回轨）
let switchHook = null;               // brain 注册：切轨后清理内存会话

function normalizeEdition(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "global" || s === "byok") return s;
  return "cn";
}

// 启动时的默认轨（QODER_EDITION）。双轨都耗尽后，零点重置的下一条消息回到这里。
let initialEdition = normalizeEdition(process.env.QODER_EDITION);

// 本地自然日键：免费额度按日重置，跨零点后允许重新尝试同一条轨
function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function nextMidnight(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// 懒加载：只在第一次真正用到状态时读，避免测试/其它入口无谓碰盘。
function loadEditionState() {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    applyEditionState(JSON.parse(readFileSync(STATE_FILE, "utf8")));
  } catch {}
}

// 当天切过轨 → 恢复切到的轨（含手动选择）；跨零点 → 保持启动默认轨。
// 目标轨当前不可用（凭据/配置没了）时不恢复，交给 initRuntime 的 BYOK 兜底。
function applyEditionState(j) {
  if (Number(j?.lastSwitchAt) > 0) lastSwitchAt = Number(j.lastSwitchAt);
  lastSwitchAuto = Boolean(j?.lastSwitchAuto);
  const today = dayKey();
  for (const [e, v] of Object.entries(j?.freeExhausted || {})) {
    if (!v || String(v.day) !== today) continue;
    const edition = normalizeEdition(e);
    if (edition === "byok") continue;
    freeExhausted.set(edition, { day: String(v.day), reason: String(v.reason ?? "").slice(0, 60), at: Number(v.at) || Date.now() });
  }
  if (Array.isArray(j?.history)) {
    for (const h of j.history.slice(-20)) {
      if (!h || !h.from || !h.to) continue;
      switchHistory.push({ at: Number(h.at) || 0, from: String(h.from), to: String(h.to), reason: String(h.reason ?? ""), auto: Boolean(h.auto) });
    }
  }
  const want = String(j?.active ?? "").trim().toLowerCase();
  const switchedToday = lastSwitchAt > 0 && dayKey(lastSwitchAt) === today;
  if (switchedToday && (want === "cn" || want === "global" || want === "byok") && editionAvailable(want)) active = want;
}

function saveEditionState() {
  if (!persistState) return;
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({
      at: Date.now(),
      active,
      lastSwitchAt,
      lastSwitchAuto,
      freeExhausted: Object.fromEntries(freeExhausted.entries()),
      history: switchHistory.slice(-20),
    }, null, 1));
    renameSync(tmp, STATE_FILE);
  } catch {}
}

// CD：当天切过轨 → 到下一个零点都算冷却；昨天切过 → 零点已重置。
export function switchCooldownRemaining(now = Date.now()) {
  loadEditionState();
  if (!lastSwitchAt) return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (lastSwitchAt < d.getTime()) return 0;
  return Math.max(0, nextMidnight(now) - now);
}

// 每轨“免费额度已用完”标记，按本地自然日失效。
const freeExhausted = new Map(); // edition → { day, reason, at }

export function markFreeExhausted(edition = active, reason = "免费额度已用完") {
  loadEditionState();
  const e = normalizeEdition(edition);
  if (e === "byok") return false;
  const prev = freeExhausted.get(e);
  if (prev && prev.day === dayKey()) return true;   // 当天已标记，不重复刷日志
  freeExhausted.set(e, { day: dayKey(), reason: String(reason).slice(0, 60), at: Date.now() });
  saveEditionState();
  console.log(`[SDK] ${e} 轨免费额度已用完（${reason}），下一次请求优先换到另一条免费轨`);
  return true;
}

export function isFreeExhausted(edition = active, now = Date.now()) {
  loadEditionState();
  const e = normalizeEdition(edition);
  const v = freeExhausted.get(e);
  if (!v) return false;
  if (v.day !== dayKey(now)) { freeExhausted.delete(e); return false; }
  return true;
}

// 管理台观察用：当前标记详情（只读，不触发清理）
export function freeExhaustedInfo(edition = active, now = Date.now()) {
  loadEditionState();
  const e = normalizeEdition(edition);
  const v = freeExhausted.get(e);
  if (!v || v.day !== dayKey(now)) return null;
  return { at: v.at, reason: v.reason };
}

// 最近一条计费回执（管理台展示 billable/credits，只存数值，不含正文）
const lastUsage = new Map(); // edition → { at, billable, credits }

export function usageInfo() {
  return Object.fromEntries(lastUsage.entries());
}

// SDK 回执的 usage.billable 语义：true = 这一请求已经计入用户计费（免费额度用完了）。
// credits 只在 billable 缺省时作兜底（老版本 CLI 可能只回 credits）。BYOK 不算。
export function noteTrackUsage(edition, usage) {
  const e = normalizeEdition(edition);
  if (e === "byok" || !usage) return false;
  const hasBillable = usage.billable !== undefined;
  const hasCredits = usage.credits !== undefined;
  if (hasBillable || hasCredits) {
    lastUsage.set(e, {
      at: Date.now(),
      billable: hasBillable ? Boolean(usage.billable) : null,
      credits: hasCredits ? Number(usage.credits) : null,
    });
  }
  const billable = usage.billable === true || (usage.billable === undefined && Number(usage.credits ?? 0) > 0);
  if (!billable) return false;
  return markFreeExhausted(e, `本轮已计费 credits=${Number(usage.credits ?? 0)} billable=${Boolean(usage.billable)}`);
}

export function sdkEdition() { return active; }
export function getSwitchHistory() { return switchHistory.slice().reverse(); }
export function onEditionSwitch(cb) { switchHook = typeof cb === "function" ? cb : null; }

function qoderAvailable(edition) {
  const e = normalizeEdition(edition);
  if (e === "global") return Boolean(process.env.QODER_PERSONAL_ACCESS_TOKEN);
  if (e !== "cn") return false;
  // cn 轨依赖本机 CLI 登录态目录（粗检；登录态失效会在使用时暴露，届时限额再切回即可）
  return existsSync(join(process.env.USERPROFILE || "", ".qoder-cn"));
}

export function byokBaseEdition() {
  const order = CFG.byokBaseEdition === "cn" ? ["cn", "global"] : ["global", "cn"];
  return order.find((e) => qoderAvailable(e)) ?? null;
}

// 只返回脱敏信息，绝不返回 key；model-check / 测试可安全打印。
export function byokInfo() {
  return {
    enabled: CFG.byokEnabled,
    ready: editionAvailable("byok"),
    provider: CFG.byokProvider,
    model: CFG.byokModel,
    hasKey: Boolean(CFG.byokApiKey),
    baseUrl: Boolean(CFG.byokBaseUrl),
    isVl: CFG.byokIsVl,
    baseEdition: byokBaseEdition(),
  };
}

// 管理台用；仍不返回 Key 原文。
export function byokSettings() {
  return {
    ...byokInfo(),
    baseUrl: CFG.byokBaseUrl,
    style: CFG.byokStyle,
    reasoningEffort: CFG.byokReasoningEffort,
    contextWindow: CFG.byokContextWindow,
    fallback: CFG.byokFallback,
  };
}

export function editionAvailable(edition) {
  const e = normalizeEdition(edition);
  if (e === "byok") {
    return Boolean(CFG.byokEnabled && CFG.byokProvider && CFG.byokModel && CFG.byokApiKey && byokBaseEdition());
  }
  return qoderAvailable(e);
}

// BYOK 走 CLI 自带的 custom provider（user settings 里的 providers 段），与官方客户端"添加模型"
// 写的是同一份结构。模型 key 是 <providerId>/<model>，CLI 直连第三方 baseUrl，不经 Qoder 服务端。
const QODER_HOME = process.env.USERPROFILE || process.env.HOME || "";
const SETTINGS_DIR = { cn: ".qoder-cn", global: ".qoder" };

function byokSettingsFile(baseEdition) {
  return join(QODER_HOME, SETTINGS_DIR[baseEdition] ?? SETTINGS_DIR.cn, "settings.json");
}

function readSettings(file) {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

const sameUrl = (a, b) => String(a ?? "").trim().replace(/\/+$/, "").toLowerCase() === String(b ?? "").trim().replace(/\/+$/, "").toLowerCase();

// 保证基础轨的 user settings 里有这个第三方提供商，返回 CLI 认的模型 key。
// 已是同一 baseUrl+model 的 provider 就复用（官方客户端建的那条），只补 key/上下文窗口。
export function ensureByokProvider(baseEdition = byokBaseEdition()) {
  const file = byokSettingsFile(baseEdition);
  const settings = readSettings(file);
  const providers = settings.providers && typeof settings.providers === "object" ? settings.providers : {};
  const model = CFG.byokModel;
  const contextWindow = CFG.byokContextWindow > 0 ? CFG.byokContextWindow : 200000;
  const anthropic = CFG.byokStyle === "anthropic";
  let id = Object.keys(providers).find((k) => {
    const p = providers[k] ?? {};
    return String(p.model ?? "").trim() === model && sameUrl(p.baseUrl, CFG.byokBaseUrl);
  });
  const modelEntry = {
    model,
    displayName: model,
    contextWindow,
    maxOutputTokens: 32000,
    capabilities: { tools: true, vision: Boolean(CFG.byokIsVl) },
  };
  let changed = false;
  if (!id) {
    id = `qoder-custom-${randomUUID()}`;
    providers[id] = {
      baseUrl: CFG.byokBaseUrl,
      apiKey: CFG.byokApiKey,
      type: "openai-compatible",
      protocol: anthropic ? "anthropic" : "openai",
      authType: anthropic ? "api-key" : "bearer",
      model,
      models: [modelEntry],
    };
    changed = true;
  } else {
    const entry = providers[id];
    if (entry.apiKey !== CFG.byokApiKey) { entry.apiKey = CFG.byokApiKey; changed = true; }
    const models = Array.isArray(entry.models) ? entry.models : [];
    const hit = models.find((m) => String(m?.model ?? "") === model);
    if (!hit) { models.push(modelEntry); entry.models = models; changed = true; }
    else if (Number(hit.contextWindow) !== contextWindow) { hit.contextWindow = contextWindow; changed = true; }
  }
  if (changed) {
    settings.providers = providers;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(settings, null, 2));
    renameSync(tmp, file);
    console.log(`[BYOK] 已写入 ${file} 的 provider ${id}（${model}，上下文 ${contextWindow}）`);
  }
  return `${id}/${model}`;
}

function wrapByokQuery(baseQuery, baseEdition, presetModelKey = null) {
  let modelKey = presetModelKey;   // 懒解析：管理台改配置后 runtime 会重建，这里不必缓存到进程结束
  return (args = {}) => {
    const options = { ...(args.options ?? {}) };
    const extraArgs = { ...(options.extraArgs ?? {}) };
    // 第三方模型的能力表与 Qwen 不同：不把 Qwen 的思考档/窗口硬塞给它。
    delete extraArgs["reasoning-effort"];
    delete extraArgs["context-window"];
    if (CFG.byokReasoningEffort) extraArgs["reasoning-effort"] = CFG.byokReasoningEffort;
    options.extraArgs = extraArgs;
    // CLI 只有加载 user settings 才会读 providers 段；writable 也要求这一点（官方 createByokConfig 卡在这）
    options.settingSources = ["user"];
    options.model = modelKey ??= ensureByokProvider(baseEdition);
    delete options.resolveModel;
    return baseQuery({ ...args, options });
  };
}

export async function loadSdk(edition = active) {
  const e = normalizeEdition(edition);
  if (runtimes.has(e)) return runtimes.get(e);
  let rt;
  if (e === "byok") {
    if (!editionAvailable("byok")) {
      throw new Error("BYOK 未启用或配置不完整：需要 BYOK_ENABLED=1、BYOK_PROVIDER、BYOK_MODEL、BYOK_API_KEY，以及可用的 Qoder 基础轨");
    }
    const baseEdition = byokBaseEdition();
    // SDK/headless 模式默认禁用 custom base URL，这个开关是 CLI 内部的放行位（实测 1.1.78 有效）
    process.env.QODER_SDK_CUSTOM_BASE_URL_BYOK = "1";
    const base = await loadSdk(baseEdition);
    rt = {
      edition: "byok", query: wrapByokQuery(base.query, baseEdition), auth: base.auth,
      baseEdition, isVl: CFG.byokIsVl,
      // 进程内 MCP 工具工厂沿用基础轨的实例（SDK 协议同源，避免跨版本混用）
      createSdkMcpServer: base.createSdkMcpServer, tool: base.tool,
    };
  } else if (e === "global") {
    if (!process.env.QODER_PERSONAL_ACCESS_TOKEN) {
      throw new Error("QODER_EDITION=global 需要 QODER_PERSONAL_ACCESS_TOKEN（在 qoder.com/account/integrations 生成后设进环境变量）");
    }
    const sdk = await import("@qoder-ai/qoder-agent-sdk");
    rt = { edition: e, query: sdk.query, auth: () => sdk.accessTokenFromEnv(), isVl: true, createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool };
  } else {
    const sdk = await import("@qodercn-ai/qodercn-agent-sdk");
    rt = { edition: e, query: sdk.query, auth: () => sdk.qodercliAuth(), isVl: true, createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool };
  }
  runtimes.set(e, rt);
  return rt;
}

// 预加载当前轨（brain/model-check 顶层 await 用），返回当前运行时。
// 初始轨凭据不可用、但 BYOK 已配置时，允许直接落到 BYOK 备用轨。
export async function initRuntime() {
  loadEditionState();
  if (active !== "byok" && !editionAvailable(active) && CFG.byokEnabled && CFG.byokFallback && editionAvailable("byok")) {
    console.log(`[SDK] ${active} 不可用，改用 BYOK 备用轨`);
    active = "byok";
  }
  return loadSdk(active);
}

async function doSwitch(to, reason, { cooldown = true, auto = false } = {}) {
  const from = active;
  const rt = await loadSdk(to);
  active = to;
  lastSwitchAuto = auto;
  if (cooldown) lastSwitchAt = Date.now();
  switchHistory.push({ at: Date.now(), from, to, reason: String(reason).slice(0, 80), auto });
  if (switchHistory.length > 50) switchHistory.splice(0, switchHistory.length - 50);
  saveEditionState();
  console.log(`[SDK] ${reason}：运行轨道 ${from} → ${to}${cooldown ? "（每日零点前不再切轨）" : "（每日回轨不占当日 CD）"}`);
  try { if (switchHook) await switchHook(from, to); } catch (e) { console.log(`[SDK] 切轨清理异常（不影响切换）：${String(e?.message ?? e).slice(0, 120)}`); }
  return rt;
}

// 管理台手动切轨：不看每日零点 CD，但要求目标轨凭据/配置可用；手动选择不参与“每日回轨”。
export async function forceEdition(edition, reason = "管理台手动切换") {
  const to = normalizeEdition(edition);
  if (!editionAvailable(to)) throw new Error(`轨道 ${to} 不可用（凭据或 BYOK 配置不完整）`);
  await doSwitch(to, reason, { auto: false });
  return to;
}

export function invalidateRuntime(edition) {
  runtimes.delete(normalizeEdition(edition));
}

function qoderPreference() {
  return CFG.byokBaseEdition === "cn" ? ["cn", "global"] : ["global", "cn"];
}

// 配额耗尽/免费额度用完时的换轨尝试：Qoder 双轨优先，CD 内或目标轨也空了才落到 BYOK。
// 目标轨“当天免费额度已用完”时不再切过去（避免两边来回空烧），直接看 BYOK。
// 换轨成功 → true（当前轮静默，下一轮消息走新轨；switchHook 负责清理会话）；
// 失败（无可用轨/冷却/未配置）→ false（调用方静默跳过，等零点重置）。
// 单飞保护：多群并发同时检出限额时，所有调用方复用同一次切换。
let pendingSwitch = null;
export function switchEdition(reason = "配额耗尽") {
  if (pendingSwitch) return pendingSwitch;
  pendingSwitch = (async () => {
    const from = active;
    if (from === "byok") {
      if (switchCooldownRemaining() > 0) return false;
      const target = qoderPreference().find((e) => qoderAvailable(e) && !isFreeExhausted(e));
      if (!target) return false;
      return Boolean(await doSwitch(target, reason, { auto: true }));
    }
    const other = from === "cn" ? "global" : "cn";
    if (switchCooldownRemaining() <= 0 && qoderAvailable(other) && !isFreeExhausted(other)) {
      return Boolean(await doSwitch(other, reason, { auto: true }));
    }
    // CD 内、另一条 Qoder 轨不可用或它的免费额度也空了：BYOK 是最后一层备用。
    if (CFG.byokEnabled && CFG.byokFallback && editionAvailable("byok")) {
      return Boolean(await doSwitch("byok", reason, { auto: true }));
    }
    return false;
  })().finally(() => { pendingSwitch = null; });
  return pendingSwitch;
}

export function defaultEdition() { return initialEdition; }

// 每日回轨：只回滚“自动 failover”造成的换轨；手动选择保持不动。
// 条件：不是启动轨、零点后 CD 已清零、启动轨凭据可用且当天没被标记为空。
export function canRestoreDefault(now = Date.now()) {
  if (active === initialEdition) return false;
  if (!lastSwitchAuto) return false;
  if (switchCooldownRemaining(now) > 0) return false;
  if (!editionAvailable(initialEdition)) return false;
  if (initialEdition !== "byok" && isFreeExhausted(initialEdition, now)) return false;
  return true;
}

// 回轨不算一次“当日切轨”，不设 CD：否则零点后的第一次回轨会把当天 failover 资格也用掉。
export async function restoreDefaultEdition(reason = "每日重置回到启动轨") {
  if (!canRestoreDefault()) return false;
  await doSwitch(initialEdition, reason, { cooldown: false, auto: true });
  return true;
}

// 供测试注入：重置运行时状态
export function _resetForTest(edition = "cn") {
  runtimes.clear();
  switchHistory.length = 0;
  active = normalizeEdition(edition);
  lastSwitchAt = 0;
  lastSwitchAuto = false;
  stateLoaded = true;        // 测试不读生产状态文件
  persistState = false;      // 测试也不写
  switchHook = null;
  freeExhausted.clear();
  delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
  CFG.byokEnabled = false;
  CFG.byokProvider = "";
  CFG.byokModel = "";
  CFG.byokApiKey = "";
  CFG.byokBaseUrl = "";
  CFG.byokStyle = "";
  CFG.byokIsVl = false;
  CFG.byokReasoningEffort = "";
  CFG.byokContextWindow = 0;
  CFG.byokBaseEdition = "global";
  CFG.byokFallback = true;
}

// 测试用：模拟“上次切轨发生在很久以前”，验证 CD 的每日零点语义。
export function _setLastSwitchAtForTest(ts) { lastSwitchAt = Number(ts) || 0; }

// 测试用：模拟启动时的 QODER_EDITION（默认回轨目标）。
export function _setInitialEditionForTest(edition) { initialEdition = normalizeEdition(edition); }

// 测试用：模拟从 .edition-state.json 恢复（当天切轨 / 跨零点），不碰真实文件。
export function _applyStateForTest(j) { applyEditionState(j); }

// 测试用：不启动真实 query，只验证 BYOK 包装器是否把模型换成 provider key、剥掉 Qwen 参数。
// 传 presetModelKey 避免单测去写真实的 ~/.qoder*/settings.json。
export function _wrapByokQueryForTest(baseQuery, presetModelKey = "deepseek/deepseek-flash-pg") {
  return wrapByokQuery(baseQuery, CFG.byokBaseEdition, presetModelKey);
}
