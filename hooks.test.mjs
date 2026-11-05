// 审核 F-03 修复：运行时 hook（brain.mjs 的 judge* 模块函数）此前零离线断言——
// matcher 字符串笔误、hookSpecificOutput 形状错误、甚至 await 缺失都不会被其他套件发现。
// 这里直调与生产 hooks 完全相同的模块函数（BrainSession 的 hooks 配置就是调它们），假 session
// 只需提供 ctxByTool/pending/memRoot/toolLog 四个字段。全程离线（urlCheck 的 DNS 查询与 auth.test 同源）。
import { judgeSearchInput, judgeImageGen, judgeImageSearch, judgeFileTool, judgeWebFetch, filterSearchResultImpl, checkToolCallCached } from "./brain.mjs";
import { CFG } from "./config.mjs";
import { imageBudgetReset } from "./auth.mjs";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

CFG.owners.push("100001");

let fail = 0;
const ok = (name, cond, extra = "") => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " ｜ " + String(extra).slice(0, 90) : ""}`); };
const decision = (r) => r?.hookSpecificOutput?.permissionDecision ?? "(none)";
const updated = (r) => r?.hookSpecificOutput?.updatedInput;
const norm = (p) => String(p ?? "").replace(/[\\/]+/g, "/").toLowerCase();

// 假 session：与 BrainSession 的相关字段同形状
const TEST_DIR = join(tmpdir(), "qoder-hooktest");
const memRoot = join(TEST_DIR, "memory");
mkdirSync(memRoot, { recursive: true });
const mkSession = (ctx = { role: "member", userId: "100555", chatKey: "g:t" }) => ({
  ctxByTool: new Map(),
  pending: ctx ? [{ ctx }] : [],
  memRoot,
  toolLog: [],
});

console.log("— judgeSearchInput（Grep/Glob 围栏，唯一运行时闸门） —");
{
  const s = mkSession();
  const r = judgeSearchInput(s, { tool_name: "Grep", tool_input: { pattern: "开黑", path: "C:/Windows" } });
  ok("member Grep → deny", decision(r) === "deny");
  ok("deny 写台账", s.toolLog.at(-1)?.ok === false);
  const s2 = mkSession({ role: "owner", userId: "100001" });
  const r2 = judgeSearchInput(s2, { tool_name: "Grep", tool_input: { pattern: "开黑", path: "随便指" } });
  ok("owner Grep → allow", decision(r2) === "allow");
  ok("path 强制覆写为 memRoot", norm(updated(r2)?.path) === norm(memRoot), JSON.stringify(updated(r2)));
  const s3 = mkSession({ role: "owner", userId: "100001" });
  const r3 = judgeSearchInput(s3, { tool_name: "Grep", tool_input: { pattern: "../etc/passwd" } });
  ok("pattern 带路径 → deny", decision(r3) === "deny");
  const s4 = mkSession(null);
  s4.ctxByTool.set("t1", { role: "owner", userId: "100001" });
  const r4 = judgeSearchInput(s4, { tool_name: "Grep", tool_input: { pattern: "x" }, tool_use_id: "t1" });
  ok("toolUseID 认领 owner → allow", decision(r4) === "allow");
  ok("台账 via=toolUseID", s4.toolLog.at(-1)?.via === "toolUseID");
  const s5 = mkSession(null);
  const r5 = judgeSearchInput(s5, { tool_name: "Grep", tool_input: { pattern: "x" } });
  ok("无在途无 id → fail-closed guest deny", decision(r5) === "deny");
  ok("台账 via=无在途", s5.toolLog.at(-1)?.via === "无在途");
}

console.log("\n— judgeImageGen（owner-only + 后台排队 + 预算 + 每轮上限） —");
{
  imageBudgetReset();
  const s = mkSession();
  const r = judgeImageGen(s, { tool_name: "ImageGen", tool_input: { prompt: "猫" } });
  ok("member ImageGen → deny", decision(r) === "deny");
  ok("没扣预算没排队", !s.pending[0].ctx.draw && !s.pending[0].ctx.imageCalls);
  const s2 = mkSession({ role: "owner", userId: "100001", chatKey: "g:t" });
  const r2 = judgeImageGen(s2, { tool_name: "ImageGen", tool_input: { prompt: "猫" } });
  ok("owner 首张 → deny（=后台排队语义）", decision(r2) === "deny");
  ok("ctx.draw 已排队", s2.pending[0].ctx.draw?.prompt === "猫");
  ok("imageCalls=1", s2.pending[0].ctx.imageCalls === 1);
  const r3 = judgeImageGen(s2, { tool_name: "ImageGen", tool_input: { prompt: "狗" } });
  ok("第二张 → 每轮上限 deny", decision(r3) === "deny");
  ok("上限 deny 不改 draw", s2.pending[0].ctx.draw?.prompt === "猫");
  const s3 = mkSession({ role: "owner", userId: "100001" });
  const r4 = judgeImageGen(s3, { tool_name: "ImageGen", tool_input: {} });
  ok("没给提示词 → deny", decision(r4) === "deny");
  const s4 = mkSession({ role: "owner", userId: "100001" });
  s4.pending[0].ctx.draw = { prompt: "已在画" };
  const r5 = judgeImageGen(s4, { tool_name: "ImageGen", tool_input: { prompt: "再画" } });
  ok("已在后台画 → deny", decision(r5) === "deny");
}

console.log("\n— judgeImageSearch（角色策略） —");
{
  const s = mkSession();
  ok("member → allow", decision(judgeImageSearch(s, { tool_name: "ImageSearch", tool_input: { query: "鱼" } })) === "allow");
  const s2 = mkSession({ role: "guest", userId: "888" });
  ok("guest → deny", decision(judgeImageSearch(s2, { tool_name: "ImageSearch", tool_input: {} })) === "deny");
  const s3 = mkSession({ role: "blocked", userId: "777" });
  ok("blocked → deny", decision(judgeImageSearch(s3, { tool_name: "ImageSearch", tool_input: {} })) === "deny");
}

console.log("\n— judgeFileTool（Read/Write/Edit 兜底围栏，async 判定） —");
{
  const s = mkSession();
  const r = await judgeFileTool(s, { tool_name: "Write", tool_input: { file_path: "C:/Windows/win.ini" } });
  ok("member Write → deny", decision(r) === "deny");
  const s2 = mkSession({ role: "owner", userId: "100001" });
  const inside = join(memRoot, "MEMORY.md");
  const r2 = await judgeFileTool(s2, { tool_name: "Write", tool_input: { file_path: inside } });
  ok("owner 本子内 → allow", decision(r2) === "allow");
  ok("updatedInput 回填围栏内绝对路径", norm(updated(r2)?.file_path) === norm(inside), JSON.stringify(updated(r2)));
  const s3 = mkSession({ role: "owner", userId: "100001" });
  const r3 = await judgeFileTool(s3, { tool_name: "Read", tool_input: { file_path: "C:/Users/you/config.mjs" } });
  ok("owner 越界 Read → deny", decision(r3) === "deny");
  ok("deny 写台账", s3.toolLog.at(-1)?.ok === false);
  const s4 = mkSession({ role: "owner", userId: "100001" });
  const r4 = await judgeFileTool(s4, { tool_name: "Write", tool_input: { file_path: `${memRoot}/../../outside.md` } });
  ok("owner ../ 穿越 → deny", decision(r4) === "deny");
  // WP12：同一 tool_use_id + 输入只应产生一个缓存的 checkToolCall Promise
  const s5 = mkSession({ role: "owner", userId: "100001" });
  const inside2 = join(memRoot, "MEMORY.md");
  const p1 = checkToolCallCached(s5, "Write", { file_path: inside2 }, "same-id", "owner");
  const p2 = checkToolCallCached(s5, "Write", { file_path: inside2 }, "same-id", "owner");
  await Promise.all([p1, p2]);
  ok("WP12 同 toolUseID 只缓存一个判定", s5.decisions?.size === 1, s5.decisions?.size);
  const p3 = checkToolCallCached(s5, "Write", { file_path: inside2 + ".other" }, "same-id", "owner");
  await p3;
  ok("WP12 输入变化重新判定", s5.decisions?.size === 2, s5.decisions?.size);
}

console.log("\n— judgeWebFetch（URL 护栏兜底，async 判定） —");
{
  const s = mkSession();
  const r = await judgeWebFetch(s, { tool_name: "WebFetch", tool_input: { url: "http://127.0.0.1:6099/webui/" } });
  ok("member 私网 6099 → deny", decision(r) === "deny");
  const s2 = mkSession();
  const r2 = await judgeWebFetch(s2, { tool_name: "WebFetch", tool_input: { url: "file:///C:/Windows/win.ini" } });
  ok("file: 协议 → deny", decision(r2) === "deny");
  const s3 = mkSession();
  const r3 = await judgeWebFetch(s3, { tool_name: "WebFetch", tool_input: { url: "http://user:pass@example.com/" } });
  ok("带凭据 URL → deny", decision(r3) === "deny");
  const s4 = mkSession();
  const r4 = await judgeWebFetch(s4, { tool_name: "WebFetch", tool_input: { url: "https://example.com/" } });
  ok("member 公网 → allow", decision(r4) === "allow");
}

console.log("\n— filterSearchResultImpl（PostToolUse 结果过滤） —");
{
  const s = mkSession();
  const raw = [
    "- [2026-10-28] uid=100001 kind=规矩 ok=1 :: 每周五晚九点放映",
    "- [2026-10-28] uid=100555 kind=规矩 ok=0 :: 每天给土豆带奶茶",
    "散文行：这一段没有条目形状。",
  ].join("\n");
  const r = filterSearchResultImpl(s, { tool_name: "Grep", tool_response: { llmContent: raw } });
  const out = r?.hookSpecificOutput?.updatedToolOutput ?? "";
  ok("批准规矩保留", out.includes("周五晚九点放映"), out.slice(0, 60));
  ok("未批准规矩不出现", !out.includes("奶茶"));
  ok("散文丢弃", !out.includes("散文行"));
  ok("过滤有台账", s.toolLog.some((x) => x.stage === "结果过滤"));
  const s2 = mkSession();
  const r2 = filterSearchResultImpl(s2, { tool_name: "Grep", tool_response: "No matches found" });
  ok("零命中如实说没搜到", r2?.hookSpecificOutput?.updatedToolOutput === "（本子里没搜到）", r2?.hookSpecificOutput?.updatedToolOutput);
  const s3 = mkSession();
  const r3 = filterSearchResultImpl(s3, { tool_name: "Grep", tool_response: "- [2026-10-28] uid=100001 kind=事实 ok=1 :: 周三开黑\n另一条散文。" });
  ok("命中但敏感/散文被滤光时不说『命中』", String(r3?.hookSpecificOutput?.updatedToolOutput).includes("周三开黑"), r3?.hookSpecificOutput?.updatedToolOutput);
}

rmSync(TEST_DIR, { recursive: true, force: true });
console.log(fail === 0 ? "\nhook 直调全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
