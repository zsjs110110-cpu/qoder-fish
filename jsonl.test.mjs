import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
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
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(fail === 0 ? "\nJSONL 追加全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
