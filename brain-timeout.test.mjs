import { cancelTurn, applySearchPick } from "./brain.mjs";

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

console.log(fail === 0 ? "\n超时取消逻辑全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
