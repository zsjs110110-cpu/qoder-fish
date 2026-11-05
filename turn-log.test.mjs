import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordTurn, groupDir } from "./brain.mjs";
import { CFG } from "./config.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const key = "g:turn-log-test";
const dir = groupDir(key);
try {
  recordTurn(key, { turnId: "t1", phase: "model", modelMs: 12, toolCalls: [{ name: "WebFetch", ok: true }] });
  recordTurn(key, { turnId: "t1", phase: "send", sendMs: 4, sendParts: 1 });
  recordTurn(key, { turnId: "t2", phase: "drop", dropped: "stale", queueWaitMs: 40000 });
  const file = join(dir, CFG.turnsFile);
  ok("turns.jsonl 已创建", existsSync(file));
  const rows = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  ok("每事件一行", rows.length, 3);
  ok("turnId 可关联", rows[0].turnId === rows[1].turnId, rows.map((r) => r.turnId).join(","));
  ok("包含发送阶段", rows[1].phase, "send");
  ok("包含丢弃阶段", rows[2].dropped, "stale");
  ok("不含正文字段", !("text" in rows[0]) && !("reply" in rows[0]));
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
console.log(fail === 0 ? "\nturn 观测全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
