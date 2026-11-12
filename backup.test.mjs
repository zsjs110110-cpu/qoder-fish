// 群目录快照 + 哨兵：异盘快照、缺失/清空检测、保留期、锁文件排除
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotGroups } from "./backup.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const root = mkdtempSync(join(tmpdir(), "backup-src-"));
const bak = mkdtempSync(join(tmpdir(), "backup-dst-"));
const NOW = new Date("2026-11-07T12:00:00").getTime();
const src = join(root, "groups");
try {
  mkdirSync(join(src, "g-test-mem"), { recursive: true });
  writeFileSync(join(src, "g-test-mem", "MEMORY.md"), "- [2026-11-01] uid=100001 kind=事实 ok=1 :: 周六火锅\n");
  writeFileSync(join(src, "g-test-mem", "chat.jsonl"), '{"ts":1,"text":"hi"}\n');
  writeFileSync(join(src, ".bot.lock"), '{"pid":1}');

  const a = await snapshotGroups(src, { reason: "startup", backupDir: bak, now: NOW });
  ok("快照成功", a.ok === true && existsSync(a.dest), a.dest);
  ok("快照含群文件", existsSync(join(a.dest, "g-test-mem", "MEMORY.md")) && existsSync(join(a.dest, "g-test-mem", "chat.jsonl")), true);
  ok("锁文件不进快照", !existsSync(join(a.dest, ".bot.lock")), true);
  const manifest = JSON.parse(readFileSync(join(a.dest, "manifest.json"), "utf8"));
  ok("manifest 记录文件与哈希", manifest.files.length === 2 && manifest.files.every((f) => f.sha256), manifest.files.map((f) => f.path).join(","));

  // 删掉一个文件：哨兵报告缺失，且不自动重建
  rmSync(join(src, "g-test-mem", "chat.jsonl"), { force: true });
  const b = await snapshotGroups(src, { reason: "startup", backupDir: bak, now: NOW + 1000 });
  ok("哨兵报告缺失文件", b.missing?.includes("g-test-mem/chat.jsonl"), true);
  ok("缺失文件不被自动重建", !existsSync(join(src, "g-test-mem", "chat.jsonl")), true);

  // 清空一个原本非空的文件：哨兵报告 truncated
  writeFileSync(join(src, "g-test-mem", "MEMORY.md"), "");
  const c = await snapshotGroups(src, { reason: "startup", backupDir: bak, now: NOW + 2000 });
  ok("哨兵报告被清空文件", c.truncated?.includes("g-test-mem/MEMORY.md"), true);

  // 保留期：旧的快照目录被清掉，新的保留
  mkdirSync(join(bak, "2026-10-01_00-00-00-old"), { recursive: true });
  const d = await snapshotGroups(src, { reason: "daily", backupDir: bak, keepDays: 14, now: NOW + 3000 });
  ok("过期快照被清理", !existsSync(join(bak, "2026-10-01_00-00-00-old")), true);
  ok("新快照保留", existsSync(d.dest), true);

  // 数量上限：最多保留 maxSnapshots 份
  for (let i = 0; i < 5; i++) mkdirSync(join(bak, `2026-11-07_10-0${i}-00-x`), { recursive: true });
  await snapshotGroups(src, { reason: "daily", backupDir: bak, maxSnapshots: 3, now: NOW + 4000 });
  const kept = readdirSync(bak).filter((n) => /^\d{4}-\d{2}-\d{2}_/.test(n)).length;
  ok("快照数量按上限保留", kept <= 3, kept);

  // 整个 groups 目录消失：最严重场景也必须报告缺失，且不重建
  const src2 = join(root, "gone");
  mkdirSync(join(src2, "g"), { recursive: true });
  writeFileSync(join(src2, "g", "MEMORY.md"), "x");
  const bak2 = mkdtempSync(join(tmpdir(), "backup-dst2-"));
  await snapshotGroups(src2, { reason: "startup", backupDir: bak2, now: NOW });
  rmSync(src2, { recursive: true, force: true });
  const gone = await snapshotGroups(src2, { reason: "startup", backupDir: bak2, now: NOW + 1000 });
  ok("源目录整体消失也报告缺失", gone.skipped === "groups 目录不存在" && gone.missing?.includes("g/MEMORY.md"), JSON.stringify({ skipped: gone.skipped, missing: gone.missing }));
  ok("源目录消失后不自动重建", !existsSync(src2), true);
  rmSync(bak2, { recursive: true, force: true });

  // 备份目录误配到源目录内：拒绝，避免自我递归
  const src3 = join(root, "inside");
  mkdirSync(join(src3, "g"), { recursive: true });
  writeFileSync(join(src3, "g", "MEMORY.md"), "x");
  const bad = await snapshotGroups(src3, { reason: "x", backupDir: join(src3, "snap"), now: NOW });
  ok("备份目录位于源目录内被拒", bad.ok === false && bad.error?.includes("不能位于"), JSON.stringify(bad));
  ok("拒绝时不创建快照目录", !existsSync(join(src3, "snap")), true);
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(bak, { recursive: true, force: true });
}
console.log(fail === 0 ? "\n快照与哨兵全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
