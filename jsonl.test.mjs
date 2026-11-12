import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl } from "./jsonl.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const dir = mkdtempSync(join(tmpdir(), "jsonl-test-"));
const file = join(dir, "x.jsonl");
try {
  appendJsonl(file, { i: 1 }, { max: 2 });
  appendJsonl(file, { i: 2 }, { max: 2 });
  appendJsonl(file, { i: 3 }, { max: 2 });
  appendJsonl(file, { i: 4 }, { max: 2 });
  appendJsonl(file, { i: 5 }, { max: 2 });
  appendJsonl(file, { i: 6 }, { max: 2 });
  appendJsonl(file, { i: 7 }, { max: 2 });
  const lines = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  ok("超过 2×max 压缩到 max", lines.length <= 2, lines.length);
  ok("保留最后一条", lines.at(-1)?.i, 7);
  ok("文件存在", existsSync(file), true);
  ok("压缩后无残留临时文件", readdirSync(dir).filter((n) => n.endsWith(".tmp")).length === 0, true);
  // A10：尚未被摘要处理的行（seq > 水位）不能被压缩丢掉
  const file2 = join(dir, "seq.jsonl");
  for (let i = 1; i <= 7; i++) appendJsonl(file2, { seq: i }, { max: 2, protectAfterSeq: 3 });
  const seqRows = readFileSync(file2, "utf8").trim().split("\n").map(JSON.parse);
  ok("未摘要行被保护", seqRows[0]?.seq >= 4 && seqRows.at(-1)?.seq === 7, seqRows.map((r) => r.seq).join(","));
  // 头部一条坏行不能把整份文件卡成永不压缩
  const file3 = join(dir, "bad.jsonl");
  writeFileSync(file3, "{bad json}\n");
  for (let i = 1; i <= 6; i++) appendJsonl(file3, { i }, { max: 2 });
  const badLines = readFileSync(file3, "utf8").trim().split("\n");
  ok("坏行不阻塞压缩", badLines.length === 2 && !badLines.some((l) => l.includes("bad json")), badLines.join("|"));
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(fail === 0 ? "\nJSONL 追加全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
