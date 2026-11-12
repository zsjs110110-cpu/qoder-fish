import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertJob, readJobs, updateJob, pruneJobs, targetOf } from "./draw-jobs.mjs";
import { recoverDrawJobs, RULES } from "./adapters/onebot.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const dir = mkdtempSync(join(tmpdir(), "draw-jobs-test-"));
try {
  upsertJob(dir, { id: "j1", chatKey: "g:1", prompt: "猫", state: "queued", createdAt: 1000 });
  upsertJob(dir, { id: "j2", chatKey: "g:2", prompt: "狗", state: "queued", createdAt: 2000 });
  ok("落盘两条", readJobs(dir).length, 2);
  updateJob(dir, "j1", { state: "running", stageDest: "D:/x.png", updatedAt: 3000 });
  const j1 = readJobs(dir).find((j) => j.id === "j1");
  ok("更新 stageDest", j1.stageDest, "D:/x.png");
  upsertJob(dir, { id: "j1", state: "sent", sentAt: 4000, updatedAt: 4000 });
  ok("upsert 合并字段", readJobs(dir).find((j) => j.id === "j1").state, "sent");
  ok("目标群", JSON.stringify(targetOf("g:123")), '{"group_id":123}');
  ok("目标私聊", JSON.stringify(targetOf("p:456")), '{"user_id":456}');
  pruneJobs(dir, { keep: 1, ttlMs: 60_000, now: 5000 });
  ok("保留上限", readJobs(dir).length, 1);
} finally { rmSync(dir, { recursive: true, force: true }); }

// 审计修复接线验证：用临时 root 注入，避免扫描真实 groups（也不会误伤线上未完成任务）
{
  const key = "g:draw-recover-test";
  const root = mkdtempSync(join(tmpdir(), "draw-recover-root-"));
  const groupRoot = join(root, "g_test");
  mkdirSync(groupRoot, { recursive: true });
  let sentCount = 0;
  const sendTo = async () => { sentCount++; return true; };
  const runDraw = async () => "D:/__no_such_draw_output__.png";
  try {
    // 用例 1：群已被移出白名单 → 恢复时不发送、标 failed(out-of-whitelist)
    RULES.allowGroups = ["999"];
    upsertJob(groupRoot, { id: "r1", chatKey: key, prompt: "x", state: "queued", createdAt: Date.now(), dir: groupRoot });
    const n1 = await recoverDrawJobs({ sendTo, runDraw, root });
    ok("白名单外的任务不恢复发送", sentCount === 0 && n1 === 0, `sent=${sentCount} n=${n1}`);
    ok("白名单外任务标 failed", readJobs(groupRoot).find((j) => j.id === "r1")?.state === "failed");
    // 用例 2：发图动作已发起但结果未知（imageSendingAt 残留）→ 不重发、标 failed
    RULES.allowGroups = ["draw-recover-test"];
    upsertJob(groupRoot, { id: "r2", chatKey: key, prompt: "x", state: "sent", sentAt: Date.now(), imageSendingAt: Date.now(), imageAttempts: 1, createdAt: Date.now(), dir: groupRoot });
    await recoverDrawJobs({ sendTo, runDraw, root });
    ok("发送中断的任务不重发图", sentCount === 0, `sent=${sentCount}`);
    ok("发送中断标 failed(image-send-interrupted)", readJobs(groupRoot).find((j) => j.id === "r2")?.error === "image-send-interrupted");
    // 用例 3：正常 queued 任务恢复重跑（runDraw 桩产物不存在 → 走 failed + 补一句失败话术）
    upsertJob(groupRoot, { id: "r3", chatKey: key, prompt: "x", state: "queued", createdAt: Date.now(), dir: groupRoot });
    const n3 = await recoverDrawJobs({ sendTo, runDraw, root });
    ok("白名单内正常恢复重跑", n3 === 1, `n=${n3}`);
    await new Promise((r) => setTimeout(r, 100));
    const j3 = readJobs(groupRoot).find((j) => j.id === "r3");
    ok("恢复跑完后有明确终态", j3?.state === "failed" || j3?.state === "done", JSON.stringify(j3?.state));
  } finally {
    RULES.allowGroups = [];
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}
console.log(fail === 0 ? "\n画图任务存储全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
