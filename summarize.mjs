// 手动/补跑入口：把每群的本地转录抽成结构化记事条目。
// 轮换时 brain 会自动跑同一条链路（session-memory.mjs）；这个脚本留给补跑和 dry-run。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CFG } from "./config.mjs";
import { readEntries, renderEntry } from "./memory.mjs";
import { summarizeGroup } from "./session-memory.mjs";

const root = join(process.cwd(), CFG.groupsDir);
const all = process.argv.includes("--all");
const group = process.argv.find((a, i) => process.argv[i - 1] === "--group");
const dry = process.argv.includes("--dry");
const groups = all
  ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : group ? [group] : [];

if (!groups.length) {
  console.log("用法：node summarize.mjs --all [--dry]  |  node summarize.mjs --group <目录名> [--dry]");
  process.exit(1);
}

for (const name of groups) {
  const dir = join(root, name);
  console.log(`\n### ${name}`);
  try {
    const r = await summarizeGroup(dir, { dry });
    if (r.skipped) { console.log(`   跳过：${r.skipped}`); continue; }
    console.log(`   ${r.ok ? "完成" : "失败"}｜新增 ${r.added ?? 0} 条｜本子 ${r.kept ?? 0} 条｜模型调用 ${r.chunks ?? 0} 次${r.truncated ? "｜还有未处理转录" : ""}${dry ? "（dry-run 未写盘）" : ""}${r.error ? `｜${r.error}` : ""}`);
    for (const e of readEntries(dir)) console.log("   " + renderEntry(e));
  } catch (e) {
    console.log(`   失败：${String(e?.message ?? e).slice(0, 160)}`);
  }
}
