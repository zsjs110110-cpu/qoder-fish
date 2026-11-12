// BYOK 本机配置：管理台写入 byok-config.json，config.mjs 启动时读取。
// 文件含第三方 API Key，按密钥级保管；任何日志/状态接口都不返回 Key 原文。
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";

export const BYOK_FILE = "byok-config.json";
const FIELDS = ["enabled", "provider", "model", "apiKey", "baseUrl", "style", "isVl", "reasoningEffort", "contextWindow", "baseEdition", "fallback"];

export function byokFilePath(baseDir) { return join(baseDir, BYOK_FILE); }

function str(v, max = 500) {
  return String(v ?? "").replace(/[\r\n\t]/g, " ").trim().slice(0, max);
}

function normalize(raw = {}) {
  const out = {};
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.fallback === "boolean") out.fallback = raw.fallback;
  if (typeof raw.isVl === "boolean") out.isVl = raw.isVl;
  if (raw.provider !== undefined) out.provider = str(raw.provider, 80);
  if (raw.model !== undefined) out.model = str(raw.model, 160);
  if (raw.baseUrl !== undefined) out.baseUrl = str(raw.baseUrl, 1000);
  if (raw.style !== undefined) out.style = str(raw.style, 40);
  if (raw.reasoningEffort !== undefined) out.reasoningEffort = str(raw.reasoningEffort, 40);
  if (raw.baseEdition !== undefined) out.baseEdition = str(raw.baseEdition, 20) === "cn" ? "cn" : "global";
  if (raw.contextWindow !== undefined) {
    const n = Number(raw.contextWindow);
    out.contextWindow = Number.isFinite(n) && n > 0 ? Math.min(2_000_000, Math.floor(n)) : 0;
  }
  if (raw.apiKey !== undefined) out.apiKey = str(raw.apiKey, 1000);
  return out;
}

export function loadByokStore(baseDir) {
  const file = byokFilePath(baseDir);
  if (!existsSync(file)) return {};
  try { return normalize(JSON.parse(readFileSync(file, "utf8"))); }
  catch { return {}; }
}

// 空 apiKey 表示“保留已存 Key”；clearKey=true 才是明确清空。
export function sanitizeByokPatch(patch = {}, existing = {}) {
  const next = { ...existing };
  for (const k of FIELDS) {
    if (k === "apiKey") {
      if (typeof patch.apiKey === "string" && patch.apiKey.trim()) next.apiKey = patch.apiKey;
      continue;
    }
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  if (patch.clearKey === true) next.apiKey = "";
  return normalize(next);
}

export function saveByokStore(baseDir, patch = {}) {
  const file = byokFilePath(baseDir);
  const next = sanitizeByokPatch(patch, loadByokStore(baseDir));
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch {}
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch {}
  return next;
}
