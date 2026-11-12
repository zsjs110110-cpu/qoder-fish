// A10：交付事件（拟回复 vs 已发送）。只记状态和计数，不记回复正文。
// 写：adapter 在发送循环结束后追加；读：history / session-memory 按 turnId 合并。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl } from "./jsonl.mjs";
import { CFG } from "./config.mjs";

export function appendDelivery(dir, ev = {}) {
  if (!dir || !ev.turnId) return false;
  return appendJsonl(join(dir, CFG.deliveryFile), {
    ts: Date.now(),
    turnId: String(ev.turnId),
    chatKey: String(ev.chatKey ?? ""),
    status: String(ev.status ?? "unknown"),
    partsSent: Number(ev.partsSent ?? 0),
    partsPlanned: Number(ev.partsPlanned ?? 0),
    error: ev.error ? String(ev.error).slice(0, 120) : "",
  }, { max: CFG.deliveryMaxLines });
}

// turnId → 最近一次状态。旧文件没有交付事件时查不到，统一按 unknown 处理（不伪造 delivered）。
export function readDeliveries(dir) {
  const map = new Map();
  const file = join(dir, CFG.deliveryFile);
  if (!existsSync(file)) return map;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j?.turnId) map.set(String(j.turnId), String(j.status ?? "unknown"));
      } catch {}
    }
  } catch {}
  return map;
}

export function deliveryOf(map, turnId) {
  if (!turnId || !map) return "unknown";
  return map.get(String(turnId)) ?? "unknown";
}

export function isUnsent(status) {
  return status === "failed" || status === "dropped";
}
