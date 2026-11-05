import { CFG } from "./config.mjs";
import { roleOf, toolAllowed, urlCheck, checkToolCall, pathWithin, ipBlocked, canDo, rateCheck, updateQuota, quotaSnapshot, imageBudgetTake, imageBudgetCheck, imageBudgetReset } from "./auth.mjs";

CFG.owners.push("100001");
CFG.admins.push("100002");
CFG.blockedUsers.push("100999");

let fail = 0;
const check = (name, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name} → ${got}${ok ? "" : `（应为 ${want}）`}`);
};

console.log("— 角色判定 —");
check("owner 号", roleOf({ userId: "100001" }), "owner");
check("平台管理员", roleOf({ userId: "100007", platformRole: "admin" }), "admin");
check("配置里的管理员号", roleOf({ userId: "100002" }), "admin");
check("黑名单优先于平台角色", roleOf({ userId: "100999", platformRole: "admin" }), "blocked");
check("普通群友", roleOf({ userId: "100555" }), "member");
CFG.memberGroups = ["777"];
CFG.allowAllGroups = false;
check("不在群白名单 → guest", roleOf({ userId: "100556", groupId: "888" }), "guest");
check("在白名单群 → member", roleOf({ userId: "100556", groupId: "777" }), "member");
CFG.memberGroups = []; CFG.allowAllGroups = true;

console.log("\n— 工具策略与硬否决 —");
check("member WebSearch", toolAllowed("member", "WebSearch"), true);
check("member WebFetch", toolAllowed("member", "WebFetch"), true);
check("member RecallMemory", toolAllowed("member", "RecallMemory"), true);
check("guest RecallMemory", toolAllowed("guest", "RecallMemory"), false);
check("member Bash", toolAllowed("member", "Bash"), false);
check("guest 无工具", toolAllowed("guest", "WebSearch"), false);
check("owner 全开", toolAllowed("owner", "Read"), true);
check("硬否决清单里的 Bash 就算角色允许也拒", (await checkToolCall("owner", "Bash", { command: "dir" })).behavior, "deny");
check("硬否决清单条目数", CFG.hardDenied.length > 15, true);

console.log("\n— 记事本路径围栏（穿越与变体） —");
const memRoot = "C:/bot/groups/g_test-abc123/memory";
const call = async (role, name, p) => {
  const v = await checkToolCall(role, name, { file_path: p }, { memRoot });
  return v.behavior === "allow" ? "allow" : `deny:${v.code}`;
};
for (const [label, p, want] of [
  ["写索引文件", `${memRoot}/MEMORY.md`, "allow"],
  ["写主题文件", `${memRoot}/rule-a.md`, "allow"],
  ["斜杠点-dot 穿越", `${memRoot}/../../../pwned.txt`, "deny:outside"],
  ["兄弟群目录穿越", `${memRoot}/../../other-group/memory/MEMORY.md`, "deny:outside"],
  ["反斜杠穿越", `${memRoot}\\..\\..\\pwned.txt`, "deny:outside"],
  ["大小写混写加穿越", `${memRoot.toUpperCase()}/../../x.md`, "deny:outside"],
  ["点段怪路径", `${memRoot}/./../../x.md`, "deny:outside"],
  ["完全另一个盘", "C:/Windows/System32/x.txt", "deny:outside"],
  ["相对路径（按 root 解析后仍在 root 内）", "note-abc.md", "allow"],
  ["空路径", "", "deny:path"],
]) check(label, await call("owner", "Write", p), want);
check("blocked 连本子里面也不许写", await call("blocked", "Write", `${memRoot}/MEMORY.md`), "deny:role");
check("owner 出界照样拒", await call("owner", "Write", `${memRoot}/../../../x.txt`), "deny:outside");
check("Read 只许读本子", await call("owner", "Read", "C:/Users/you/Documents/密码.txt"), "deny:outside");
check("WebFetch 角色不允许时拒", (await checkToolCall("guest", "WebFetch", { url: "https://example.com" }, { memRoot })).behavior, "deny");
check("pathWithin 返回规范化路径", (pathWithin(memRoot, `${memRoot}/a/../b.md`) || {}).ok, true);

console.log("\n— WP2：Grep/Glob 并入同一道文件围栏（owner-only + 路径围栏） —");
const callSearch = async (role, name, p) => {
  const v = await checkToolCall(role, name, { pattern: "开黑", path: p }, { memRoot });
  return v.behavior === "allow" ? "allow" : `deny:${v.code}`;
};
check("member 用 Grep → deny(role)", await callSearch("member", "Grep", memRoot), "deny:role");
check("guest 用 Glob → deny(role)", await callSearch("guest", "Glob", memRoot), "deny:role");
check("blocked 用 Grep → deny(role)", await callSearch("blocked", "Grep", memRoot), "deny:role");
check("owner Grep 搜本群本子 → allow", await callSearch("owner", "Grep", memRoot), "allow");
check("owner Glob 的 path 指向别的群 → deny(outside)", await callSearch("owner", "Glob", `${memRoot}/../../g_other-abcdef/memory`), "deny:outside");
check("owner Grep 穿越到本子外 → deny(outside)", await callSearch("owner", "Grep", `${memRoot}/../../../pwned.txt`), "deny:outside");
check("owner Grep 缺 path → deny(path)", await callSearch("owner", "Grep", ""), "deny:path");
check("Grep/Glob 不在硬否决清单里（走的是围栏分支，不是一票否决）", CFG.hardDenied.includes("Grep") || CFG.hardDenied.includes("Glob"), false);

console.log("\n— ImageGen 只给 owner + 每日预算 —");
const TI = 1_700_000_000_000;
check("owner ImageGen → allow", (await checkToolCall("owner", "ImageGen", { prompt: "猫" })).behavior, "allow");
check("member ImageGen → deny(role)", (await checkToolCall("member", "ImageGen", { prompt: "猫" })).behavior, "deny");
check("admin ImageGen → deny(role)", (await checkToolCall("admin", "ImageGen", { prompt: "猫" })).behavior, "deny");
check("guest ImageGen → deny(role)", (await checkToolCall("guest", "ImageGen", { prompt: "猫" })).behavior, "deny");
check("ImageGen 已移出硬否决（否则钩子也放不出来）", CFG.hardDenied.includes("ImageGen"), false);
check("owner ImageSearch → allow", (await checkToolCall("owner", "ImageSearch", { query: "鱼" })).behavior, "allow");
check("admin ImageSearch → allow", (await checkToolCall("admin", "ImageSearch", { query: "鱼" })).behavior, "allow");
check("member ImageSearch → allow", (await checkToolCall("member", "ImageSearch", { query: "鱼" })).behavior, "allow");
check("guest ImageSearch → deny(role)", (await checkToolCall("guest", "ImageSearch", { query: "鱼" })).behavior, "deny");
check("blocked ImageSearch → deny(role)", (await checkToolCall("blocked", "ImageSearch", { query: "鱼" })).behavior, "deny");
check("ImageSearch 已移出硬否决", CFG.hardDenied.includes("ImageSearch"), false);
imageBudgetReset();
let imageOk = 0;
for (let i = 0; i < CFG.imageGenPerUserPerDay; i++) {
  if (imageBudgetTake({ userId: "300001", chatKey: "p:300001", now: TI }).ok) imageOk++;
}
check(`每天前 ${CFG.imageGenPerUserPerDay} 张允许`, imageOk, CFG.imageGenPerUserPerDay);
check(`第 ${CFG.imageGenPerUserPerDay + 1} 张被预算拦`, imageBudgetCheck({ userId: "300001", chatKey: "p:300001", now: TI }).ok, false);
imageBudgetReset();
check("预算重置后恢复（软限，重启清零）", imageBudgetTake({ userId: "300001", chatKey: "p:300001", now: TI }).ok, true);

console.log("\n— URL 护栏（含 IPv6-mapped、内网域名、怪端口、rebind 域名） —");
for (const [u, want] of [
  ["https://www.qbitai.com", true],
  ["http://example.com", true],
  ["http://127.0.0.1/", false],
  ["http://[::ffff:127.0.0.1]/", false],
  ["http://[::ffff:7f00:1]/", false],
  ["http://[::]/", false],
  ["http://[::1]/", false],
  ["http://[fd00::1]/", false],
  ["http://192.168.1.1/admin", false],
  ["http://10.0.0.5/", false],
  ["http://172.16.9.9/", false],
  ["http://169.254.169.254/latest/meta-data/", false],
  ["http://100.64.0.1/", false],
  ["http://localhost:6099/api", false],
  ["http://内网主机.local/", false],
  ["file:///C:/Windows/win.ini", false],
  ["http://127.0.0.1:8081/x", false],
  ["http://example.com:6099/", false],
  ["http://user:pass@example.com/", false],
  ["not a url", false],
  ["http://localtest.me/", false],
  ["http://foo.127.0.0.1.nip.io/", false],
]) {
  const r = await urlCheck(u);
  check(`urlAllowed ${u}`, !!r.ok, want);
}
check("ipBlocked 判 8.8.8.8", ipBlocked("8.8.8.8"), false);
check("Clash fake-ip 段不拦（198.18.0.x 是这台机器的域名解析结果，拦了等于关站）", ipBlocked("198.18.0.144"), false);
check("ipBlocked 判 127.0.0.1", ipBlocked("127.0.0.1"), true);

console.log("\n— 管理动作只有 owner —");
for (const [role, action, want] of [
  ["member", "clearNotes", false], ["admin", "clearNotes", false], ["owner", "clearNotes", true],
  ["member", "viewNotes", false], ["owner", "viewNotes", true], ["member", "confirmRule", false], ["owner", "confirmRule", true],
  ["member", "chat", true], ["blocked", "chat", false], ["member", "changeRules", false], ["owner", "changeRules", true],
]) check(`${action}/${role}`, canDo(role, action), want);

console.log("\n— 速率、日条数与账号配额 —");
const T0 = 1_700_000_000_000;
for (let i = 0; i < CFG.perUserPerMinute; i++) rateCheck("200001", { now: T0 });
check(`群友第 ${CFG.perUserPerMinute + 1} 条被速率拦`, rateCheck("200001", { now: T0 }).ok, false);
for (let i = 0; i < 40; i++) rateCheck("100001", { now: T0 });
check("owner 不受速率限制", rateCheck("100001", { now: T0 }).ok, true);
check("过一分钟窗口后群友可再说", rateCheck("200001", { now: T0 + 61_000 }).ok, true);
check("跨天后今日计数清零", rateCheck("200001", { now: T0 + 26 * 3600_000 }).today, 1);
for (let i = 0; i < CFG.perUserDailyMessages; i++) rateCheck("200002", { now: T0 });
check(`群友第 ${CFG.perUserDailyMessages + 1} 条被日额度拦`, rateCheck("200002", { now: T0 + 1000 }).ok, false);

updateQuota({ totalUsagePercentage: 70, isQuotaExceeded: false, userQuota: { total: 0, used: 0, remaining: 0 }, addOnQuota: { total: 1900, used: 1326, remaining: 574, unit: "credits" } });
check("空套餐桶不误伤：汇总余额", quotaSnapshot().remaining, 574);
check("组织桶按 cap 也算", (() => { updateQuota({ totalUsagePercentage: 5, isQuotaExceeded: false, orgResourcePackage: { cap: 1000, used: 1000, remaining: 0 } }); return quotaSnapshot().remaining; })(), 0);
check("配额读数只作观测（闸门已删，不再据此拦人）", quotaSnapshot().source, "getUsageInfo");
check("配额闸门确实不在了", await import("./auth.mjs").then((m) => typeof m.budgetBlocked), "undefined");

console.log(fail === 0 ? "\n鉴权全部通过" : `\n失败 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
