import { createSerialFinalizer } from "./post-turn.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };

const order = [];
const gates = new Map();
const f = createSerialFinalizer({
  finalize: async (job) => { order.push(`start:${job.id}`); await (gates.get(job.id)?.p ?? Promise.resolve()); order.push(`end:${job.id}`); },
  onError: (e, job) => order.push(`err:${job.id}`),
});

const g1 = deferred(); gates.set(1, g1);
const p1 = f.schedule("g", { id: 1 });
const p2 = f.schedule("g", { id: 2 });
await tick();
ok("同群第二条等第一条", order.join(",") === "start:1", order.join(","));
ok("drain 等待同群全部", f.has("g"), String(f.has("g")));
g1.resolve();
await Promise.all([p1, p2]);
await new Promise((r) => setTimeout(r, 100));
ok("同群顺序保持", order.join(","), "start:1,end:1,start:2,end:2");
ok("完成后清空", f.has("g") === false);

const a = deferred(), b = deferred();
const f2 = createSerialFinalizer({ finalize: async (j) => { order.push(`x:${j.id}`); await (j.id === "a" ? a.p : b.p); } });
const pa = f2.schedule("A", { id: "a" });
const pb = f2.schedule("B", { id: "b" });
await tick();
ok("不同群互不阻塞", order.includes("x:a") && order.includes("x:b"), order.join(","));
a.resolve(); b.resolve(); await Promise.all([pa, pb]);

let errSeen = false;
const f3 = createSerialFinalizer({ finalize: async () => { throw new Error("boom"); }, onError: () => { errSeen = true; } });
const r3 = await f3.schedule("C", { id: 3 });
ok("finalize 失败不 reject", r3.ok === false && errSeen, JSON.stringify(r3));

const f4 = createSerialFinalizer({ finalize: async (j) => ({ v: j.v }) });
const r4 = await f4.schedule("D", { v: 7 });
ok("返回值带耗时", typeof r4.ms === "number" && r4.ok, JSON.stringify(r4));

console.log(fail === 0 ? "\npost-turn 调度全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
