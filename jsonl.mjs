// 追加式 JSONL：正常只 append，超过 max*2 才压缩一次，避免每轮/每条消息读全量重写。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";

const counts = new Map();

function lineCount(file) {
  if (counts.has(file)) return counts.get(file);
  let n = 0;
  try { if (existsSync(file)) n = readFileSync(file, "utf8").split("\n").filter(Boolean).length; } catch {}
  counts.set(file, n);
  return n;
}

// 压缩用临时文件 + rename：rename 失败时旧文件原样保留，绝不直接截断覆盖（数据安全 A03）。
// protectAfterSeq：摘要尚未处理的行（seq > 水位）不能被压缩丢掉（A10 摘要原料保护）。
// 损坏行若落在待删区就随旧行一起丢，并在日志里计数；否则一条坏行会让整个文件永不压缩。
function compact(file, max, protectAfterSeq = 0) {
  if (!max || !existsSync(file)) return;
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let keepFrom = Math.max(0, lines.length - max);
  const keptBad = [];
  for (let i = 0; i < keepFrom; i++) {
    let seq = 0, bad = false;
    try { seq = Number(JSON.parse(lines[i])?.seq ?? 0); } catch { bad = true; }
    if (protectAfterSeq >= 0 && seq > protectAfterSeq) { keepFrom = i; break; }
    if (bad) keptBad.push(lines[i]);
  }
  const kept = lines.slice(keepFrom);
  if (keptBad.length) console.log(`[JSONL] ${file} 压缩丢弃 ${keptBad.length} 行损坏数据（无正文）`);
  const text = kept.join("\n") + (kept.length ? "\n" : "");
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    counts.set(file, kept.length);
  } catch {
    try { rmSync(tmp, { force: true }); } catch {}
    counts.delete(file);   // 旧文件未动；下次按真实行数重新统计
  }
}

export function appendJsonl(file, obj, { max = 0, protectAfterSeq = 0 } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(obj) + "\n");
    const n = lineCount(file) + 1;
    counts.set(file, n);
    if (max && n > max * 2) compact(file, max, protectAfterSeq);
    return true;
  } catch {
    return false;
  }
}

export function resetJsonlCount(file) {
  counts.delete(file);
}
