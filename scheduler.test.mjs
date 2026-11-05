// 定时任务核心（不连模型、不发 QQ）：存储/配额/重复规则/到点判定/tick 执行/角色闸门。
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addJob, listJobs, cancelJob, isDue, readState, scanStates, startScheduler, dayKey, parseTime, parseRepeat, repeatLabel } from "./scheduler.mjs";
import { judgeScheduleTools } from "./brain.mjs";

let fail = 0;
const ok = (name, cond, extra = "") => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " ｜ " + String(extra).slice(0, 100) : ""}`); };
const decision = (r) => r?.hookSpecificOutput?.permissionDecision ?? "(none)";

const root = mkdtempSync(join(tmpdir(), "sched-test-"));
const mkdir = (name) => { const d = join(root, name); mkdirSync(d, { recursive: true }); return d; };
const CHAT = "g:111";
const now = new Date(2026, 10, 3, 12, 0, 0);   // 2026-11-03 12:00 本地时间

console.log("— 解析与校验 —");
ok("HH:MM 规范化", parseTime("9:05") === "09:05", true);
ok("24:00 不认", parseTime("24:00") === null, true);
ok("daily 解析", JSON.stringify(parseRepeat("daily")) === '{"kind":"daily"}', true);
ok("weekdays 解析", JSON.stringify(parseRepeat("weekdays")) === '{"kind":"weekdays"}', true);
ok("weekly:0 解析", JSON.stringify(parseRepeat("weekly:0")) === '{"kind":"weekly","day":0}', true);
ok("未知重复规则拒绝", parseRepeat("monthly") === null, true);

console.log("\n— 创建：配额（非主人每人每天 1 个，跨会话合计；主人不限） —");
const dirQuota = mkdir("g_quota-x");
let r = addJob(dirQuota, { chatKey: CHAT, time: "12:30", repeat: "daily", prompt: "提醒大家吃饭", createdBy: "222", createdByName: "阿哲", role: "member", now, quotaRoot: root });
ok("member 第一次能挂", r.ok, r.error);
ok("任务回到 daily", r.job?.repeat?.kind === "daily", true);
r = addJob(dirQuota, { chatKey: CHAT, time: "18:00", repeat: "daily", prompt: "提醒下班", createdBy: "222", createdByName: "阿哲", role: "member", now, quotaRoot: root });
ok("member 同一天第二次被拦", !r.ok && r.error.includes("每天只能挂一个"), r.error);
r = addJob(dirQuota, { chatKey: CHAT, time: "08:00", repeat: "weekdays", prompt: "上班打卡", createdBy: "333", createdByName: "老王", role: "member", now, quotaRoot: root });
ok("另一个 member 不受影响", r.ok, r.error);
const dirQuota2 = mkdir("g_quota2-x");
r = addJob(dirQuota2, { chatKey: "g:999", time: "20:00", repeat: "daily", prompt: "换个群再挂", createdBy: "222", createdByName: "阿哲", role: "member", now, quotaRoot: root });
ok("配额跨会话合计（换群也拦）", !r.ok && r.error.includes("每天只能挂一个"), r.error);
r = addJob(dirQuota, { chatKey: CHAT, time: "23:00", repeat: "daily", prompt: "主人自己的提醒", createdBy: "100001", createdByName: "主人", role: "owner", now, quotaRoot: root });
ok("owner 不受每日配额限制", r.ok, r.error);
r = addJob(dirQuota, { chatKey: CHAT, time: "23:05", repeat: "daily", prompt: "主人第二条", createdBy: "100001", createdByName: "主人", role: "owner", now, quotaRoot: root });
ok("owner 可以挂第二条", r.ok, r.error);
const nextDay = new Date(2026, 10, 4, 12, 0, 0);
r = addJob(dirQuota, { chatKey: CHAT, time: "12:30", repeat: "daily", prompt: "第二天再挂", createdBy: "222", createdByName: "阿哲", role: "member", now: nextDay, quotaRoot: root });
ok("跨天后 member 额度恢复", r.ok, r.error);
// B1：取消任务后 quota 还在，不能靠"建了取消再建"绕过当天配额
const dirB1 = mkdir("g_b1-x");
const b1 = addJob(dirB1, { chatKey: "g:b1", time: "12:30", prompt: "建完就取消", createdBy: "777", role: "member", now, quotaRoot: root });
ok("B1 初始能建", b1.ok, b1.error);
ok("B1 取消成功", cancelJob(dirB1, b1.job.id, { createdBy: "777", role: "member" }).ok, true);
const dirB1b = mkdir("g_b1b-x");
const b1again = addJob(dirB1b, { chatKey: "g:b1b", time: "13:00", prompt: "换个会话重建", createdBy: "777", role: "member", now, quotaRoot: root });
ok("B1 取消后当天再建仍被拦", !b1again.ok && b1again.error.includes("每天只能挂一个"), b1again.error);

console.log("\n— 创建：参数与单会话上限 —");
const dirArgs = mkdir("g_args-x");
ok("坏时间被拒", !addJob(dirArgs, { chatKey: CHAT, time: "25:00", prompt: "x", createdBy: "100001", role: "owner", now }).ok);
ok("坏重复规则被拒", !addJob(dirArgs, { chatKey: CHAT, time: "09:00", repeat: "monthly", prompt: "x", createdBy: "100001", role: "owner", now }).ok);
ok("空内容被拒", !addJob(dirArgs, { chatKey: CHAT, time: "09:00", prompt: "   ", createdBy: "100001", role: "owner", now }).ok);
ok("guest 被拒", !addJob(dirArgs, { chatKey: CHAT, time: "09:00", prompt: "x", createdBy: "555", role: "guest", now }).ok);
ok("超长内容截到 200 字", (() => { const j = addJob(dirArgs, { chatKey: CHAT, time: "09:00", prompt: "啊".repeat(300), createdBy: "100001", role: "owner", now }).job; return [...j.prompt].length === 200; })(), true);
const dirLimit = mkdir("g_limit-x");
for (let i = 0; i < 5; i++) addJob(dirLimit, { chatKey: CHAT, time: "09:00", prompt: `补位${i}`, createdBy: "100001", role: "owner", now });
const last = addJob(dirLimit, { chatKey: CHAT, time: "10:00", prompt: "第六条", createdBy: "100001", role: "owner", now });
ok("单会话最多 5 个（补满后拒绝）", !last.ok && last.error.includes("最多挂 5 个"), last.error);

console.log("\n— 列表与取消权限 —");
const dirList = mkdir("g_list-x");
const a1 = addJob(dirList, { chatKey: CHAT, time: "12:30", repeat: "daily", prompt: "阿哲的提醒", createdBy: "444", createdByName: "小刘", role: "member", now, quotaRoot: root }).job;
const a2 = addJob(dirList, { chatKey: CHAT, time: "08:00", repeat: "weekdays", prompt: "老王的提醒", createdBy: "555", createdByName: "老赵", role: "member", now, quotaRoot: root }).job;
const a3 = addJob(dirList, { chatKey: CHAT, time: "23:00", repeat: "daily", prompt: "主人的提醒", createdBy: "100001", createdByName: "主人", role: "owner", now, quotaRoot: root }).job;
ok("member 只看到自己的", listJobs(dirList, { createdBy: "444", role: "member" }).length === 1, true);
ok("owner 看到全部 3 条", listJobs(dirList, { createdBy: "100001", role: "owner" }).length === 3, true);
const denyCancel = cancelJob(dirList, a2.id, { createdBy: "444", role: "member" });
ok("member 不能取消别人的", !denyCancel.ok && denyCancel.error.includes("只能取消自己"), denyCancel.error);
ok("member 能取消自己的", cancelJob(dirList, a1.id, { createdBy: "444", role: "member" }).ok, true);
ok("owner 能取消任何人的", cancelJob(dirList, a2.id, { createdBy: "100001", role: "owner" }).ok, true);
ok("a3 仍是主人的", a3.createdBy === "100001", true);

console.log("\n— 到点判定 —");
const daily = { time: "12:00", repeat: { kind: "daily" }, enabled: true, lastRunDay: "" };
ok("正好到点", isDue(daily, new Date(2026, 10, 3, 12, 0, 0)) === true, true);
ok("窗口内 5 分钟", isDue(daily, new Date(2026, 10, 3, 12, 5, 0)) === true, true);
ok("窗口外 11 分钟", isDue(daily, new Date(2026, 10, 3, 12, 11, 0)) === false, true);
ok("没到点不触发", isDue(daily, new Date(2026, 10, 3, 11, 59, 0)) === false, true);
ok("同一天已跑过不重复", isDue({ ...daily, lastRunDay: dayKey(new Date(2026, 10, 3)) }, new Date(2026, 10, 3, 12, 1, 0)) === false, true);
ok("停用不触发", isDue({ ...daily, enabled: false }, new Date(2026, 10, 3, 12, 0, 0)) === false, true);
const sat = new Date(2026, 10, 7, 12, 0, 0);   // 2026-11-07 周六
ok("工作日任务周末不触发", isDue({ time: "12:00", repeat: { kind: "weekdays" }, enabled: true }, sat) === false, true);
ok("周任务错天不触发", isDue({ time: "12:00", repeat: { kind: "weekly", day: sat.getDay() === 3 ? 4 : 3 }, enabled: true }, sat) === false, true);
ok("周任务对天触发", isDue({ time: "12:00", repeat: { kind: "weekly", day: sat.getDay() }, enabled: true }, sat) === true, true);

console.log("\n— 一次性任务 —");
ok("once 解析", JSON.stringify(parseRepeat("once")) === '{"kind":"once"}', true);
const dirOnce = mkdir("g_once-x");
ok("once 缺日期被拒", !addJob(dirOnce, { chatKey: "g:once", time: "12:30", repeat: "once", prompt: "x", createdBy: "100001", role: "owner", now }).ok);
ok("once 非法日期被拒", !addJob(dirOnce, { chatKey: "g:once", time: "12:30", repeat: "once", date: "2026-02-30", prompt: "x", createdBy: "100001", role: "owner", now }).ok);
ok("once 过去日期被拒", !addJob(dirOnce, { chatKey: "g:once", time: "12:30", repeat: "once", date: "2026-11-02", prompt: "x", createdBy: "100001", role: "owner", now }).ok);
const onceJob = addJob(dirOnce, { chatKey: "g:once", time: "12:30", repeat: "once", date: "2026-11-04", prompt: "一次性提醒", createdBy: "100001", createdByName: "主人", role: "owner", now }).job;
ok("once 未来日期能建", Boolean(onceJob) && onceJob.date === "2026-11-04", true);
ok("once 标签写明日期", repeatLabel(onceJob).includes("仅一次 2026-11-04"), true);
ok("once 当天到点", isDue(onceJob, new Date(2026, 10, 4, 12, 30)) === true, true);
ok("once 错日不触发", isDue(onceJob, new Date(2026, 10, 5, 12, 30)) === false, true);
ok("once 已经跑过不重复", isDue({ ...onceJob, lastRunDay: "2026-11-04" }, new Date(2026, 10, 4, 12, 31)) === false, true);
// 刚过点建的一次性任务应当能触发（比如“现在提醒我”）
const justPast = new Date(2026, 10, 3, 12, 31, 0);
const onceNow = addJob(dirOnce, { chatKey: "g:once", time: "12:30", repeat: "once", date: "2026-11-03", prompt: "现在提醒", createdBy: "100001", role: "owner", now: justPast }).job;
ok("once 刚过点建仍可触发", isDue(onceNow, justPast) === true, true);
const onceRoot = mkdtempSync(join(tmpdir(), "sched-once-"));
const onceDir = join(onceRoot, "g_once2-x");
mkdirSync(onceDir, { recursive: true });
addJob(onceDir, { chatKey: "g:once2", time: "12:30", repeat: "once", date: "2026-11-04", prompt: "只跑一次", createdBy: "100001", role: "owner", now });
const onceSent = [];
const onceSched = startScheduler({ root: onceRoot, askFn: async () => ({ text: "一次性到了" }), send: async (k, m) => { onceSent.push(m); return true; }, nowFn: () => new Date(2026, 10, 4, 12, 30), log: () => {} });
await onceSched.tick();
ok("once 到点执行并发送", onceSent.length === 1 && onceSent[0].includes("一次性"), JSON.stringify(onceSent));
ok("once 执行后从任务表移除", readState(onceDir).jobs.length === 0, true);

console.log("\n— 阻断修复：过期清理 / 逐任务标记 / once 失败保留 —");
// 1) 错过的一次性任务在窗口外自动清理，不再占 5 个名额
const expRoot = mkdtempSync(join(tmpdir(), "sched-exp-"));
const expDir = join(expRoot, "g_exp-x");
mkdirSync(expDir, { recursive: true });
addJob(expDir, { chatKey: "g:exp", time: "12:30", repeat: "once", date: "2026-11-03", prompt: "错过的一次性", createdBy: "100001", role: "owner", now });
const expLogs = [];
let expSent = 0;
const expSched = startScheduler({ root: expRoot, askFn: async () => ({ text: "x" }), send: async () => { expSent++; return true; }, nowFn: () => new Date(2026, 10, 3, 12, 45), log: (m) => expLogs.push(m) });
await expSched.tick();
ok("过期 once 被清理", readState(expDir).jobs.length === 0, true);
ok("过期 once 不执行", expSent === 0, true);
ok("过期清理有日志", expLogs.some((m) => m.includes("已过期未执行")), true);

// 2) 同分钟多任务：前一个跑过窗口后，后面的任务不被预标记
const markRoot = mkdtempSync(join(tmpdir(), "sched-mark-"));
const markDir = join(markRoot, "g_mark-x");
mkdirSync(markDir, { recursive: true });
let fakeNow = new Date(2026, 10, 3, 12, 0, 0);
const mA = addJob(markDir, { chatKey: "g:mark", time: "12:00", repeat: "daily", prompt: "A", createdBy: "100001", role: "owner", now: fakeNow }).job;
const mB = addJob(markDir, { chatKey: "g:mark", time: "12:00", repeat: "daily", prompt: "B", createdBy: "100001", role: "owner", now: fakeNow }).job;
let markSent = 0;
const markSched = startScheduler({
  root: markRoot,
  nowFn: () => fakeNow,
  send: async () => { markSent++; return true; },
  log: () => {},
  askFn: async () => { fakeNow = new Date(2026, 10, 3, 12, 11); return { text: "A 跑完了" }; },
});
await markSched.tick();
const markAfter = readState(markDir).jobs;
ok("只执行了 A", markSent === 1, true);
ok("A 已标记", markAfter.find((j) => j.id === mA.id)?.lastRunDay === "2026-11-03", true);
ok("B 过窗后未被标记（不再静默作废）", markAfter.find((j) => j.id === mB.id)?.lastRunDay === "", true);

// 3) once 失败保留：第一次 dropped 保留并清 lastRunDay；第二次达到上限才放弃
const retRoot = mkdtempSync(join(tmpdir(), "sched-ret-"));
const retDir = join(retRoot, "g_ret-x");
mkdirSync(retDir, { recursive: true });
addJob(retDir, { chatKey: "g:ret", time: "12:30", repeat: "once", date: "2026-11-03", prompt: "失败保留", createdBy: "100001", role: "owner", now });
const retLogs = [];
const retSched = startScheduler({ root: retRoot, askFn: async () => ({ dropped: "stale", text: "" }), send: async () => true, nowFn: () => new Date(2026, 10, 3, 12, 30), log: (m) => retLogs.push(m) });
await retSched.tick();
const ret1 = readState(retDir).jobs[0];
ok("第一次失败后任务保留", readState(retDir).jobs.length === 1, true);
ok("第一次失败清 lastRunDay 以便重试", ret1?.lastRunDay === "", true);
ok("第一次失败记 attempts=1", ret1?.attempts === 1, true);
await retSched.tick();
ok("第二次失败达到上限后放弃", readState(retDir).jobs.length === 0, true);
ok("放弃有日志", retLogs.some((m) => m.includes("已放弃")), true);

console.log("\n— tick 执行（注入 ask/send，不碰模型与 QQ） —");
const tickRoot = mkdtempSync(join(tmpdir(), "sched-tick-"));
const tickDir = join(tickRoot, "g_222-x");
mkdirSync(tickDir, { recursive: true });
const tickChat = "g:222";
const tickNow = new Date(2026, 10, 3, 12, 0, 0);
addJob(tickDir, { chatKey: tickChat, time: "12:00", repeat: "daily", prompt: "提醒主人吃米饭", createdBy: "333", createdByName: "老王", role: "member", now: tickNow });
const sent = [];
const asked = [];
const logs = [];
const sched = startScheduler({
  root: tickRoot,
  askFn: async (args) => { asked.push(args); return { text: "十二点啦，该吃米饭了" }; },
  send: async (chatKey, message) => { sent.push({ chatKey, message }); return true; },
  nowFn: () => tickNow,
  log: (m) => logs.push(m),
});
await sched.tick();
ok("到点触发一次 ask", asked.length === 1, true);
ok("执行身份是创建者", asked[0]?.actor?.userId === "333", true);
ok("执行轮标为点名", asked[0]?.runtime?.addressed, true);
ok("发出生成的内容", sent.length >= 1 && sent[0].message.includes("米饭"), JSON.stringify(sent));
ok("lastRunDay 已落盘", readState(tickDir).jobs[0].lastRunDay === dayKey(tickNow), true);
await sched.tick();
ok("同一天第二次 tick 不重复触发", asked.length === 1, true);

addJob(tickDir, { chatKey: tickChat, time: "12:00", repeat: "daily", prompt: "另一个任务", createdBy: "100001", role: "owner", now: tickNow });
const sched2 = startScheduler({ root: tickRoot, askFn: async () => ({ text: "好" }), send: async () => false, nowFn: () => new Date(2026, 10, 4, 12, 0, 0), log: (m) => logs.push(m) });
await sched2.tick();
ok("发送被拒时记录日志且不崩", logs.some((m) => m.includes("发送被拒绝")), true);
const sched3 = startScheduler({ root: tickRoot, askFn: async () => { throw new Error("boom"); }, send: async () => true, nowFn: () => new Date(2026, 10, 5, 12, 0, 0), log: (m) => logs.push(m) });
await sched3.tick();
ok("ask 抛错不崩，记执行失败", logs.some((m) => m.includes("执行失败")), true);
let fallbackSent = 0;
const sched4 = startScheduler({ root: tickRoot, askFn: async () => ({ text: "", error: "timeout", turn: { phase: "fallback" } }), send: async () => { fallbackSent++; return true; }, nowFn: () => new Date(2026, 10, 6, 12, 0, 0), log: (m) => logs.push(m) });
await sched4.tick();
ok("失败/空结果不发给群", fallbackSent === 0, true);
ok("失败被跳过时留日志", logs.some((m) => m.includes("失败结果不用于定时任务")), true);

console.log("\n— 坏文件与扫描 —");
const brokenDir = join(tickRoot, "g_broken-x");
mkdirSync(brokenDir, { recursive: true });
writeFileSync(join(brokenDir, "schedule.json"), "{not json");
ok("scanStates 不因坏 JSON 崩溃", scanStates(tickRoot).length >= 1, true);
const corruptDir = join(root, "g_corrupt-x");
mkdirSync(corruptDir, { recursive: true });
writeFileSync(join(corruptDir, "schedule.json"), "{bad json");
const cr = addJob(corruptDir, { chatKey: "g:corrupt", time: "12:30", prompt: "x", createdBy: "100001", role: "owner", now });
ok("B3 坏文件拒绝写入", !cr.ok && cr.error.includes("坏了"), cr.error);
ok("B3 坏文件内容未被覆盖", readFileSync(join(corruptDir, "schedule.json"), "utf8").startsWith("{bad json"), true);

console.log("\n— B2：执行期间的新建/取消不被快照覆盖 —");
const b2Root = mkdtempSync(join(tmpdir(), "sched-b2-"));
const b2Dir = join(b2Root, "g_b2-x");
mkdirSync(b2Dir, { recursive: true });
const b2Now = new Date(2026, 10, 3, 12, 0, 0);
const A = addJob(b2Dir, { chatKey: "g:b2", time: "12:00", prompt: "A", createdBy: "100001", role: "owner", now: b2Now }).job;
const B = addJob(b2Dir, { chatKey: "g:b2", time: "12:00", prompt: "B", createdBy: "100001", role: "owner", now: b2Now }).job;
const b2Sent = [];
let firstRun = true;
const b2 = startScheduler({
  root: b2Root,
  nowFn: () => b2Now,
  send: async (k, m) => { b2Sent.push(m); return true; },
  log: () => {},
  askFn: async () => {
    if (firstRun) {
      firstRun = false;
      // A 执行期间：新建 C，并取消 B
      addJob(b2Dir, { chatKey: "g:b2", time: "13:00", prompt: "C-执行期间新建", createdBy: "100001", role: "owner", now: b2Now });
      cancelJob(b2Dir, B.id, { createdBy: "100001", role: "owner" });
    }
    return { text: "跑完了" };
  },
});
await b2.tick();
const afterB2 = readState(b2Dir).jobs;
ok("B2 执行期间新建的任务还在", afterB2.some((j) => j.prompt === "C-执行期间新建"), JSON.stringify(afterB2.map((j) => j.prompt)));
ok("B2 执行期间被取消的任务已消失", !afterB2.some((j) => j.id === B.id), true);
ok("B2 只跑了 A（B 已被取消）", b2Sent.length === 1, JSON.stringify(b2Sent));

console.log("\n— ready=false 与排队丢弃 —");
const rdyRoot = mkdtempSync(join(tmpdir(), "sched-rdy-"));
const rdyDir = join(rdyRoot, "g_rdy-x");
mkdirSync(rdyDir, { recursive: true });
addJob(rdyDir, { chatKey: "g:rdy", time: "12:00", prompt: "不该跑", createdBy: "100001", role: "owner", now: b2Now });
let rdyAsked = 0;
const rdy = startScheduler({ root: rdyRoot, ready: () => false, askFn: async () => { rdyAsked++; return { text: "x" }; }, send: async () => true, nowFn: () => b2Now, log: () => {} });
await rdy.tick();
ok("ready=false 整轮不执行", rdyAsked === 0, true);
ok("ready=false 不写 lastRunDay", readState(rdyDir).jobs[0].lastRunDay === "", true);
const dropRoot = mkdtempSync(join(tmpdir(), "sched-drop-"));
const dropDir = join(dropRoot, "g_drop-x");
mkdirSync(dropDir, { recursive: true });
addJob(dropDir, { chatKey: "g:drop", time: "12:00", prompt: "排队", createdBy: "100001", role: "owner", now: b2Now });
let dropSent = 0;
const dropLogs = [];
const drop = startScheduler({ root: dropRoot, askFn: async () => ({ dropped: "stale", text: "" }), send: async () => { dropSent++; return true; }, nowFn: () => b2Now, log: (m) => dropLogs.push(m) });
await drop.tick();
ok("排队过期的定时任务不发", dropSent === 0, true);
ok("排队过期有日志", dropLogs.some((m) => m.includes("排队过期")), true);

console.log("\n— 审计其余建议：畸形表/配额/预检/doneAt —");
const badShapeDir = join(root, "g_badshape-x");
mkdirSync(badShapeDir, { recursive: true });
writeFileSync(join(badShapeDir, "schedule.json"), JSON.stringify({ jobs: [null], quota: {} }));
const badShape = readState(badShapeDir);
ok("jobs:[null] 不崩且标 corrupt", badShape.corrupt === true && badShape.jobs.length === 0, true);
ok("畸形任务表拒绝新建", !addJob(badShapeDir, { chatKey: "g:badshape", time: "12:30", prompt: "x", createdBy: "100001", role: "owner", now }).ok, true);
const qfDir = mkdir("g_qf-x");
const qf = addJob(qfDir, { chatKey: "g:qf", time: "12:30", prompt: "x", createdBy: "888", role: "member", now, quotaRoot: root });
ok("有损坏任务表时非主人新建 fail-closed", !qf.ok && qf.error.includes("任务表损坏"), qf.error);
ok("doneAt 任务不再判定到点", isDue({ ...onceJob, doneAt: Date.now() }, new Date(2026, 10, 4, 12, 30)) === false, true);

// 投递预检：不可投递（禁言/白名单/额度）时不调模型、不标记
const cdRoot = mkdtempSync(join(tmpdir(), "sched-cd-"));
const cdDir = join(cdRoot, "g_cd-x");
mkdirSync(cdDir, { recursive: true });
addJob(cdDir, { chatKey: "g:cd", time: "12:00", repeat: "once", date: "2026-11-03", prompt: "预检", createdBy: "100001", role: "owner", now });
let cdAsked = 0;
const cdLogs = [];
const cdSched = startScheduler({
  root: cdRoot,
  nowFn: () => new Date(2026, 10, 3, 12, 0, 0),
  canDeliver: () => ({ ok: false, reason: "本号禁言中" }),
  askFn: async () => { cdAsked++; return { text: "x" }; },
  send: async () => true,
  log: (m) => cdLogs.push(m),
});
await cdSched.tick();
ok("不可投递时不调模型", cdAsked === 0, true);
ok("不可投递时不标记 lastRunDay", readState(cdDir).jobs[0]?.lastRunDay === "", true);
ok("不可投递有原因日志", cdLogs.some((m) => m.includes("暂不可投递") && m.includes("禁言")), true);

console.log("\n— 角色闸门（PreToolUse） —");
const mkSession = (ctx) => ({ ctxByTool: new Map(), pending: ctx ? [{ ctx }] : [], memRoot: tickDir, toolLog: [] });
ok("member 能用", decision(judgeScheduleTools(mkSession({ role: "member", userId: "333" }), { tool_name: "ScheduleTask", tool_input: {} })) === "allow");
ok("admin 能用", decision(judgeScheduleTools(mkSession({ role: "admin", userId: "333" }), { tool_name: "ScheduleTask", tool_input: {} })) === "allow");
ok("owner 能用", decision(judgeScheduleTools(mkSession({ role: "owner", userId: "100001" }), { tool_name: "CancelScheduledTask", tool_input: {} })) === "allow");
ok("guest 被拒", decision(judgeScheduleTools(mkSession({ role: "guest", userId: "555" }), { tool_name: "ScheduleTask", tool_input: {} })) === "deny");
ok("blocked 被拒", decision(judgeScheduleTools(mkSession({ role: "blocked", userId: "555" }), { tool_name: "ScheduleTask", tool_input: {} })) === "deny");
ok("MCP 原生名同样受理", decision(judgeScheduleTools(mkSession({ role: "member", userId: "333" }), { tool_name: "mcp__xqschedule__ScheduleTask", tool_input: {} })) === "allow");
ok("List 原生名受理", decision(judgeScheduleTools(mkSession({ role: "member", userId: "333" }), { tool_name: "mcp__xqschedule__ListScheduledTasks", tool_input: {} })) === "allow");
ok("Cancel 原生名受理", decision(judgeScheduleTools(mkSession({ role: "member", userId: "333" }), { tool_name: "mcp__xqschedule__CancelScheduledTask", tool_input: {} })) === "allow");
ok("无在途轮次 fail-closed", decision(judgeScheduleTools(mkSession(null), { tool_name: "ScheduleTask", tool_input: {} })) === "deny");

rmSync(root, { recursive: true, force: true });
rmSync(tickRoot, { recursive: true, force: true });
rmSync(b2Root, { recursive: true, force: true });
rmSync(rdyRoot, { recursive: true, force: true });
rmSync(dropRoot, { recursive: true, force: true });
rmSync(onceRoot, { recursive: true, force: true });
rmSync(expRoot, { recursive: true, force: true });
rmSync(markRoot, { recursive: true, force: true });
rmSync(retRoot, { recursive: true, force: true });
rmSync(cdRoot, { recursive: true, force: true });
console.log(fail === 0 ? "\n定时任务全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
