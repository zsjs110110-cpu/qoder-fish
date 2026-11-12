import { cancelTurn, applySearchPick, _breakerStateForTest, _noteTimeoutForTest, _noteSuccessForTest, _resetBreakerForTest, _breakerDropsForTest, shouldRotateSession, _buildHandoffForTest, _judgeNeededForTest, _wantsColdListForTest, _noteDroppedMemoryForTest, _readPendingNotesForTest, _clearPendingNotesForTest, groupDir } from "./brain.mjs";
import { CFG } from "./config.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fail = 0;
const ok = (name, cond, extra = "") => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " ｜ " + extra : ""}`); };

console.log("— 超时取消：中断失败/落地/不落地 —");
ok("没有会话或条目 → false", (await cancelTurn(null, null)) === false);

const noInterrupt = { interrupt: async () => false };
ok("interrupt 失败 → false", (await cancelTurn(noInterrupt, { shifted: Promise.resolve() }, 20)) === false);

const yes = { interrupt: async () => true };
ok("interrupt 成功且队首清掉 → true", (await cancelTurn(yes, { shifted: Promise.resolve() }, 20)) === true);
ok("没有 shifted 标记的老条目 → true", (await cancelTurn(yes, {}, 20)) === true);

const t0 = Date.now();
const never = new Promise(() => {});
ok("中断落地迟迟不来 → false", (await cancelTurn(yes, { shifted: never }, 30)) === false);
ok("确实等到了阈值才放弃", Date.now() - t0 >= 25, `${Date.now() - t0}ms`);

console.log("— ImageSearch 的模型挑选 —");
const pickM = { result: "就这只 [pick:2]", searchImages: [{ title: "a" }, { title: "b" }, { title: "c" }] };
applySearchPick(pickM);
ok("pick=2 选中项重排到第一", pickM.searchImages[0].title === "b");
ok("pick 标记不进正文", !/pick/i.test(pickM.result));
ok("searchPick 记录为 2", pickM.searchPick === 2);
const badPick = { result: "就这只 [pick:9]", searchImages: [{ title: "a" }, { title: "b" }] };
applySearchPick(badPick);
ok("越界 pick 退回第一张", badPick.searchImages[0].title === "a");

console.log("— 连续超时熔断 —");
_resetBreakerForTest();
_noteTimeoutForTest("g:breaker");
ok("1 次超时不暂停", _breakerStateForTest("g:breaker").paused === false && _breakerStateForTest("g:breaker").streak === 1, JSON.stringify(_breakerStateForTest("g:breaker")));
_noteTimeoutForTest("g:breaker");
ok("2 次超时进入暂停", _breakerStateForTest("g:breaker").paused === true, JSON.stringify(_breakerStateForTest("g:breaker")));
_noteSuccessForTest("g:breaker");
ok("成功一轮清零", _breakerStateForTest("g:breaker").paused === false && _breakerStateForTest("g:breaker").streak === 0, JSON.stringify(_breakerStateForTest("g:breaker")));
_noteTimeoutForTest("p:breaker");
ok("私聊不参与熔断", _breakerStateForTest("p:breaker").streak === 0, JSON.stringify(_breakerStateForTest("p:breaker")));
_resetBreakerForTest();

console.log("— 熔断期只丢闲聊，不吞直达 —");
_resetBreakerForTest();
_noteTimeoutForTest("g:bp"); _noteTimeoutForTest("g:bp");
ok("熔断已生效", _breakerStateForTest("g:bp").paused === true);
ok("普通闲聊被丢", _breakerDropsForTest("g:bp", "member", false) === true);
ok("@她/回复她的消息放行", _breakerDropsForTest("g:bp", "member", true) === false);
ok("主人的消息放行", _breakerDropsForTest("g:bp", "owner", false) === false);
ok("管理员的也放行", _breakerDropsForTest("g:bp", "admin", false) === false);
ok("没熔断时什么都不丢", _breakerDropsForTest("g:other", "member", false) === false);
_resetBreakerForTest();

console.log("— 上下文阈值轮换 —");
ok("轮数到硬上限 → 换", shouldRotateSession({ turns: 120, lastContextUsageRatio: 0.1 }) === true);
ok("占用到 45% → 提前换", shouldRotateSession({ turns: 50, lastContextUsageRatio: 0.45 }) === true);
ok("占用 44% → 不换", shouldRotateSession({ turns: 50, lastContextUsageRatio: 0.44 }) === false);
ok("没有占用数据且轮数没满 → 不换", shouldRotateSession({ turns: 50, lastContextUsageRatio: null }) === false);
const oldRotateAt = CFG.contextRotateAt;
CFG.contextRotateAt = 0;
ok("显式关闭阈值 → 只看轮数", shouldRotateSession({ turns: 50, lastContextUsageRatio: 0.9 }) === false);
CFG.contextRotateAt = oldRotateAt;

console.log("— 轮换交接 —");
const hd = mkdtempSync(join(tmpdir(), "xq-handoff-"));
ok("没有转录 → 空交接", _buildHandoffForTest(hd) === "");
writeFileSync(join(hd, "chat.jsonl"), [
  JSON.stringify({ text: "旧问题", reply: "旧回答", user: "甲" }),
  JSON.stringify({ system: "记事本已清空" }),
  JSON.stringify({ text: "没发出去", reply: "" }),
  JSON.stringify({ text: "新问题", reply: "新回答", user: "乙" }),
].join("\n") + "\n");
const h1 = _buildHandoffForTest(hd);
ok("交接含最近一轮", h1.includes("新问题") && h1.includes("新回答"), h1.slice(-40));
ok("系统行/未发送行不进交接", !h1.includes("记事本已清空") && !h1.includes("没发出去"));
writeFileSync(join(hd, "chat.jsonl"), Array.from({ length: 20 }, (_, i) =>
  JSON.stringify({ text: `长${i}` + "字".repeat(200), reply: `回${i}` + "字".repeat(200), user: `u${i}` })
).join("\n") + "\n");
const h2 = _buildHandoffForTest(hd);
ok("超长时压进预算", h2.length <= 1700, String(h2.length));
ok("保留最新一轮", h2.includes("长19") && !h2.includes("长0"), "");
rmSync(hd, { recursive: true, force: true });

console.log("— 接话预判触发条件 —");
ok("私聊不预判", _judgeNeededForTest("p:123", "member", {}) === false);
ok("定时任务不预判", _judgeNeededForTest("g:1", "member", { scheduled: true }) === false);
ok("主人不预判", _judgeNeededForTest("g:1", "owner", {}) === false);
ok("@她/回复她不预判", _judgeNeededForTest("g:1", "member", { addressed: true }) === false);
ok("提到称呼不预判", _judgeNeededForTest("g:1", "member", { weakAddress: true }) === false);
ok("普通群聊要预判", _judgeNeededForTest("g:1", "member", { addressed: false, weakAddress: false }) === true);
ok("带图片不预判（预判看不到图）", _judgeNeededForTest("g:1", "member", {}, { images: [{ data: "x" }] }) === false);
ok("卡片不预判", _judgeNeededForTest("g:1", "member", {}, { text: "【卡片】链接：https://b23.tv/x" }) === false);
ok("转发消息不预判", _judgeNeededForTest("g:1", "member", {}, { text: "【转发消息 2 条】\n甲：在吗" }) === false);
ok("引用图占位不预判", _judgeNeededForTest("g:1", "member", {}, { text: "【引用的消息·甲】[图片]" }) === false);
ok("纯文本链接不预判", _judgeNeededForTest("g:1", "member", {}, { text: "看这个 https://example.com/a" }) === false);
ok("普通中文短句仍然预判", _judgeNeededForTest("g:1", "member", {}, { text: "今天中午吃啥" }) === true);

console.log("— 冷层全量触发词 —");
ok("「你去读一下冷层」算要全量", _wantsColdListForTest("另外你读冷层这个我好像后来没测试过，你去读一下") === true);
ok("「冷层里有什么」算", _wantsColdListForTest("冷层里有什么") === true);
ok("「长期记忆里查一下边缘行者」算", _wantsColdListForTest("长期记忆里查一下边缘行者") === true);
ok("普通聊天不算", _wantsColdListForTest("今天好冷啊") === false);

console.log("— 待补记：没跑成的“记一下”落盘 —");
const pk = "g:pending-test";
const pdir = groupDir(pk);
_clearPendingNotesForTest(pdir);
ok("普通消息不落待补记", _noteDroppedMemoryForTest(pk, { text: "今天中午吃啥", userId: "1", name: "甲", role: "member", reason: "timeout-pause" }) === false);
ok("“记一下”落待补记", _noteDroppedMemoryForTest(pk, { text: "@千姐 记一下，发这个图的人是个福瑞控", userId: "100001", name: "主人", role: "owner", reason: "timeout-pause" }) === true);
ok("“记住”也算", _noteDroppedMemoryForTest(pk, { text: "记住这个 B 站号", userId: "100001", name: "主人", role: "owner", reason: "timeout" }) === true);
const pend = _readPendingNotesForTest(pdir);
ok("读回两条且带说话人", pend.length === 2 && pend[0].name === "主人" && pend[0].uid === "100001", JSON.stringify(pend.map((x) => x.text.slice(0, 10))));
ok("limit 生效", _readPendingNotesForTest(pdir, 1).length === 1);
const layersMod = await import("./prompt-layers/layers.mjs");
const withPending = layersMod.renderRuntime({ group: "g", time: "t", speaker: { name: "主人", id: "100001" }, memory: [], pendingNotes: pend, text: "在吗" });
ok("L4 出现待补记区块", withPending.includes("【待补记】") && withPending.includes("福瑞控"), withPending.slice(0, 80));
_clearPendingNotesForTest(pdir);
ok("清空后读到 0 条", _readPendingNotesForTest(pdir).length === 0);
rmSync(pdir, { recursive: true, force: true });
const oldGate = CFG.judgeGate;
CFG.judgeGate = false;
ok("JUDGE_GATE=0 关闭", _judgeNeededForTest("g:1", "member", {}) === false);
CFG.judgeGate = oldGate;

console.log(fail === 0 ? "\n超时取消逻辑全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
