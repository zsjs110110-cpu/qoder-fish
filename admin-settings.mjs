// 管理台设置层：写 byok-config.json、同步 CFG、让 BYOK 运行时缓存失效。
// 正在 BYOK 轨时热切换到新配置；保存后配置不完整则切回一条可用 Qoder 轨。
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";
import { saveByokStore } from "./byok-store.mjs";
import { fetchModelList } from "./model-list.mjs";
import { byokInfo, byokBaseEdition, editionAvailable, forceEdition, invalidateRuntime, sdkEdition } from "./sdk.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));

function syncConfig(s) {
  if (s.enabled !== undefined) CFG.byokEnabled = Boolean(s.enabled);
  if (s.fallback !== undefined) CFG.byokFallback = Boolean(s.fallback);
  if (s.isVl !== undefined) CFG.byokIsVl = Boolean(s.isVl);
  if (s.provider !== undefined) CFG.byokProvider = String(s.provider);
  if (s.model !== undefined) CFG.byokModel = String(s.model);
  if (s.apiKey !== undefined) CFG.byokApiKey = String(s.apiKey);
  if (s.baseUrl !== undefined) CFG.byokBaseUrl = String(s.baseUrl);
  if (s.style !== undefined) CFG.byokStyle = String(s.style);
  if (s.reasoningEffort !== undefined) CFG.byokReasoningEffort = String(s.reasoningEffort);
  if (s.contextWindow !== undefined) CFG.byokContextWindow = Number(s.contextWindow) || 0;
  if (s.baseEdition !== undefined) CFG.byokBaseEdition = s.baseEdition === "cn" ? "cn" : "global";
}

export async function listModelsForUi(patch = {}) {
  const baseUrl = String(patch.baseUrl ?? "").trim() || CFG.byokBaseUrl;
  const apiKey = String(patch.apiKey ?? "").trim() || CFG.byokApiKey;
  const style = String(patch.style ?? "").trim() || CFG.byokStyle;
  if (!baseUrl) throw new Error("先填 Base URL（或先保存）");
  if (!apiKey) throw new Error("先填 API Key（或先保存）");
  return fetchModelList({ baseUrl, apiKey, style });
}

export async function applyByokSettings(patch) {
  const saved = saveByokStore(ROOT, patch);
  syncConfig(saved);
  invalidateRuntime("byok");
  if (sdkEdition() === "byok") {
    if (editionAvailable("byok")) {
      await forceEdition("byok", "BYOK 设置已更新");
    } else {
      const target = byokBaseEdition();
      if (!target) throw new Error("BYOK 已保存，但配置不完整且没有可用的 Qoder 基础轨");
      await forceEdition(target, "BYOK 配置不完整，切回 Qoder");
    }
  }
  return byokInfo();
}
