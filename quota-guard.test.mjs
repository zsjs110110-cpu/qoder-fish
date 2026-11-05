// 日限额识别（2026-10-29 复读排障）：SDK 不抛错、把限额提示当 assistant 文本返回。
// 这里测识别函数本身；runTurn/fallback 的静默语义由代码审查+实弹确认。
import { isQuotaMessage, QUOTA_RE, quotaTextOf } from "./brain.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };

ok("实弹限额提示命中（probe 原文）", isQuotaMessage("You've reached your daily usage limit for Chat. Come back tomorrow to continue using Chat."));
ok("常见变体命中：daily usage limit", isQuotaMessage("已达到 daily usage limit"));
ok("常见变体命中：quota exceeded", isQuotaMessage("Your quota has been exceeded."));
// 2026-10-31 实弹（cn 轨 23:19 复读的原始文案）：credit 变体 + 文案只在 errors 里
const CREDIT_MSG = "You've reached your credit usage limit. Please upgrade your subscription plan to get more resources. Report Issue (input /feedback)";
ok("cn 轨实弹文案命中：credit usage limit", isQuotaMessage(CREDIT_MSG));
ok("quotaTextOf 从 errors 数组取到文案", isQuotaMessage(quotaTextOf({ subtype: "error_during_execution", result: "", assistantText: "", errors: [CREDIT_MSG] })));
ok("quotaTextOf 从 errors 字符串取到文案", isQuotaMessage(quotaTextOf({ result: "", errors: CREDIT_MSG })));
ok("quotaTextOf 从 assistantText 取到文案", isQuotaMessage(quotaTextOf({ result: "", assistantText: CREDIT_MSG })));
// 正文默认不纳入：她正常回话时复述/转述这句英文，不能被判成限额（否则真切轨 8h）
ok("正常回复里复述这句英文不判限额", !isQuotaMessage(quotaTextOf({ subtype: "success", result: CREDIT_MSG, errors: [] })));
ok("执行失败帧(result 也纳入)命中", isQuotaMessage(quotaTextOf({ subtype: "error_during_execution", result: CREDIT_MSG })));
ok("quotaTextOf 正常回复不误杀", !isQuotaMessage(quotaTextOf({ result: "好啦，锅里的汤再炖五分钟", errors: [] })));
ok("quotaTextOf 空帧不误杀", !isQuotaMessage(quotaTextOf({})));
ok("quotaTextOf null 安全", !isQuotaMessage(quotaTextOf(null)));
ok("errors 为对象也能提取", isQuotaMessage(quotaTextOf({ errors: { message: CREDIT_MSG } })));
ok("数组里多条错误都能拼到", isQuotaMessage(quotaTextOf({ errors: ["网络抖动", CREDIT_MSG] })));
ok("普通话不误杀：我今天的额度好像用完了", !isQuotaMessage("我今天的额度好像用完了"));
ok("普通话不误杀：正常回复", !isQuotaMessage("好啦，锅里的汤再炖五分钟"));
ok("空值安全", !isQuotaMessage(null) && !isQuotaMessage(undefined) && !isQuotaMessage(""));
ok("正则全局可用（no g 标志，无 lastIndex 问题）", new Set(["daily usage limit", "daily usage limit"].map((s) => QUOTA_RE.test(s))).size === 1);

console.log(fail === 0 ? "\n限额识别全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
