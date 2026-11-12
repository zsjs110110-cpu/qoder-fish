import { CFG } from "./config.mjs";
import { sessionStats, flushAll, ask, GROUPS_ROOT } from "./brain.mjs";
import { RULES, connect } from "./adapters/onebot.mjs";
import { startScheduler } from "./scheduler.mjs";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sdkEdition, editionAvailable, byokInfo, byokSettings, switchCooldownRemaining, getSwitchHistory, forceEdition, freeExhaustedInfo, usageInfo } from "./sdk.mjs";
import { applyByokSettings, listModelsForUi } from "./admin-settings.mjs";
import { startAdminServer } from "./admin-web.mjs";
import { startGroupBackup, DEFAULT_BACKUP_DIR } from "./backup.mjs";

const url = process.env.ONEBOT_WS || process.argv.find((a) => a.startsWith("ws"));
const groups = (process.env.ALLOW_GROUPS || "").split(",").map((s) => s.trim()).filter(Boolean);
const privates = (process.env.ALLOW_PRIVATE || "").split(",").map((s) => s.trim()).filter(Boolean);
RULES.allowGroups = groups;
RULES.allowPrivate = privates;
// 默认让她自己判断要不要接话（不 @ 也回）；想只在被 @ 时才响应就 REQUIRE_AT=1
RULES.requireAtInGroup = process.env.REQUIRE_AT === "1";
// 给了群白名单 = 只在这些群里说话；没给才看 ALLOW_ALL
CFG.allowAllGroups = groups.length === 0 && process.env.ALLOW_ALL === "1";
CFG.memberGroups = groups;

// 守护循环把 stdout 重定向进日志文件；没有时间戳时排障对不上 NapCat 侧的时间线
const stamp = () => new Date().toLocaleString("zh-CN", { hour12: false });
for (const level of ["log", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(`[${stamp()}]`, ...args);
}

const byok = byokInfo();
const modelLabel = sdkEdition() === "byok"
  ? `BYOK=${byok.provider}/${byok.model}（vl=${byok.isVl}）`
  : `模型=${CFG.model}`;
console.log(`[启动] SDK=${sdkEdition()} ${modelLabel} 思考=${sdkEdition() === "byok" ? (CFG.byokReasoningEffort || "默认") : CFG.reasoningEffort} 工具=${CFG.tools.join("/")}（对外只说 ${CFG.chatTools.join("/")}）人设=${CFG.character}`);
if (sdkEdition() === "byok" && !editionAvailable("byok")) {
  console.error("\n拒绝启动：SDK=byok 但 BYOK_ENABLED/PROVIDER/MODEL/API_KEY 不完整，或没有可用的 Qoder 基础轨。");
  process.exit(1);
}
if (sdkEdition() === "global" && !process.env.QODER_PERSONAL_ACCESS_TOKEN) {
  console.error("\n拒绝启动：QODER_EDITION=global 但没设 QODER_PERSONAL_ACCESS_TOKEN（qoder.com/account/integrations 生成）。");
  process.exit(1);
}
console.log(`[启动] 硬否决 ${CFG.hardDenied.length} 个工具 ｜ 条数限额 ${CFG.perUserPerMinute}/分 ${CFG.perUserDailyMessages}/天 ｜ 上下文档 ${CFG.contextWindow}（无配额闸门：免费档模型）`);
console.log(`[启动] 发送节奏 ${CFG.sendMinGapMs}ms/条 ｜ 每群上限 ${CFG.sendHourlyCap || "不限"}/小时（超限只丢不重试）`);
console.log(`[启动] 群白名单=${groups.length ? groups.join(",") : "(未设)"} 私聊=${privates.length ? privates.join(",") : "(未设)"} 要@=${RULES.requireAtInGroup}`);

function adminStatus() {
  const cooldownMs = switchCooldownRemaining();
  return {
    now: Date.now(), pid: process.pid, uptimeSec: Math.round(process.uptime()),
    edition: sdkEdition(), cooldownMs, cooldownUntil: cooldownMs > 0 ? Date.now() + cooldownMs : 0,
    availability: {
      cn: editionAvailable("cn"), global: editionAvailable("global"), byok: editionAvailable("byok"),
    },
    // 双轨观察：凭据可用性 + 今天的免费额度标记 + 最近一条计费回执（只读，不含正文）
    tracks: {
      cn: { available: editionAvailable("cn"), exhausted: freeExhaustedInfo("cn") },
      global: { available: editionAvailable("global"), exhausted: freeExhaustedInfo("global") },
      byok: { available: editionAvailable("byok") },
    },
    usage: usageInfo(),
    bot: sessionStats(),
    byok: byokSettings(),
    history: getSwitchHistory(),
  };
}
const admin = process.env.ADMIN_WEB === "0" ? null : await startAdminServer({
  port: Number(process.env.ADMIN_WEB_PORT || 6100),
  getStatus: adminStatus,
  switchEdition: (edition) => forceEdition(edition, "管理台手动切换"),
  saveByok: (patch) => applyByokSettings(patch),
  listModels: (patch) => listModelsForUi(patch),
});
if (admin) console.log(`[管理台] http://127.0.0.1:${admin.port}/ （仅本机；页面内嵌一次性写操作 token）`);
// 群目录快照 + 哨兵：启动拍一份，之后每 24h；后台执行，不阻塞聊天
startGroupBackup(GROUPS_ROOT);
console.log(`[备份] 群目录快照已启用：${DEFAULT_BACKUP_DIR}（启动 + 每 24h；默认保留 14 天 / 40 份，GROUPS_BACKUP_* 可调）`);

if (!url) {
  console.log("\n没给 OneBot 地址，进本地 REPL。要接 QQ：");
  console.log('  ONEBOT_WS=ws://127.0.0.1:3001/node ONEBOT_TOKEN=xxx ALLOW_GROUPS=123456 node index.mjs');
  console.log("  （NapCat 侧开「WebSocket 服务器」，本进程作为客户端连过去）");
  await import("./repl.mjs");
} else {
  if (CFG.requireWhitelist && !groups.length && !privates.length) {
    console.error("\n拒绝启动：一个白名单都没设，等于对全 QQ 的任意群和任意私聊秒回。");
    console.error("给自己留后路：ALLOW_GROUPS=<你的群号> 或者显式 ALLOW_ALL=1（会速率烧额度，别在主群这么干）。");
    process.exit(1);
  }
  if (!process.env.OWNER_QQ && !CFG.owners.length) console.warn("警告：没设 OWNER_QQ，管理动作没人能做，速率限制对所有人一视同仁。");
  // 单实例锁：定时任务/配额都是"读-改-写"，两个 index.mjs 会互相覆盖并按双份触发
  const lockFile = join(GROUPS_ROOT, ".bot.lock");
  mkdirSync(GROUPS_ROOT, { recursive: true });
  if (existsSync(lockFile)) {
    let oldPid = 0;
    try { oldPid = Number(JSON.parse(readFileSync(lockFile, "utf8")).pid) || 0; } catch {}
    if (oldPid && oldPid !== process.pid) {
      let alive = false;
      try { process.kill(oldPid, 0); alive = true; } catch (e) { alive = e.code === "EPERM"; }
      if (alive) {
        console.error(`\n拒绝启动：另一个 bot 实例在跑（pid=${oldPid}）。先停掉它，或确认它已死后再启动。`);
        process.exit(1);
      }
    }
  }
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const releaseLock = () => {
    try {
      const cur = JSON.parse(readFileSync(lockFile, "utf8"));
      if (Number(cur?.pid) === process.pid) unlinkSync(lockFile);
    } catch {}
  };
  console.log(`[启动] 已获取单实例锁 pid=${process.pid}`);
  const c = connect(url, { token: process.env.ONEBOT_TOKEN });
  // 定时任务：每 30s 扫各会话 schedule.json，到点交给 ask() 现场生成，再经 connect.send 走发送闸门。
  const sched = startScheduler({
    root: GROUPS_ROOT,
    askFn: ask,
    send: (chatKey, message) => c.send(chatKey, message),
    // 没握手/断线时整轮跳过，不落 lastRunDay，等下一轮 30s 再试
    ready: () => c.connected,
    // 调模型前预检：白名单/禁言/小时上限，不可投递就不烧额度
    canDeliver: (chatKey) => c.canDeliver(chatKey),
  });
  sched.start();
  console.log("[定时] 已启动（每 30s 检查一次，任务存在各会话 schedule.json）");
  const shutdown = async () => {
    console.log("\n[退出] 先落 post-turn，再关闭连接");
    // 给在途 tick 最多 5 秒收尾，避免把"已标记未发送"的任务截断
    await Promise.race([sched.stop(), new Promise((r) => setTimeout(r, 5000))]);
    await admin?.close?.().catch(() => {});
    await flushAll().catch((e) => console.log(`[退出] finalize 失败：${e.message ?? e}`));
    c.close();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  setInterval(() => console.log(`[心跳] ${JSON.stringify(sessionStats())}`), 5 * 60_000).unref?.();
}
