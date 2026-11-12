import { createChatQueue } from "./chat-queue.mjs";

let fail = 0;
const ok = (name, cond, extra = "") => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " ｜ " + extra : ""}`); };
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve, reject;
  const p = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { p, resolve, reject };
};

console.log("— 1 同群串行、上限丢最旧 —");
let clock = 0;
const q1 = createChatQueue({ maxWaiting: 2, staleMs: 10_000, now: () => clock });
const log = [];
const mk = (name) => {
  const d = deferred();
  return {
    d,
    job: async () => { log.push(`start:${name}`); const v = await d.p; log.push(`end:${name}`); return { name, v }; },
  };
};
const A = mk("A"), B = mk("B"), C = mk("C"), D = mk("D");
const pa = q1.enqueue("g", A.job, { chatKey: "g" });
await tick();
ok("第一条立即开始", log.join(",") === "start:A", log.join(","));
const pb = q1.enqueue("g", B.job, { chatKey: "g" });
const pc = q1.enqueue("g", C.job, { chatKey: "g" });
const pd = q1.enqueue("g", D.job, { chatKey: "g" });
await tick();
ok("超出等待上限的消息被丢", (await pb).dropped === "queue", JSON.stringify(await pb));
ok("被丢的消息没有跑", !log.includes("start:B"), log.join(","));
A.d.resolve("a");
await tick();
ok("上一条结束后才轮到下一条", log.join(",") === "start:A,end:A,start:C", log.join(","));
C.d.resolve("c");
await tick();
ok("队列继续往前推", log.join(",") === "start:A,end:A,start:C,end:C,start:D", log.join(","));
D.d.resolve("d");
const [ra, rc, rd] = await Promise.all([pa, pc, pd]);
ok("结果按各自 job 返回", ra.v === "a" && rc.v === "c" && rd.v === "d", JSON.stringify([ra, rc, rd]));

console.log("\n— 2 等太久直接丢，不补回 —");
clock = 0;
const q2 = createChatQueue({ maxWaiting: 2, staleMs: 1000, now: () => clock });
const E = mk("E"), F = mk("F");
const pe = q2.enqueue("g", E.job);
await tick();
const pf = q2.enqueue("g", F.job);
clock = 1500;
E.d.resolve("e");
const rf = await pf;
await pe;
ok("过期消息被丢", rf.dropped === "stale", JSON.stringify(rf));
ok("过期消息没有跑", !log.includes("start:F"), log.join(","));

console.log("\n— dropWaiting：连续超时熔断清队 —");
const qd = createChatQueue({ maxWaiting: 2, staleMs: 10_000 });
const gate = deferred();
const runningP = qd.enqueue("g", async () => { await gate.p; return { name: "running" }; });
const w2 = qd.enqueue("g", async () => ({ name: "w2" }));
const w3 = qd.enqueue("g", async () => ({ name: "w3" }));
await tick();
const n = qd.dropWaiting("g", "timeout-pause");
ok("等待队列被清空", n === 2, String(n));
ok("丢弃原因可定制", (await w2).dropped === "timeout-pause" && (await w3).dropped === "timeout-pause", "");
gate.resolve();
ok("正在跑的轮不受影响", (await runningP).name === "running", "");

console.log("\n— 3 reset 丢掉等待项，不打断在跑项 —");
clock = 0;
const q3 = createChatQueue({ maxWaiting: 2, staleMs: 10_000, now: () => clock });
const G = mk("G"), H = mk("H");
const pg = q3.enqueue("g", G.job);
await tick();
const ph = q3.enqueue("g", H.job);
const dropped = q3.reset("g");
ok("reset 返回丢掉的等待条数", dropped === 1, String(dropped));
ok("等待项被 reset 丢", (await ph).dropped === "reset", JSON.stringify(await ph));
ok("在跑项仍在跑", log.includes("start:G") && !log.includes("start:H"), log.join(","));
G.d.resolve("g");
await pg;
await tick();
ok("清空后队列自己回收", q3.stats().chats === 0, JSON.stringify(q3.stats()));

console.log("\n— 4 job 抛错不堵队列 —");
const q4 = createChatQueue({ maxWaiting: 2, staleMs: 10_000, now: () => clock });
let rejected = false;
const bad = q4.enqueue("g", async () => { throw new Error("boom"); });
const good = q4.enqueue("g", async () => ({ text: "ok" }));
try { await bad; } catch (e) { rejected = /boom/.test(e.message); }
ok("异常传给调用方", rejected);
ok("后面的 job 还能跑", (await good).text === "ok", JSON.stringify(await good));

console.log("\n— 5 不同群互不排队 —");
clock = 0;
const q5 = createChatQueue({ maxWaiting: 2, staleMs: 10_000, now: () => clock });
const I = mk("I"), J = mk("J");
const pi = q5.enqueue("a", I.job);
const pj = q5.enqueue("b", J.job);
await tick();
ok("两个群都立即开始", log.includes("start:I") && log.includes("start:J"), log.join(","));
I.d.resolve("i"); J.d.resolve("j");
await Promise.all([pi, pj]);

console.log(fail === 0 ? "\n队列测试全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
