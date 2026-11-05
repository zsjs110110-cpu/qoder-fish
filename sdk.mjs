// Qoder SDK 运行时管理：cn/global 双轨 + BYOK 第三轨。
// QODER_EDITION 选初始轨（cn/global/byok）；Qoder 账号限额耗尽时优先换另一条 Qoder 轨，
// 两条都不可用时才尝试 BYOK（第三方 API Key 通过 SDK 的 resolveModel 路由，仍是同一个 Agent SDK）。
// 两版协议同源（2026-10-29 实测：canUseTool/hooks/消息流/memory 形状一致；
// 国际版 Qwen3.8-Flash 同 id qfmodel、price=0 FREE）。判定函数（judge*/checkToolCall）与 SDK 解耦。
// 切换语义：账号级配额耗尽 → switchEdition() 换轨 + 清内存会话（旧 session_id 跨轨无效，
// 磁盘残留 session.json 由 brain 的 resume 失败自愈兜底）；8 小时 CD 防来回抖动。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CFG } from "./config.mjs";

const SWITCH_CD_MS = 8 * 3600_000;
const runtimes = new Map();          // edition → { edition, query, auth, baseEdition?, isVl }
const switchHistory = [];            // 最近切轨记录，供管理台展示
let active = normalizeEdition(process.env.QODER_EDITION);
let lastSwitchAt = 0;
let switchHook = null;               // brain 注册：切轨后清理内存会话

function normalizeEdition(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "global" || s === "byok") return s;
  return "cn";
}

export function sdkEdition() { return active; }
export function switchCooldownRemaining() { return Math.max(0, SWITCH_CD_MS - (Date.now() - lastSwitchAt)); }
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

// SDK 的 ModelPolicyProvider 返回值：CustomModel 里的 api_key 只在内存里传给 SDK，
// 不落日志；style 缺省时 SDK 自己补 openai。
export function byokPolicy() {
  const model = {
    provider: CFG.byokProvider,
    api_key: CFG.byokApiKey,
    model: CFG.byokModel,
    isVl: CFG.byokIsVl,
  };
  if (CFG.byokBaseUrl) model.url = CFG.byokBaseUrl;
  if (CFG.byokStyle) model.style = CFG.byokStyle;
  const parameters = {};
  if (CFG.byokContextWindow > 0) parameters.contextWindow = CFG.byokContextWindow;
  if (CFG.byokReasoningEffort) parameters.reasoningEffort = CFG.byokReasoningEffort;
  return Object.keys(parameters).length ? { model, parameters } : { model };
}

function wrapByokQuery(baseQuery) {
  return (args = {}) => {
    const options = { ...(args.options ?? {}) };
    const extraArgs = { ...(options.extraArgs ?? {}) };
    // 第三方模型的能力表与 Qwen 不同：不把 Qwen 的思考档/窗口硬塞给它。
    delete extraArgs["reasoning-effort"];
    delete extraArgs["context-window"];
    if (CFG.byokReasoningEffort) extraArgs["reasoning-effort"] = CFG.byokReasoningEffort;
    options.extraArgs = extraArgs;
    options.resolveModel = () => byokPolicy();
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
    const base = await loadSdk(baseEdition);
    rt = {
      edition: "byok", query: wrapByokQuery(base.query), auth: base.auth,
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
  if (active !== "byok" && !editionAvailable(active) && CFG.byokEnabled && CFG.byokFallback && editionAvailable("byok")) {
    console.log(`[SDK] ${active} 不可用，改用 BYOK 备用轨`);
    active = "byok";
  }
  return loadSdk(active);
}

async function doSwitch(to, reason) {
  const from = active;
  const rt = await loadSdk(to);
  active = to;
  lastSwitchAt = Date.now();
  switchHistory.push({ at: Date.now(), from, to, reason: String(reason).slice(0, 80) });
  if (switchHistory.length > 50) switchHistory.splice(0, switchHistory.length - 50);
  console.log(`[SDK] ${reason}：运行轨道 ${from} → ${to}（${SWITCH_CD_MS / 3600_000} 小时内不回切）`);
  try { if (switchHook) await switchHook(from, to); } catch (e) { console.log(`[SDK] 切轨清理异常（不影响切换）：${String(e?.message ?? e).slice(0, 120)}`); }
  return rt;
}

// 管理台手动切轨：不看 8h CD，但要求目标轨凭据/配置可用。
export async function forceEdition(edition, reason = "管理台手动切换") {
  const to = normalizeEdition(edition);
  if (!editionAvailable(to)) throw new Error(`轨道 ${to} 不可用（凭据或 BYOK 配置不完整）`);
  await doSwitch(to, reason);
  return to;
}

export function invalidateRuntime(edition) {
  runtimes.delete(normalizeEdition(edition));
}

function qoderPreference() {
  return CFG.byokBaseEdition === "cn" ? ["cn", "global"] : ["global", "cn"];
}

// 配额耗尽时的换轨尝试：Qoder 双轨优先，8h CD 内或双轨不可用才落到 BYOK。
// 换轨成功 → true（当前轮静默，下一轮消息走新轨；switchHook 负责清理会话）；
// 失败（无可用轨/冷却/未配置）→ false（调用方维持静默跳过）。
// 单飞保护：多群并发同时检出限额时，所有调用方复用同一次切换。
let pendingSwitch = null;
export function switchEdition(reason = "配额耗尽") {
  if (pendingSwitch) return pendingSwitch;
  pendingSwitch = (async () => {
    const from = active;
    if (from === "byok") {
      if (switchCooldownRemaining() > 0) return false;
      const target = qoderPreference().find((e) => qoderAvailable(e));
      if (!target) return false;
      return Boolean(await doSwitch(target, reason));
    }
    const other = from === "cn" ? "global" : "cn";
    if (switchCooldownRemaining() <= 0 && qoderAvailable(other)) {
      return Boolean(await doSwitch(other, reason));
    }
    // CD 内或另一条 Qoder 轨不可用：BYOK 是最后一层备用。
    if (CFG.byokEnabled && CFG.byokFallback && editionAvailable("byok")) {
      return Boolean(await doSwitch("byok", reason));
    }
    return false;
  })().finally(() => { pendingSwitch = null; });
  return pendingSwitch;
}

// 供测试注入：重置运行时状态
export function _resetForTest(edition = "cn") {
  runtimes.clear();
  switchHistory.length = 0;
  active = normalizeEdition(edition);
  lastSwitchAt = 0;
  switchHook = null;
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

// 测试用：不启动真实 query，只验证 BYOK 包装器是否注入 resolveModel、剥掉 Qwen 参数。
export function _wrapByokQueryForTest(baseQuery) { return wrapByokQuery(baseQuery); }
