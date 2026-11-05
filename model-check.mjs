// 模型侧配置体检：把"实际发给 SDK 的东西"打出来，并向 SDK 实问模型/思考档/配额。
// 零模型轮次（只 initialize，不发用户消息），不花额度、不写记事本。用法：node model-check.mjs
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSdk, byokInfo } from "./sdk.mjs";
import { CFG } from "./config.mjs";
import * as layers from "./prompt-layers/layers.mjs";

const { query, auth: sdkAuth } = await loadSdk();

const HERE = fileURLToPath(new URL(".", import.meta.url));
const sys = layers.buildSystemPrompt({ character: CFG.character, tools: CFG.tools, chatTools: CFG.chatTools });
const n = (s) => [...String(s).trim()].length;

console.log("=== 模型与推理 ===");
console.log(`  SDK 版本=${(await loadSdk()).edition} · model=${CFG.model} · reasoning-effort=${CFG.reasoningEffort} · 上下文档=${CFG.contextWindow.toLocaleString()}（extraArgs --context-window）`);
console.log("  温度：平台模型侧无口子（CLI 无 --temperature、SDK options 无该字段、config 只认 vpc_endpoint）");
console.log(`  鉴权=${(await loadSdk()).edition === "global" ? "accessTokenFromEnv()（PAT）" : (await loadSdk()).edition === "byok" ? "Qoder 基础轨鉴权 + BYOK resolveModel" : "qodercliAuth()（复用本机登录态，无 PAT）"}`);
const bi = byokInfo();
if (bi.enabled) console.log(`  BYOK=${bi.ready ? "ready" : "不完整"} · provider=${bi.provider || "(未设)"} · model=${bi.model || "(未设)"} · key=${bi.hasKey ? "set" : "unset"} · vl=${bi.isVl} · base=${bi.baseEdition || "(无)"}`);
console.log(`  maxTurns/条=${CFG.maxTurnsPerMessage} · 单条超时=${CFG.requestTimeoutMs / 1000}s · 系统提示词 ${n(sys)} 字（不含每轮 L4）`);

console.log("\n=== 工具面（brain 实际传给 SDK 的） ===");
console.log(`  tools=${JSON.stringify(CFG.tools)}`);
console.log(`  allowedTools=[]（每个工具都必须过 canUseTool）· disallowedTools=hardDenied ${CFG.hardDenied.length} 项`);
console.log(`  permissionMode=default · skills/mcp/plugins/settingSources 全关`);
console.log(`  对外宣称=${JSON.stringify(CFG.chatTools)} · 内部本事=${CFG.tools.filter((t) => !CFG.chatTools.includes(t)).join("/")}`);
console.log(`  ⚠ hardDenied 与 tools 无交集的有 ${CFG.hardDenied.filter((t) => !CFG.tools.includes(t)).length}/${CFG.hardDenied.length} 项（纵深防御，当前不产生实际拦截）`);

console.log("\n=== 权限与限额 ===");
console.log(`  owner=${JSON.stringify(CFG.owners)} admin=${JSON.stringify(CFG.admins)} blocked=${JSON.stringify(CFG.blockedUsers)}`);
for (const [r, p] of Object.entries(CFG.toolPolicy)) console.log(`  toolPolicy.${r.padEnd(7)}=${p === "*" ? "全部" : JSON.stringify(p)}`);
console.log(`  条数限额 ${CFG.perUserPerMinute}/分 · ${CFG.perUserDailyMessages}/天（owner 不计）`);
console.log("  配额闸门：已删除（免费档模型 priceFactor=0，账号配额与她能不能说话无关）");
console.log(`  抓取白名单=${CFG.fetchHosts.length ? CFG.fetchHosts.join(",") : "不限站（私网/回环/file: 对所有人硬拦）"}`);
console.log(`  图片 单张≤${(CFG.imageMaxBytes / 1048576).toFixed(0)}MB · 每条≤${CFG.maxImagesPerMessage}张 · 合计≤${(CFG.imageTotalBytes / 1048576).toFixed(0)}MB · 只认 ${CFG.mediaCacheDir}/`);

console.log("\n=== 会话与记忆 ===");
console.log(`  一群一 cwd=${CFG.groupsDir}/<key> · 轮换 ${CFG.rotateAfterTurns} 轮 · 空闲回收 ${CFG.sessionIdleCloseMs / 60000}min · 常驻≤${CFG.maxLiveSessions}`);
console.log(`  记事本=${CFG.memoryEnabled ? "开" : "关"}（custom roots 指向 ${CFG.memoryDir}/，注入只走 L4；SDK consumption 原文通道已关）`);
console.log(`  转录 ${CFG.transcriptFile}≤${CFG.transcriptMaxLines} 行（明文、无保留期）`);

console.log("\n=== 手感与门槛 ===");
console.log(`  回复≤${CFG.replyMaxSentences}句/${CFG.replyMaxChars}字 · 拆泡≤${CFG.splitMaxParts}条×${CFG.splitMaxChars}字·间隔${CFG.splitGapMs}ms`);
console.log(`  白名单硬门槛 requireWhitelist=${CFG.requireWhitelist}（一个都不设且没 ALLOW_ALL=1 时 index.mjs 拒绝启动）· 群里要不要 @ 由环境变量 REQUIRE_AT 决定`);

console.log("\n=== 向 SDK 实问（零模型轮次） ===");
const dir = join(HERE, ".cfg-probe");
mkdirSync(dir, { recursive: true });
let wake; const gate = new Promise((r) => { wake = r; });
async function* idle() { await gate; }
const q = query({ prompt: idle(), options: { auth: sdkAuth(), cwd: dir, model: CFG.model, systemPrompt: "cfg probe", tools: [], skills: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], plugins: [], persistSession: false } });
try {
  const init = await q.initializationResult();
  const models = init?.models ?? [];
  // 列表里 value 是内部 id（如 qfmodel），displayName 才是人看的名字；两种写法都能传给 model
  const hit = models.find((m) => String(m?.displayName).toLowerCase() === CFG.model.toLowerCase() || String(m?.value).toLowerCase() === CFG.model.toLowerCase());
  console.log(`  SDK 回报 ${models.length} 个模型 · ${CFG.model} → ${hit ? `命中 id=${hit.value}` : "**没命中，检查 config.mjs**"}`);
  if (hit) {
    const okEffort = (hit.efforts ?? []).includes(CFG.reasoningEffort);
    console.log(`  能力 reasoning=${hit.isReasoning} · 看图 vl=${hit.isVl} · 思考档=${JSON.stringify(hit.efforts)}（默认 ${hit.defaultEffort}）· 我们用 ${CFG.reasoningEffort} ${okEffort ? "✓" : "✗ 不在表里"}`);
    console.log(`  上限 输入 ${hit.maxInputTokens} · 输出 ${hit.maxOutputTokens} · 上下文档 ${JSON.stringify(hit.availableContextWindows)}（默认 ${hit.defaultContextWindow}）`);
    const legal = (hit.availableContextWindows ?? []).includes(CFG.contextWindow);
    console.log(`  我们配的 ${CFG.contextWindow} ${legal ? "✓ 在合法挡位表里" : "✗ 不在表里 —— CLI 不报错，会静默退回默认 " + hit.defaultContextWindow + "（实测 12345 就是这样）"}`);
    console.log(`  计价 priceFactor=${hit.priceFactor}${hit.isFree ? "（当前免费档，所以 credits 不涨）" : ""}`);
  }
  const usage = await q.getUsageInfo();
  if (usage) console.log(`  配额 已用 ${usage.totalUsagePercentage}% · 加油包 ${usage.addOnQuota?.used ?? "?"}/${usage.addOnQuota?.total ?? "?"} ${usage.addOnQuota?.unit ?? ""} · 剩余 ${usage.addOnQuota?.remaining ?? "?"} · 超限=${usage.isQuotaExceeded}`);
  if (bi.enabled) {
    try {
      const r = await q.checkByokConfig({
        provider: CFG.byokProvider, model: CFG.byokModel, api_key: CFG.byokApiKey,
        ...(CFG.byokBaseUrl ? { url: CFG.byokBaseUrl } : {}),
        ...(CFG.byokStyle ? { style: CFG.byokStyle } : {}),
      });
      console.log(`  BYOK 校验=${r?.success ? "通过" : "失败"}${r?.code ? ` code=${r.code}` : ""}${r?.error ? ` ${String(r.error).slice(0, 120)}` : ""}`);
    } catch (e) {
      console.log(`  BYOK 校验异常：${String(e?.message ?? e).slice(0, 160)}`);
    }
  }
  console.log(`  账号 ${(init?.account?.name ?? "?")}（${init?.account?.subscriptionType ?? "?"}）`);
} catch (e) {
  console.log(`  × 探测失败：${String(e?.message ?? e).slice(0, 160)}`);
} finally {
  if (wake) wake();
  await q.close?.();
}
process.exit(0);
