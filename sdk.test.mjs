// 双轨运行时管理单测：初始轨 / 可用性判定 / 切换 + 回调 / 每日零点 CD / 免费额度标记 / 凭据缓存
import { _resetForTest, _setLastSwitchAtForTest, _setInitialEditionForTest, _applyStateForTest, sdkEdition, switchEdition, switchCooldownRemaining, editionAvailable, loadSdk, onEditionSwitch, byokInfo, _wrapByokQueryForTest, noteTrackUsage, markFreeExhausted, isFreeExhausted, canRestoreDefault, restoreDefaultEdition, defaultEdition, forceEdition } from "./sdk.mjs";
import { CFG } from "./config.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };

// --- 初始轨与可用性 ---
_resetForTest("cn");
ok("默认轨道为 cn", sdkEdition() === "cn");
ok("global 无 PAT 时不可用", editionAvailable("global") === false);
ok("cn 可用（本机有 .qoder-cn 登录态）", editionAvailable("cn") === true, process.env.USERPROFILE);

// --- 切换：另一轨不可用 → 拒绝 ---
ok("global 不可用时切换被拒", await switchEdition("测试") === false);
ok("轨道未变", sdkEdition() === "cn");

// --- 切换成功路径 ---
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
let hookFrom = "", hookTo = "", hookCalls = 0;
onEditionSwitch(async (from, to) => { hookFrom = from; hookTo = to; hookCalls++; });
ok("global 有 PAT 后可用", editionAvailable("global") === true);
ok("cn → global 切换成功", await switchEdition("测试") === true);
ok("当前轨道已切到 global", sdkEdition() === "global");
ok("切轨回调触发且方向正确", hookCalls === 1 && hookFrom === "cn" && hookTo === "global", `${hookFrom}→${hookTo} calls=${hookCalls}`);
ok("切轨后 loadSdk 返回 global 运行时", (await loadSdk()).edition === "global");

// --- 每日零点 CD：当天切过 → 零点前不再切；昨天切过 → 已重置 ---
ok("冷却期内切回 cn 被拒", await switchEdition("测试") === false);
ok("轨道保持 global", sdkEdition() === "global");
ok("冷却回调未再触发", hookCalls === 1);
ok("当天切轨的 CD 是到零点", switchCooldownRemaining() > 0);
_setLastSwitchAtForTest(Date.now() - 2 * 86400_000);
ok("昨天切过 → 零点已重置，CD 为 0", switchCooldownRemaining() === 0);

// --- loadSdk 缓存一致性 ---
const a = await loadSdk("global"), b = await loadSdk("global");
ok("同轨运行时缓存同引用", a === b);

// --- 未知值归一化为 cn ---
_resetForTest("global");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
ok("cn → global 成功后重置", true);
_resetForTest("cn");
ok("重置后回到 cn", sdkEdition() === "cn");

// --- 并发单飞：多群同时限额只切一次 ---
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
let concurrentHookCalls = 0;
onEditionSwitch(async () => { concurrentHookCalls++; await new Promise((r) => setTimeout(r, 30)); });   // 慢回调放大竞态窗口
const [s1, s2, s3] = await Promise.all([switchEdition("并发1"), switchEdition("并发2"), switchEdition("并发3")]);
ok("并发三路共享同一次切换结果", s1 === true && s2 === true && s3 === true, `s1=${s1} s2=${s2} s3=${s3}`);
ok("并发切换回调只触发一次", concurrentHookCalls === 1, `calls=${concurrentHookCalls}`);

// --- 回调抛异常不影响切换结果 ---
_resetForTest("cn");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
onEditionSwitch(async () => { throw new Error("hook boom"); });
ok("回调抛异常时切轨仍成功", await switchEdition("异常测试") === true && sdkEdition() === "global");

// --- BYOK 第三轨 ---
_resetForTest("cn");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
CFG.byokEnabled = true;
CFG.byokProvider = "deepseek";
CFG.byokModel = "deepseek-flash-pg";
CFG.byokApiKey = "test-byok-key";
CFG.byokIsVl = true;
CFG.byokBaseEdition = "global";
CFG.byokFallback = true;
const bInfo = byokInfo();
ok("BYOK 配置齐全且 ready", bInfo.ready === true && bInfo.hasKey === true, JSON.stringify({ ...bInfo, hasKey: "set" }));
ok("BYOK 脱敏信息不含 key", !JSON.stringify(bInfo).includes("test-byok-key"));
const bPolicy = _wrapByokQueryForTest((args) => args)({ prompt: "x", options: {} });
ok("BYOK 模型 key 走 provider/model", bPolicy.options.model === "deepseek/deepseek-flash-pg", bPolicy.options.model);
let capturedByok = null;
const wrapped = _wrapByokQueryForTest((args) => { capturedByok = args; return args; });
wrapped({ prompt: "x", options: { extraArgs: { "reasoning-effort": "medium", "context-window": "400000" } } });
const bOpts = capturedByok?.options ?? {};
ok("BYOK 包装器剥掉 Qwen 的思考档/窗口参数", !("reasoning-effort" in (bOpts.extraArgs ?? {})) && !("context-window" in (bOpts.extraArgs ?? {})));
ok("BYOK 包装器加载 user settings 以读取 providers", Array.isArray(bOpts.settingSources) && bOpts.settingSources.includes("user"));
ok("BYOK 包装器不再用 resolveModel", !bOpts.resolveModel);
const bRt = await loadSdk("byok");
ok("BYOK 运行时基于 global 基础轨", bRt.edition === "byok" && bRt.baseEdition === "global" && bRt.isVl === true);

_resetForTest("cn");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
CFG.byokEnabled = true;
CFG.byokProvider = "deepseek";
CFG.byokModel = "deepseek-flash-pg";
CFG.byokApiKey = "test-byok-key";
CFG.byokBaseEdition = "global";
CFG.byokFallback = true;
ok("cn 先切 global", (await switchEdition("测试")) === true && sdkEdition() === "global");
ok("CD 内 global 可落到 BYOK", (await switchEdition("测试")) === true && sdkEdition() === "byok");
ok("BYOK 轨在 CD 内不再切", (await switchEdition("测试")) === false && sdkEdition() === "byok");

// --- 免费额度标记：计费回执 → 下一轮换轨 ---
_resetForTest("cn");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
ok("billable=true 标记本轨免费额度用完", (noteTrackUsage("cn", { billable: true, credits: 3 }), isFreeExhausted("cn") === true));
ok("非计费回执不标记", noteTrackUsage("cn", { billable: false, credits: 5 }) === false);
ok("credits 兜底（billable 缺省）", (() => { _resetForTest("cn"); noteTrackUsage("cn", { credits: 2 }); return isFreeExhausted("cn"); })(), true);
ok("credits=0 且 billable 缺省不标记", (() => { _resetForTest("cn"); return noteTrackUsage("cn", { credits: 0 }) === false && isFreeExhausted("cn") === false; })(), true);
ok("BYOK 不参与免费额度标记", (() => { _resetForTest("byok"); return noteTrackUsage("byok", { billable: true }) === false && isFreeExhausted("byok") === false; })(), true);

_resetForTest("cn");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
markFreeExhausted("cn", "测试");
ok("当前轨空了切到另一条免费轨", await switchEdition("测试") === true && sdkEdition() === "global");
markFreeExhausted("cn", "测试");
markFreeExhausted("global", "测试");
ok("两轨当天都空了不再换轨（无 BYOK）", await switchEdition("测试") === false && sdkEdition() === "global");
_resetForTest("cn");
noteTrackUsage("cn", { billable: true });
ok("标记到零点失效（次日重试）", isFreeExhausted("cn", Date.now() + 24 * 3600_000) === false);

// --- 每日回轨：双轨耗尽后，零点后的下一句回到启动默认轨 ---
_resetForTest("global");
_setInitialEditionForTest("global");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
ok("自动 failover global → cn", (await switchEdition("测试")) === true && sdkEdition() === "cn");
ok("当天 CD 内不回轨", canRestoreDefault() === false && (await restoreDefaultEdition()) === false && sdkEdition() === "cn");
_setLastSwitchAtForTest(Date.now() - 2 * 86400_000);   // 模拟已过零点
ok("零点后满足回轨条件", canRestoreDefault() === true);
ok("回轨回到启动默认 global", (await restoreDefaultEdition()) === true && sdkEdition() === "global" && defaultEdition() === "global");
ok("回轨不占当日 CD", switchCooldownRemaining() === 0);

_resetForTest("global");
_setInitialEditionForTest("global");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
await forceEdition("cn", "管理台手动切换");
_setLastSwitchAtForTest(Date.now() - 2 * 86400_000);
ok("手动切轨不自动回轨", canRestoreDefault() === false && (await restoreDefaultEdition()) === false && sdkEdition() === "cn");

// --- 跨重启状态：当天切过轨恢复切到的轨；跨零点回启动默认轨 ---
const todayKey = (() => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; })();
_resetForTest("global");
_setInitialEditionForTest("global");
process.env.QODER_PERSONAL_ACCESS_TOKEN = "test-pat-for-unit";
_applyStateForTest({ active: "cn", lastSwitchAt: Date.now(), lastSwitchAuto: true, freeExhausted: { global: { day: todayKey, reason: "限额报错", at: Date.now() } } });
ok("当天切过轨 → 重启留在 cn（不回到已耗尽的 global）", sdkEdition() === "cn", sdkEdition());
ok("当天的耗尽标记一起恢复", isFreeExhausted("global") === true);
ok("CD 仍到零点", switchCooldownRemaining() > 0);

_resetForTest("global");
_setInitialEditionForTest("global");
_applyStateForTest({ active: "cn", lastSwitchAt: Date.now() - 2 * 86400_000, lastSwitchAuto: true });
ok("跨零点不恢复昨天的轨（等每日回轨）", sdkEdition() === "global", sdkEdition());

_resetForTest("cn");
_setInitialEditionForTest("cn");
_applyStateForTest({ active: "global", lastSwitchAt: Date.now(), lastSwitchAuto: true });
ok("目标轨不可用则不恢复", sdkEdition() === "cn", sdkEdition());

console.log(fail === 0 ? "\nSDK 双轨 + BYOK 全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
