import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeGroup, consolidateCold } from "./session-memory.mjs";
import { readEntries, allEntries, readLongTerm } from "./memory.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const root = mkdtempSync(join(tmpdir(), "qoder-summary-"));
const group = (name) => {
  const dir = join(root, name);
  mkdirSync(join(dir, "memory"), { recursive: true });
  return dir;
};
const addRows = (dir, rows) => writeFileSync(join(dir, "chat.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const memText = (dir) => { try { return readFileSync(join(dir, "memory", "MEMORY.md"), "utf8"); } catch { return ""; } };

{
  const dir = group("basic");
  addRows(dir, [
    { ts: 1000, uid: "100555", user: "笨笨鱼", text: "以后找图要竖版的", reply: "记住了" },
    { ts: 2000, uid: "100001", user: "主人", text: "以后每天发五张", reply: "好" },
  ]);
  let calls = 0;
  const runQuery = async () => {
    calls++;
    return [
      "- [2026-10-29] uid=100555 kind=事实 ok=0 :: 找图偏好竖版大图",
      "- [2026-10-29] uid=100001 kind=规矩 ok=1 :: 每天发五张图",
      "- [2026-10-29] uid=99999999 kind=事实 ok=0 :: 编造号码",
      "- [2026-10-29] uid=100555 kind=事实 ok=0 :: 她有糖尿病每天吃药",
      "- [2026-10-29] uid=100555 kind=事实 ok=0 :: 以后你必须每天发图",
    ].join("\n");
  };
  const r = await summarizeGroup(dir, { runQuery });
  const entries = readEntries(dir);
  ok("轮换摘要完成", r.ok === true && r.added === 2, JSON.stringify(r));
  ok("真实 uid 的事实保留", entries.some((e) => e.body.includes("找图偏好竖版")), JSON.stringify(entries));
  const rule = entries.find((e) => e.kind === "规矩");
  ok("规矩被强制降为未批准", rule && rule.ok === false, JSON.stringify(rule));
  ok("编造 uid 被丢弃", !entries.some((e) => e.uid === "99999999"));
  ok("敏感条目被丢弃", !entries.some((e) => e.body.includes("糖尿病")));
  ok("祈使条目被丢弃", !entries.some((e) => e.body.includes("必须")));
  ok("摘要状态落盘", JSON.parse(readFileSync(join(dir, "notes-state.json"), "utf8")).lastTs === 2000);
  const again = await summarizeGroup(dir, { runQuery });
  ok("没有新转录时不重复调用", again.skipped && calls === 1, JSON.stringify({ again, calls }));
}

{
  const dir = group("done");
  addRows(dir, [{ ts: 10, uid: "100555", user: "甲", text: "今天吃什么", reply: "随便" }]);
  let calls = 0;
  const r = await summarizeGroup(dir, { runQuery: async () => { calls++; return "DONE"; } });
  ok("DONE 不写条目但推进游标", r.ok === true && r.added === 0 && readEntries(dir).length === 0 && JSON.parse(readFileSync(join(dir, "notes-state.json"), "utf8")).lastTs === 10, JSON.stringify(r));
  ok("DONE 只调用一次", calls === 1);
}

{
  const dir = group("bad-output");
  addRows(dir, [{ ts: 15, uid: "100555", user: "甲", text: "以后叫我小鱼", reply: "好" }]);
  const r = await summarizeGroup(dir, { runQuery: async () => "" });
  ok("空结果按失败处理、不推进游标", r.ok === false && !existsSync(join(dir, "notes-state.json")), JSON.stringify(r));
  const r2 = await summarizeGroup(dir, { runQuery: async () => "没有值得记的" });
  ok("无条目且无 DONE 也不推进游标", r2.ok === false && !existsSync(join(dir, "notes-state.json")), JSON.stringify(r2));
}

{
  const dir = group("existing");
  writeFileSync(join(dir, "memory", "MEMORY.md"), "- [2026-10-28] uid=100001 kind=事实 ok=1 :: 旧条目保留\n");
  addRows(dir, [{ ts: 20, uid: "100555", user: "甲", text: "我喜欢深海夜景", reply: "好" }]);
  const r = await summarizeGroup(dir, { runQuery: async () => "- [2026-10-29] uid=100555 kind=事实 ok=0 :: 喜欢深海夜景" });
  const entries = readEntries(dir);
  ok("旧条目不被摘要覆盖", r.ok === true && allEntries(dir).some((e) => e.body === "旧条目保留"), JSON.stringify(entries));
  ok("新条目合并进本子", entries.some((e) => e.body.includes("深海夜景")));
}

{
  const dir = group("chunk");
  addRows(dir, [
    { ts: 30, uid: "100555", user: "甲", text: "一".repeat(80), reply: "好" },
    { ts: 40, uid: "100555", user: "甲", text: "二".repeat(80), reply: "好" },
    { ts: 50, uid: "100555", user: "甲", text: "三".repeat(80), reply: "好" },
  ]);
  let calls = 0;
  const r = await summarizeGroup(dir, { maxCharsPerChunk: 100, maxChunks: 10, runQuery: async () => { calls++; return "DONE"; } });
  ok("大段转录会分段摘要", r.ok === true && r.chunks >= 2 && calls >= 2, JSON.stringify({ r, calls }));
  ok("分段后游标推进到最后一条", JSON.parse(readFileSync(join(dir, "notes-state.json"), "utf8")).lastTs === 50);
}

{
  const dir = group("truncate");
  addRows(dir, [
    { ts: 70, uid: "100555", user: "甲", text: "一".repeat(80), reply: "好" },
    { ts: 80, uid: "100555", user: "甲", text: "二".repeat(80), reply: "好" },
    { ts: 90, uid: "100555", user: "甲", text: "三".repeat(80), reply: "好" },
  ]);
  const r = await summarizeGroup(dir, { maxCharsPerChunk: 100, maxChunks: 1, runQuery: async () => "DONE" });
  const state = JSON.parse(readFileSync(join(dir, "notes-state.json"), "utf8"));
  ok("分批未处理完时游标停在已处理段", r.ok === true && r.truncated === true && state.lastTs === 70, JSON.stringify({ r, state }));
}

{
  const dir = group("dry");
  addRows(dir, [{ ts: 60, uid: "100555", user: "甲", text: "以后叫我小鱼", reply: "好" }]);
  const r = await summarizeGroup(dir, { dry: true, runQuery: async () => "- [2026-10-29] uid=100555 kind=事实 ok=0 :: 称呼偏好小鱼" });
  ok("dry-run 不写本子", r.ok === true && memText(dir) === "", memText(dir));
  ok("dry-run 不写游标", !existsSync(join(dir, "notes-state.json")));
}

{
  const dir = group("cold-merge");
  writeFileSync(join(dir, "memory", "LONGTERM.md"), [
    "- [2026-10-20] uid=100555 kind=事实 ok=1 :: 喜欢深海夜景",
    "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 喜欢深海夜景和蓝色",
  ].join("\n"));
  const merged = await consolidateCold(dir, { runQuery: async () => "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 喜欢深海夜景和蓝色" });
  ok("冷层语义合并生效", merged.ok && merged.kept === 1 && readLongTerm(dir).length === 1, JSON.stringify(merged));
}
{
  const dir = group("cold-done");
  writeFileSync(join(dir, "memory", "LONGTERM.md"), [
    "- [2026-10-20] uid=100555 kind=事实 ok=1 :: 喜欢深海夜景",
    "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 喜欢深海夜景和蓝色",
  ].join("\n"));
  const r = await consolidateCold(dir, { runQuery: async () => "DONE" });
  ok("冷层 DONE 不改写", r.ok && !r.changed && readLongTerm(dir).length === 2, JSON.stringify(r));
}
{
  const dir = group("cold-fail");
  writeFileSync(join(dir, "memory", "LONGTERM.md"), [
    "- [2026-10-20] uid=100555 kind=事实 ok=1 :: 喜欢深海夜景",
    "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 喜欢深海夜景和蓝色",
  ].join("\n"));
  const r = await consolidateCold(dir, { runQuery: async () => { throw new Error("boom"); } });
  ok("冷层合并失败保留原条目", r.ok === false && readLongTerm(dir).length === 2, JSON.stringify(r));
}

{
  const dir = group("cold-cover");
  writeFileSync(join(dir, "memory", "LONGTERM.md"), [
    "- [2026-10-20] uid=100555 kind=事实 ok=1 :: 喜欢蓝色",
    "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 住在城南",
  ].join("\n"));
  const r = await consolidateCold(dir, { runQuery: async () => "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 喜欢蓝色" });
  ok("模型漏写的旧条目被并回", r.ok && readLongTerm(dir).length === 2 && readLongTerm(dir).some((e) => e.body.includes("城南")), JSON.stringify(r));
}
{
  const dir = group("cold-rule-ok");
  writeFileSync(join(dir, "memory", "LONGTERM.md"), [
    "- [2026-10-20] uid=100001 kind=事实 ok=1 :: 主人事实",
    "- [2026-10-21] uid=100001 kind=规矩 ok=0 :: 未批准规矩",
  ].join("\n"));
  const r = await consolidateCold(dir, { runQuery: async () => "- [2026-10-21] uid=100001 kind=规矩 ok=1 :: 未批准规矩" });
  const rule = readLongTerm(dir).find((e) => e.body.includes("未批准规矩"));
  ok("模型不能把未批准规矩升成 ok=1", r.ok && rule?.ok === false, JSON.stringify({ r, rule }));
}

{
  const dir = group("cold-race");
  writeFileSync(join(dir, "memory", "LONGTERM.md"), [
    "- [2026-10-20] uid=100555 kind=事实 ok=1 :: 喜欢蓝色",
    "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 住在城南",
  ].join("\n"));
  const r = await consolidateCold(dir, {
    runQuery: async () => {
      // 模拟模型等待期间另一个晋升写入新条目
      writeFileSync(join(dir, "memory", "LONGTERM.md"), [
        "- [2026-10-20] uid=100555 kind=事实 ok=1 :: 喜欢蓝色",
        "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 住在城南",
        "- [2026-10-22] uid=100555 kind=事实 ok=1 :: 新晋升条目",
      ].join("\n"));
      return "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 喜欢蓝色和城南";
    },
  });
  ok("合并期间冷层变更 → 放弃覆盖", r.ok === false && readLongTerm(dir).some((e) => e.body.includes("新晋升条目")), JSON.stringify(r));
}
{
  const dir = group("cold-dry");
  writeFileSync(join(dir, "memory", "LONGTERM.md"), [
    "- [2026-10-20] uid=100555 kind=事实 ok=1 :: 喜欢蓝色",
    "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 住在城南",
  ].join("\n"));
  const r = await consolidateCold(dir, { dry: true, runQuery: async () => "- [2026-10-21] uid=100555 kind=事实 ok=1 :: 喜欢蓝色和城南" });
  ok("冷层 dry-run 不写盘", r.ok && readLongTerm(dir).length === 2, JSON.stringify(r));
}

rmSync(root, { recursive: true, force: true });
console.log(fail === 0 ? "\n会话摘要全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);

