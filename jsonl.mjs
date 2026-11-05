// 追加式 JSONL：正常只 append，超过 max*2 才压缩一次，避免每轮/每条消息读全量重写。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const counts = new Map();

function lineCount(file) {
  if (counts.has(file)) return counts.get(file);
  let n = 0;
  try { if (existsSync(file)) n = readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch {}
  counts.set(file, n);
  return n;
}

function compact(file, max) {
  if (!max || !existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-max);
  writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""));
  counts.set(file, lines.length);
}

export function appendJsonl(file, obj, { max = 0 } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(obj) + "\n");
    const n = lineCount(file) + 1;
    counts.set(file, n);
    if (max && n > max * 2) compact(file, max);
    return true;
  } catch {
    return false;
  }
}

export function resetJsonlCount(file) {
  counts.delete(file);
}
