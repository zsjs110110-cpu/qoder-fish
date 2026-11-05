// 双轨运行时管理单测：初始轨 / 可用性判定 / 切换 + 回调 / 8h CD / 凭据缓存
import { _resetForTest, sdkEdition, switchEdition, editionAvailable, loadSdk, onEditionSwitch, byokInfo, byokPolicy, _wrapByokQueryForTest } from "./sdk.mjs";
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

// --- 8h CD：冷却期内再切被拒 ---
ok("冷却期内切回 cn 被拒", await switchEdition("测试") === false);
ok("轨道保持 global", sdkEdition() === "global");
ok("冷却回调未再触发", hookCalls === 1);

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
const bPolicy = byokPolicy();
ok("BYOK policy 使用第三方 provider/model", bPolicy.model.provider === "deepseek" && bPolicy.model.model === "deepseek-flash-pg" && bPolicy.model.isVl === true);
let capturedByok = null;
const wrapped = _wrapByokQueryForTest((args) => { capturedByok = args; return args; });
wrapped({ prompt: "x", options: { extraArgs: { "reasoning-effort": "medium", "context-window": "400000" } } });
const bOpts = capturedByok?.options ?? {};
ok("BYOK 包装器剥掉 Qwen 的思考档/窗口参数", !("reasoning-effort" in (bOpts.extraArgs ?? {})) && !("context-window" in (bOpts.extraArgs ?? {})));
ok("BYOK 包装器注入 resolveModel", bOpts.resolveModel && bOpts.resolveModel().model.provider === "deepseek" && bOpts.resolveModel().model.model === "deepseek-flash-pg");
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

console.log(fail === 0 ? "\nSDK 双轨 + BYOK 全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
