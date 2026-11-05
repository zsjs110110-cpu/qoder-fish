import { quotedContextOf } from "./adapters/onebot.mjs";
import { cacheClear } from "./lookup-cache.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
let calls = 0;
// 2026-10-30 起回查带同源校验：桩必须返回与 chatKey 同群的消息形状（真实 NapCat get_msg 带 group_id）
const api = { call: async () => { calls++; return { group_id: 591001, user_id: 222, message: [{ type: "text", data: { text: "被引用的正文" } }] }; } };
cacheClear("quote:");
const a = await quotedContextOf(101, api, { chatKey: "g:591001" });
const b = await quotedContextOf(101, api, { chatKey: "g:591001" });
// 审查修复（2026-11-03 S1）：ok 的第二位是布尔条件，原来直接传计数——≥1 恒真，
// "缓存串群"这类回归恰好测不出来。三处一并改成显式相等。
ok("同一引用只调 get_msg 一次", calls === 1, `calls=${calls}`);
ok("缓存文本一致", a.text === b.text && a.text.includes("被引用的正文"), a.text);
const c = await quotedContextOf(101, api, { chatKey: "g:591002" });
ok("不同群不共享缓存", calls === 2, `calls=${calls}`);
cacheClear("quote:");
await quotedContextOf(101, api, { chatKey: "g:591001" });
ok("清缓存后重新拉取", calls === 3, `calls=${calls}`);
console.log(fail === 0 ? "\n引用缓存全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
