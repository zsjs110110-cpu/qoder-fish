// OneBot v11 正向 WebSocket 客户端：NapCat 作为服务端，本进程连过去。
// 只依赖 Node 原生 WebSocket，不需要额外包。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { extname, join } from "node:path";
import { ask, groupDir, generateImage, recordTurn, GROUPS_ROOT } from "../brain.mjs";
import { appendDelivery } from "../delivery.mjs";
import { readJobs, updateJob, upsertJob, pruneJobs, targetOf } from "../draw-jobs.mjs";
import { cacheSweep } from "../media-cache.mjs";
import { loadImage } from "../media.mjs";
import { loadImageCached } from "../media-cache.mjs";
import { cacheGet, cacheSet } from "../lookup-cache.mjs";
import { splitMessages } from "../sanitize.mjs";
import { appendRecent, readRecent, renderRecent } from "../recent.mjs";
import { safeName } from ".././prompt-layers/layers.mjs";
import { CFG } from "../config.mjs";

export const RULES = {
  // 允许自动回复的群号；空数组表示所有群都回
  allowGroups: [],
  // 允许私聊回复的用户号；空数组表示**只有主人**能私聊她（陌生人私聊默认拒绝）
  allowPrivate: [],
  // 群里是否只有被 @ 才响应
  requireAtInGroup: false,
  // 事件新鲜度：NapCat 重启后会把离线期间的消息补推，旧消息不该再回
  maxEventAgeSeconds: Number(process.env.EVENT_MAX_AGE ?? 300),
};

// 同一条消息被重复投递（服务端重发、重连补推）时只回一次
const seenIds = new Set();
const seenOrder = [];
function alreadySeen(ev) {
  const key = `${ev.group_id ?? ev.user_id ?? "?"}:${ev.message_id ?? "?"}`;
  if (ev.message_id === undefined) return false;
  if (seenIds.has(key)) return true;
  seenIds.add(key);
  seenOrder.push(key);
  if (seenOrder.length > 500) seenIds.delete(seenOrder.shift());
  return false;
}
function tooOld(ev) {
  const age = RULES.maxEventAgeSeconds;
  if (!age || typeof ev.time !== "number") return false;
  return Math.floor(Date.now() / 1000) - ev.time > age;
}

// 生成图先复制到无空格目录：CQ 码的 file= 对含空格/中文的本地路径不稳，
// 而 bot 的 groups 目录在 "D:\bot" 下。只接受这几类扩展名，大小仍走 imageMaxBytes。
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);
const MIME_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp" };
function outDir(chatKey) {
  const dir = join(CFG.imageOutDir, String(chatKey).replace(/[^A-Za-z0-9._-]/g, "_"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
function stageOutboundImage(src, chatKey) {
  const ext = extname(String(src ?? "")).toLowerCase();
  if (!IMAGE_EXT.has(ext)) throw new Error(`不支持的图片扩展名 ${ext || "?"}`);
  const st = statSync(src);
  if (!st.isFile() || st.size <= 0) throw new Error("图片文件不存在或为空");
  if (st.size > CFG.imageMaxBytes) throw new Error(`图片超过 ${CFG.imageMaxBytes} 字节`);
  const dest = join(outDir(chatKey), `gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  copyFileSync(src, dest);
  return dest.replace(/\\/g, "/");
}
async function stageOutboundUrl(url, chatKey) {
  if (!url) throw new Error("没有图片地址");
  const img = await loadImage(url);
  if (!img?.data) throw new Error("下载不到图片");
  const ext = MIME_EXT[img.mediaType] || ".jpg";
  const dest = join(outDir(chatKey), `search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  await fsp.writeFile(dest, Buffer.from(img.data, "base64"));
  return dest.replace(/\\/g, "/");
}

// 发送节奏：同群/同私聊串行排队，两条之间至少 minGapMs；滚动 1 小时最多 hourlyCap 条。
// 超限只返回 ok=false，不重试也不补发——风控面前宁可少说一句，调用方负责记日志。
// hourlyCap 不传时运行时读 CFG（测试可动态改额度）；传数字/函数则固定。
export function createSendGate({ minGapMs = CFG.sendMinGapMs, hourlyCap = null, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const chains = new Map();
  const state = new Map();
  const capOf = typeof hourlyCap === "function" ? hourlyCap : () => (hourlyCap ?? CFG.sendHourlyCap);
  function run(chatKey, send) {
    const key = String(chatKey);
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      let st = state.get(key);
      if (!st) { st = { last: 0, times: [] }; state.set(key, st); }
      let t = now();
      while (st.times.length && t - st.times[0] >= 3_600_000) st.times.shift();
      const cap = capOf();
      if (cap > 0 && st.times.length >= cap) return { ok: false, reason: "hourly", sent: st.times.length };
      const wait = st.last ? st.last + minGapMs - t : 0;
      if (wait > 0) { await sleep(wait); t = now(); }
      st.last = t;
      st.times.push(t);
      const value = await send();
      return { ok: true, value, waitedMs: Math.max(0, wait) };
    });
    chains.set(key, next.catch(() => {}));
    return next;
  }
  // "当前是否已满"查询，给接收侧用：额度打满的会话同禁言一样只留档不进模型
  // （生成完再被闸门丢掉是白烧额度，2026-10-30）。幂等清理过期时间戳。
  // TOCTOU 说明：排队中的 run 在 minGap sleep 期间还没 push 时间戳，capped() 会**低估**在途量——
  // 方向安全（run 侧 L90 会二次拦截，绝不超发），最坏只是窗口边界多烧一轮模型，不值得加锁。
  run.capped = (chatKey) => {
    const st = state.get(String(chatKey));
    if (!st || !st.times.length) return false;
    const cap = capOf();
    if (cap <= 0) return false;
    const t = now();
    while (st.times.length && t - st.times[0] >= 3_600_000) st.times.shift();
    return st.times.length >= cap;
  };
  return run;
}
// ImageGen 异步：主回合只回一句，真正生成在独立 SDK 会话；任务落盘，重启后恢复未发的图。
const drawChains = new Map();
let drawActive = 0;
const drawWaiters = [];
function acquireDrawSlot() {
  return new Promise((resolve) => {
    const go = () => { drawActive++; resolve(); };
    if (drawActive < 1) go(); else drawWaiters.push(go);
  });
}
function releaseDrawSlot() {
  drawActive = Math.max(0, drawActive - 1);
  const go = drawWaiters.shift();
  if (go) go();
}

async function runDrawJob(job, sendTo, runDraw) {
  const dir = job.dir ?? groupDir(job.chatKey);
  let cur = readJobs(dir).find((j) => j.id === job.id) ?? job;
  await acquireDrawSlot();
  try {
    if (cur.state === "done" || cur.state === "failed") return;
    let dest = cur.stageDest;
    if (!dest) {
      updateJob(dir, job.id, { state: "running", startedAt: Date.now(), updatedAt: Date.now() });
      const path = await runDraw(job.prompt, { chatKey: job.chatKey });
      dest = stageOutboundImage(path, job.chatKey);
      updateJob(dir, job.id, { stageDest: dest, updatedAt: Date.now() });
    }
    cur = readJobs(dir).find((j) => j.id === job.id) ?? cur;
    if (!cur.sentAt) {
      const ok = await sendTo(job.chatKey, "画好了，给你。");
      if (ok === false) { updateJob(dir, job.id, { state: "failed", error: "send-cap", updatedAt: Date.now() }); return; }
      updateJob(dir, job.id, { state: "sent", sentAt: Date.now(), updatedAt: Date.now() });
      cur = readJobs(dir).find((j) => j.id === job.id) ?? cur;
    }
    await new Promise((r) => setTimeout(r, CFG.splitGapMs));
    const attempts = Number(cur.imageAttempts ?? 0) + 1;
    // 审计修复（I18 幂等）：发图前先落「发送已发起」标记——发送成功落 done、失败清标记；
    // 发送中崩溃时恢复路径看到标记残留 → 不重发（宁漏一张图，不向群里重发）。
    updateJob(dir, job.id, { imageAttempts: attempts, imageSendingAt: Date.now(), updatedAt: Date.now() });
    const ok2 = await sendTo(job.chatKey, `[CQ:image,file=${dest}]`);
    if (ok2 === false) {
      updateJob(dir, job.id, { imageSendingAt: 0, ...(attempts >= 2 ? { state: "failed", error: "image-send" } : {}), updatedAt: Date.now() });
      return;
    }
    updateJob(dir, job.id, { state: "done", imageSendingAt: 0, updatedAt: Date.now() });
  } catch (e) {
    console.log(`[${job.chatKey}] 异步画图失败：${e.message ?? e}`);
    updateJob(dir, job.id, { state: "failed", error: String(e?.message ?? e).slice(0, 120), updatedAt: Date.now() });
    try { if (!cur.sentAt) await sendTo(job.chatKey, "图没画出来，你再来一次？"); } catch {}
  } finally {
    releaseDrawSlot();
  }
}

export function startAsyncDraw({ chatKey, prompt, name = "image", sendTo, runDraw = generateImage }) {
  const job = {
    id: `draw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chatKey, prompt, name, state: "queued", createdAt: Date.now(), updatedAt: Date.now(), attempts: 0,
  };
  const dir = groupDir(chatKey);
  if (CFG.drawJobPersist) {
    upsertJob(dir, job);
    pruneJobs(dir, { keep: CFG.drawJobMaxKeep });
  }
  const prev = drawChains.get(chatKey) ?? Promise.resolve();
  const next = prev.then(() => runDrawJob(job, sendTo, runDraw)).catch(() => {});
  drawChains.set(chatKey, next);
  return next;
}

// 启动时恢复：未完成/已发完成语未发图的 job；旧 job 超过 24h 不重跑。
// 审计修复：①恢复发送必须仍在本轮白名单内——曾画图后又被移出白名单的群，重启不得再向它补发
// 完成语/图（发送白名单是发送侧不变量）；②发图动作已发起但结果未知（发送中崩溃）的任务不重发
// （宁漏一张图，不向群里重发），明确标 failed 等主人重试。
export async function recoverDrawJobs({ sendTo, runDraw = generateImage, root = GROUPS_ROOT } = {}) {
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(root, d.name)); } catch { return 0; }
  let n = 0;
  for (const dir of dirs) {
    for (const job of readJobs(dir)) {
      if (job.state === "done" || job.state === "failed") continue;
      if (Date.now() - Number(job.createdAt ?? 0) > 24 * 3600_000) {
        updateJob(dir, job.id, { state: "failed", error: "expired", updatedAt: Date.now() });
        continue;
      }
      const ck = String(job.chatKey ?? "");
      const inWhitelist = ck.startsWith("g:")
        ? groupAllowed(ck.slice(2))
        : ck.startsWith("p:")
          ? RULES.allowPrivate.map(String).includes(ck.slice(2)) || CFG.owners.includes(ck.slice(2))
          : false;
      if (!inWhitelist) {
        updateJob(dir, job.id, { state: "failed", error: "out-of-whitelist", updatedAt: Date.now() });
        continue;
      }
      if (job.state === "sent" && Number(job.imageSendingAt ?? 0) > 0) {
        updateJob(dir, job.id, { state: "failed", error: "image-send-interrupted", updatedAt: Date.now() });
        continue;
      }
      updateJob(dir, job.id, { state: "queued", imageSendingAt: 0, updatedAt: Date.now() });
      const prev = drawChains.get(job.chatKey) ?? Promise.resolve();
      const next = prev.then(() => runDrawJob({ ...job, state: "queued", dir }, sendTo, runDraw)).catch(() => {});
      drawChains.set(job.chatKey, next);
      n++;
    }
  }
  if (n) console.log(`[画图恢复] 重新排队 ${n} 个未完成任务`);
  return n;
}

// 兼容 message 是字符串的实现（NapCat 可以选 string 格式，CQ 码得自己拆）
function parseCq(raw) {
  const text = String(raw ?? "");
  const out = [];
  let last = 0;
  const re = /\[CQ:([a-zA-Z]+),([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const before = text.slice(last, m.index);
    if (before) out.push({ type: "text", text: before });
    last = m.index + m[0].length;
    const type = m[1].toLowerCase();
    const attrs = Object.fromEntries(m[2].split(",").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)]; }));
    if (type === "at") out.push({ type: "at", qq: attrs.qq });
    else if (type === "image") out.push({ type: "image", url: attrs.url, file: attrs.file });
    else if (type === "face") out.push({ type: "face", id: attrs.id });
    else if (type === "reply" || type === "quote") out.push({ type, id: attrs.id, uid: attrs.uid });
    else if (type === "json" || type === "xml") out.push({ type, data: { data: attrs.data ?? attrs.content ?? "" } });
    else if (type === "forward" || type === "node") out.push({ type, data: { id: attrs.id, content: attrs.content } });
  }
  const tail = text.slice(last);
  if (tail) out.push({ type: "text", text: tail });
  return out;
}

// 群禁言感知：被禁言（含全员禁言）期间消息只留档不调模型——省额度（2026-10-30）。
// mutedUntil: group_id(number) → 解禁时间戳 ms；带 30s 缓冲防边界抖动。
// 状态必须落盘：禁言/解禁都发生在进程生命周期之外时（停机期被禁言、重启后解禁、
// 禁言期间重启），notice 是补不回来的——实测重启后整个剩余禁言期都在照常调模型、
// 发送全部 retcode=1200，白烧额度。落盘 groupsDir/mute-state.json；
// 恢复时残余禁言封顶 10 分钟：停机期间被提前解禁最多多沉默 10 分钟就自愈，
// 若其实还在禁言，恢复发送后连续 1200 会再续上（noteSendFailure 兜底）。
const MUTE_FILE = "mute-state.json";
const MUTE_RESTART_CAP_MS = 10 * 60_000;   // 重启后最多再信落盘状态 10 分钟
const MUTE_SELFHEAL_MS = 10 * 60_000;      // 连续 1200 自愈的静默时长
const STREAK_WINDOW_MS = 60_000;           // 两次 1200 落在这个窗内才算"连续"（跨小时的两次失败不该累计）
const mutedUntil = new Map();
const sendFailStreak = new Map();          // group_id → 连续发送失败次数（成功即清零）

export function persistMutes(dir = CFG.groupsDir) {
  try {
    mkdirSync(dir, { recursive: true });
    const live = {};
    for (const [gid, until] of mutedUntil) if (until > Date.now()) live[String(gid)] = until;
    writeFileSync(join(dir, MUTE_FILE), JSON.stringify(live));
  } catch (e) { console.log(`[onebot] 禁言状态落盘失败：${e.message}`); }
}

export function loadMutes(dir = CFG.groupsDir) {
  try {
    const obj = JSON.parse(readFileSync(join(dir, MUTE_FILE), "utf8"));
    const now = Date.now();
    for (const [gid, until] of Object.entries(obj)) {
      const ms = Number(until);
      if (!Number.isFinite(ms) || ms <= now) continue;
      mutedUntil.set(Number(gid), Math.min(ms, now + MUTE_RESTART_CAP_MS));
    }
  } catch { /* 没有文件或内容坏了：当无禁言 */ }
}
loadMutes();   // 进程启动即恢复：禁言中重启不再裸跑

export function groupBanNotice(frame, selfId) {
  if (frame?.notice_type !== "group_ban") return null;
  const gid = Number(frame.group_id);
  if (!Number.isFinite(gid)) return null;
  const sub = String(frame.sub_type ?? "");
  const target = Number(frame.user_id ?? 0);
  // self 优先用登录信息；登录信息没回来时退回事件自带的 self_id，否则解禁 notice 会被当成"禁别人"丢掉
  const self = selfId != null ? Number(selfId) : (frame.self_id != null ? Number(frame.self_id) : null);
  const mine = self != null && (target === self || target === 0);   // 定向禁我 / 全员禁言（含解除）
  if (!mine) return null;
  if (sub === "ban" && Number(frame.duration ?? 0) > 0) {
    mutedUntil.set(gid, Date.now() + Number(frame.duration) * 1000 + 30_000);
    sendFailStreak.delete(gid);
    persistMutes();
    return `本号被${target === 0 ? "全员" : ""}禁言 ${frame.duration}s，期间消息只留档不处理`;
  }
  if (sub === "lift_ban") {
    const was = mutedUntil.delete(gid);
    sendFailStreak.delete(gid);
    persistMutes();   // 无条件落盘：内存无状态但文件里有旧值时（persist 曾失败/测试 reset），解除也要清掉文件
    return "禁言已解除，恢复正常处理";
  }
  return null;
}
export function isGroupMuted(groupId) {
  return (mutedUntil.get(Number(groupId)) ?? 0) > Date.now();
}
export function muteRemaining(groupId) {
  const until = mutedUntil.get(Number(groupId)) ?? 0;
  return until > Date.now() ? until - Date.now() : 0;
}
export function _resetMutes() { mutedUntil.clear(); sendFailStreak.clear(); }

// 权威禁言同步（2026-11-01）：NapCat 的 get_group_member_info 返回本号在群里的 shut_up_timestamp（秒）。
// 有了它就**不用靠落盘值封顶猜**：重启/断线后直接问服务端，禁言真实剩余多少就静默多少；
// 已经解禁则立刻清标记（连停机期错过的 lift_ban 也一并补上）。落盘值降级为"查不到时的离线兜底"。
// 单个群查询失败只跳过该群，不清除内存里已有的禁言（避免网络抖动把禁言误判成已解除）。
export async function syncMutesFromServer(api, selfId, groupIds = []) {
  const self = Number(selfId);
  if (!Number.isFinite(self) || !groupIds.length) return 0;
  let still = 0;
  for (const gid of groupIds) {
    const g = Number(gid);
    if (!Number.isFinite(g)) continue;
    let r;
    try {
      r = await raceTimeout(api.call("get_group_member_info", { group_id: g, user_id: self, no_cache: true }), 5000, "禁言同步");
    } catch { continue; }
    const raw = r?.shut_up_timestamp ?? r?.data?.shut_up_timestamp;
    const untilMs = Number(raw ?? 0) * 1000;
    if (Number.isFinite(untilMs) && untilMs > Date.now()) {
      mutedUntil.set(g, untilMs + 30_000);
      sendFailStreak.delete(g);
      still++;
    } else {
      // 查到了且明确没禁言：清标记（包括落盘带来的陈旧值）
      mutedUntil.delete(g);
      sendFailStreak.delete(g);
    }
  }
  persistMutes();
  return still;
}

// 断线重连视同一次重启：断线期间错过的解禁 notice 不会补发，把内存残余禁言按重启口径封顶，
// 避免"ban notice 收过、lift_ban 在断线期错过"导致整段剩余禁言期白沉默。
// 注意这只是**过渡值**：open 处理器连上后会立刻用 syncMutesFromServer 问服务端覆盖成真实到期时间。
export function capMutesForReconnect() {
  const now = Date.now();
  for (const [gid, until] of mutedUntil) {
    if (until > now) mutedUntil.set(gid, Math.min(until, now + MUTE_RESTART_CAP_MS));
  }
}

// 发送侧自愈兜底：OneBot 没有禁言状态查询 API，notice 错过（停机期禁言/解禁）时靠它收敛。
// 禁言中 NapCat sendMsg 稳定返回 retcode=1200：同群连续 2 次即视为仍在禁言，静默 10 分钟。
// 同一轮拆条连发全失败恰好构成连续——禁言下本该如此，当轮即触发自愈是预期行为。
// 单次失败不动作——风控/偶发故障只挡个别消息，不该让整群沉默。任意一次成功即清零。
export function noteSendSuccess(target) {
  const gid = Number(target?.group_id);
  if (Number.isFinite(gid)) sendFailStreak.delete(gid);
}
export function noteSendFailure(target, err) {
  const gid = Number(target?.group_id);
  if (!Number.isFinite(gid) || !/\bretcode=1200\b/.test(String(err?.message ?? err))) return;
  const now = Date.now();
  const cur = sendFailStreak.get(gid);
  const n = cur && now - cur.at <= STREAK_WINDOW_MS ? cur.n : 0;   // 离上次失败太久不算连续
  sendFailStreak.set(gid, { n: n + 1, at: now });
  if (n + 1 < 2 || isGroupMuted(gid)) return;   // 已在禁言中时不重设时长（那是 notice 给的权威值）
  mutedUntil.set(gid, now + MUTE_SELFHEAL_MS + 30_000);
  persistMutes();
  return "连续发送失败 retcode=1200，疑似仍在禁言：本群静默 10 分钟";
}

function segments(msg) {
  const arr = msg?.message;
  if (Array.isArray(arr)) return arr;
  return typeof arr === "string" ? parseCq(arr) : [{ type: "text", text: String(arr ?? "") }];
}

// OneBot v11 数组消息：真实 NapCat 把字段放在 data 里；本地测试/CQ 码路径放顶层，两种都认
function segData(s) {
  return s?.data && typeof s.data === "object" ? s.data : s;
}

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// QQ 分享卡片是 json/xml 段：正文和真实链接在 meta.detail_1.desc / qqdocurl 里。
// 只抽这几个字段，绝不把整段 JSON（可能带卡片 token）塞进提示词。
function buildCardText({ title = "", desc = "", prompt = "", link = "" } = {}) {
  const parts = [];
  if (link) parts.push(`链接：${/^https?:\/\//i.test(link) ? link : "https://" + link}`);
  if (title) parts.push(`标题：${title}`);
  if (desc) parts.push(`正文：${desc}`);
  if (prompt && prompt !== desc && !prompt.includes(desc) && !desc.includes(prompt)) parts.push(`摘要：${prompt}`);
  const t = parts.join("；");
  return t ? `【卡片】${t.slice(0, 300)}` : "【卡片】（没有可读内容）";
}

function cardText(s) {
  const d = segData(s);
  if (s.type === "card" || s.type === "share") {
    return buildCardText({ title: d.title, desc: d.desc ?? d.content, link: d.url ?? d.jumpUrl });
  }
  const raw = d?.data ?? d?.content ?? d?.xml ?? d?.json ?? "";
  if (!raw) return "【卡片】（没有可读内容）";
  if (s.type === "xml") {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(String(raw));
      return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, "")).trim() : "";
    };
    return buildCardText({ title: pick("title"), desc: pick("summary") || pick("desc"), link: pick("url") });
  }
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(decodeEntities(raw)); } catch { return "【卡片】（解析失败）"; }
  }
  if (!obj || typeof obj !== "object") return "【卡片】（解析失败）";
  const meta = obj?.meta?.detail_1 ?? obj?.meta?.news ?? obj?.meta?.music ?? obj?.meta?.video
    ?? (obj?.meta ? Object.values(obj.meta).find((x) => x && typeof x === "object") : null) ?? {};
  const desc = meta.desc ?? meta.summary ?? meta.content ?? "";
  return buildCardText({
    title: meta.title ?? meta.name ?? "",
    desc,
    prompt: obj.prompt ?? "",
    link: meta.qqdocurl ?? meta.jumpUrl ?? meta.jump_url ?? meta.url ?? meta.source_url ?? "",
  });
}

export function textOf(segs) {
  return segs.map((s) => {
    if (s.type === "text") return segData(s).text ?? "";
    if (s.type === "json" || s.type === "xml" || s.type === "card" || s.type === "share") return cardText(s);
    return "";
  }).join("").trim();
}

function raceTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时`)), ms))]);
}

// 转发消息是 forward/node 段，里面还可能套卡片或再套转发；递归展开，限制深度/条数/字数。
async function renderSegmentText(segs, api, depth = 0, seen = new Set(), scope = "", collector = null) {
  const out = [];
  for (const s of segs) {
    if (s.type === "forward" || s.type === "node") out.push(await expandForwardSegment(s, api, depth, seen, scope, collector));
    else if (s.type === "text") out.push(segData(s).text ?? "");
    else if (s.type === "json" || s.type === "xml" || s.type === "card" || s.type === "share") out.push(cardText(s));
    else if (s.type === "image") {
      const ref = segData(s).url || segData(s).file;
      if (collector && ref) collector.push(ref);
      out.push("[图片]");
    }
    else if (s.type === "face") out.push("[表情]");
    else if (s.type === "video") out.push("[视频]");
    else if (s.type === "record") out.push("[语音]");
    else if (s.type === "at") out.push(`@${segData(s).qq ?? ""}`);
  }
  return out.join("").trim();
}

async function renderNodes(nodes, api, depth, seen, scope = "", collector = null) {
  const list = Array.isArray(nodes) ? nodes : [];
  const lines = [];
  for (const n of list.slice(0, 30)) {
    const node = n?.type === "node" ? n.data : n;
    const rawMsg = node?.message ?? node?.content;
    const segs = Array.isArray(rawMsg) ? segments({ message: rawMsg }) : (typeof rawMsg === "string" ? parseCq(rawMsg) : []);
    const t = await renderSegmentText(segs, api, depth + 1, seen, scope, collector);
    const who = node?.sender?.card || node?.sender?.nickname || node?.nickname || "";
    if (t) lines.push(`${who ? who + "：" : ""}${t}`);
    if (lines.join("\n").length > 1800) { lines.push("…（转发过长，已截断）"); break; }
  }
  return `【转发消息 ${list.length} 条】\n${lines.join("\n")}`.slice(0, 2200);
}

async function expandForwardSegment(seg, api, depth = 0, seen = new Set(), scope = "", collector = null) {
  if (depth > CFG.forwardDepth) return "【转发消息（嵌套过深）】";
  const d = segData(seg);
  if (seg.type === "node") {
    const content = d?.content ?? d?.message;
    if (Array.isArray(content)) return renderSegmentText(segments({ message: content }), api, depth + 1, seen, scope, collector);
  }
  if (Array.isArray(d?.content)) return renderNodes(d.content, api, depth + 1, seen, scope, collector);
  const id = d?.id ?? d?.message_id ?? "";
  if (!id) return "【转发消息（没有 id）】";
  const key = String(id);
  if (seen.has(key)) return "【转发消息（循环引用）】";
  seen.add(key);
  const cacheKey = scope ? `forward:${scope}:${key}` : "";
  const imageKey = scope ? `forwardimg:${scope}:${key}` : "";
  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit != null) {
      if (collector && imageKey) {
        const imgs = cacheGet(imageKey);
        if (Array.isArray(imgs)) collector.push(...imgs);
      }
      return hit;
    }
  }
  let res;
  try {
    res = await raceTimeout(api.call("get_forward_msg", { id: key }), 5000, "get_forward_msg");
  } catch {
    try {
      res = await raceTimeout(api.call("get_forward_msg", { message_id: key }), 5000, "get_forward_msg");
    } catch {
      return "【转发消息（读不到内容）】";
    }
  }
  const nodes = res?.messages ?? res?.message ?? (Array.isArray(res) ? res : []);
  const imgs = [];
  const text = await renderNodes(nodes, api, depth + 1, seen, scope, imgs);
  if (cacheKey) {
    cacheSet(cacheKey, text, { ttlMs: CFG.quoteForwardCacheTtlMs, max: CFG.quoteForwardCacheMax });
    cacheSet(imageKey, imgs, { ttlMs: CFG.quoteForwardCacheTtlMs, max: CFG.quoteForwardCacheMax });
  }
  if (collector && imgs.length) collector.push(...imgs);
  return text;
}

async function renderForwardText(segs, api, scope = "", collector = null) {
  for (const s of segs) {
    if (s.type === "forward" || s.type === "node") {
      const t = await expandForwardSegment(s, api, 0, new Set(), scope, collector);
      if (t) return t;
    }
  }
  return "";
}

export async function renderMessageText(segs, api, scope = "", collector = null) {
  const out = [];
  for (const s of segs) {
    if (s.type === "forward" || s.type === "node") out.push(await expandForwardSegment(s, api, 0, new Set(), scope, collector));
    else if (s.type === "text") out.push(segData(s).text ?? "");
    else if (s.type === "json" || s.type === "xml" || s.type === "card" || s.type === "share") out.push(cardText(s));
    else if (s.type === "image") {
      const ref = segData(s).url || segData(s).file;
      if (collector && ref) collector.push(ref);
      out.push("[图片]");
    }
    else if (s.type === "face") out.push("[表情]");
  }
  return out.filter(Boolean).join("\n").trim();
}
function imagesOf(segs) {
  return segs.filter((s) => s.type === "image").map((s) => { const d = segData(s); return d.url || d.file; }).filter(Boolean);
}

// 真实 NapCat 的 reply/quote 段把 id 放在 data 里；本地 CQ 字符串形状放在顶层，两种都认。
export function quoteIdOf(segs) {
  const s = segs.find((x) => x.type === "reply" || x.type === "quote");
  const d = s ? segData(s) : null;
  return String(d?.id ?? d?.message_id ?? "");
}

// 引用消息回查：文本/卡片走 renderMessageText，图片单独收集给 onEvent 下载喂模型。
export async function quotedContextOf(messageId, api, { chatKey = "", selfId = null } = {}) {
  const cacheKey = CFG.quoteForwardCache && chatKey ? `quote:${chatKey}:${messageId}` : "";
  if (cacheKey) {
    const hit = cacheGet(cacheKey);
    if (hit) return hit;
  }
  const q = await raceTimeout(api.call("get_msg", { message_id: Number(messageId) }), 3000, "get_msg");
  // 同源校验（2026-10-30）：回查结果必须属于当前会话。NapCat 的 message_id 是
  // MD5(msgId|chatType|peerUid) 截断 int32，get_msg 拿数字直接查一张群聊/私聊混用的
  // 全局 LRU（napcat.mjs createUniqueMsgId/getMsgIdAndPeerByShortId）——伪造 reply id
  // 盲探很难命中，但合法群内引用撞上别的会话的短号（31 位截断，5000 条 LRU 下累计
  // 千分之几）会静默捞到私聊原文。越界一律当"读不到"处理，不缓存。
  const [kind, scopeId] = String(chatKey ?? "").split(":");
  const qPeer = q?.sender?.user_id ?? q?.user_id;
  // 数字群号按数值比，非数字 key（测试/特殊场景）退回字符串比，别让 NaN 恒拒
  const sameScope = (a, b) => (Number(a) === Number(b) && Number.isFinite(Number(a))) || String(a) === String(b);
  let scopeOk = true;
  if (kind === "g") {
    scopeOk = q?.group_id != null && sameScope(q.group_id, scopeId);
  } else if (kind === "p") {
    if (q?.group_id != null) scopeOk = false;   // 私聊里引用到群消息：越界
    else if (selfId != null) {
      // fail-closed：发送者既不是对方也不是她本人（或根本拿不到发送者）都不放行。
      // 真实 NapCat 私聊回包 user_id 必填；selfId 由 connect 传入（登录信息 ?? frame.self_id）
      scopeOk = qPeer != null && (sameScope(qPeer, scopeId) || sameScope(qPeer, selfId));
    }
  }
  // uid=被引用消息的发送者（2026-11-03 C）：NapCat 的 reply 段只带 id 不带 uid，
  // 这次回查的 get_msg 本来就拿到了发送者，顺手带出来给 onEvent 判"这句是不是在回复她"。
  // name=发送者显示名（2026-11-03 ①）：同样零新增调用，给【引用的消息】署名用；
  // 名片是群友自己改的，必须过 safeName（洗 uid=/换行/截 24 字）。越界时一律 null。
  if (!scopeOk) return { text: "", images: [], uid: null, name: null };
  const segs = segments(q);
  const forwardImages = [];
  const text = await renderMessageText(segs, api, chatKey, forwardImages);
  const images = [...new Set([...imagesOf(segs), ...forwardImages])].slice(0, CFG.maxImagesPerMessage);
  const qName = String(q?.sender?.card || q?.sender?.nickname || q?.card || q?.nickname || "");
  const out = {
    text: text.slice(0, 800), images,
    uid: qPeer != null ? String(qPeer) : null,
    // 审查 O2：名片全是 uid=/=号时被洗成空串——统一归 null，与"拿不到就 null"契约一致
    name: safeName(qName) || null,
  };
  if (cacheKey) cacheSet(cacheKey, out, { ttlMs: CFG.quoteForwardCacheTtlMs, max: CFG.quoteForwardCacheMax });
  return out;
}
function mentionedSelf(segs, selfId) {
  return !!selfId && segs.some((s) => s.type === "at" && String(segData(s).qq) === String(selfId));
}

// WP1-C2 关系解析：谁在被 @、是否回复。称呼（addressAliases）只在**消息正文**里匹配，
// 绝不拿群名或别人昵称来认（测试群名里就带"千姐"，这是刻意的坑）；称呼命中只算弱证据。
export function relationsOf(segs, selfId) {
  const to = [];
  let atMe = false, replyTo = null;
  for (const s of segs) {
    const d = segData(s);
    if (s.type === "at") {
      const qq = d?.qq != null ? String(d.qq) : "";
      if (qq) {
        to.push(qq);
        if (selfId != null && qq === String(selfId)) atMe = true;
      }
    } else if (s.type === "reply" || s.type === "quote") {
      // 拿得到什么记什么，拿不到就 null，别猜
      const r = {};
      if (d?.id != null && d.id !== "") r.id = d.id;
      if (d?.uid != null && d.uid !== "") r.uid = String(d.uid);
      else if (d?.user_id != null && d.user_id !== "") r.uid = String(d.user_id);
      if (Object.keys(r).length) replyTo = r;
    }
  }
  const atMeWeak = CFG.addressAliases.some((a) => a && textOf(segs).includes(a));
  return { to, atMe, atMeWeak, replyTo };
}

function groupAllowed(groupId) {
  // 有群名单就只认名单；空名单不再等于“全群放行”，必须显式 ALLOW_ALL=1
  if (RULES.allowGroups.length) return RULES.allowGroups.includes(String(groupId));
  return Boolean(CFG.allowAllGroups);
}

export function shouldReply(ev, selfId) {
  if (ev.post_type !== "message") return false;
  if (selfId && String(ev.user_id) === String(selfId)) return false; // 别回自己，防刷屏死循环
  if (tooOld(ev)) return false;
  if (alreadySeen(ev)) return false;
  const segs = segments(ev);
  if (!textOf(segs) && !imagesOf(segs).length && !ev._forwardText && !ev._forwardImages?.length) return false;
  if (ev.message_type === "group") {
    if (!groupAllowed(ev.group_id)) return false;
    if (RULES.requireAtInGroup && !mentionedSelf(segs, selfId)) return false;
  } else if (ev.message_type === "private") {
    // 私聊面默认关闭：只认主人 + ALLOW_PRIVATE 白名单，否则陌生人一句"在吗"就是一次实弹
    const uid = String(ev.user_id);
    const allowed = RULES.allowPrivate.map(String).includes(uid) || CFG.owners.includes(uid);
    if (!allowed) return false;
  } else {
    return false;
  }
  return true;
}

// WP1-C1 旁路记录：白名单群每条**带正文**的消息都落 recent.jsonl，不管她回不回。
// 必须在所有"回不回"的判定之前调用（限流挡掉的、她跳过的、10 秒窗口丢弃的都要留档）。
// dir 参数给测试注入用；生产走 brain.groupDir —— 和会话/记事本同一个目录。
export function recordGroupRecent(ev, selfId, { dir = null } = {}) {
  if (ev?.post_type !== "message" || ev.message_type !== "group") return false;
  // 她本人的话只由 sendPaced 回写通道进缓冲（2026-11-03 审查修复）：NapCat 实测不回推她发的
  // 消息，事件通道平时收不到；哪天真回推了，同一条会双写（去重只比末条，挡不住中间插入别人
  // 消息的情况）。回写通道保证必有，事件通道就此关门。
  if (selfId != null && String(ev.user_id) === String(selfId)) return false;
  if (!groupAllowed(ev.group_id)) return false;
  const segs = segments(ev);
  const text = [ev._forwardText, textOf(segs)].filter(Boolean).join("\n");
  if (!text) return false; // 纯图/纯表情没有可转述的正文，渲染不出有意义的行
  const target = dir ?? groupDir(`g:${ev.group_id}`);
  // NapCat 断线重连会把已投递的消息原样补推（shouldReply 有 alreadySeen 兜回话，但旁路记录在它前面），
  // 这里挡掉紧邻的重复投递，免得 L4 里同一句出现两次
  const last = readRecent(target, 1)[0];
  if (last && ev.message_id != null && String(last.id) === String(ev.message_id)) return false;
  const rel = relationsOf(segs, selfId);
  const sender = ev.sender ?? {};
  const rec = {
    id: ev.message_id,
    ts: ev.time,
    uid: String(ev.user_id ?? ""),
    name: sender.card || sender.nickname || String(ev.user_id ?? ""),
    to: rel.to,
    replyTo: rel.replyTo,
    text,
    atMe: rel.atMe,
    mine: selfId != null && String(ev.user_id) === String(selfId),
  };
  appendRecent(target, rec, { max: CFG.recentBufferSize });
  return true;
}

// 多图并发、按原顺序返回；单张失败只记日志。当前消息与引用图共享 4 张/8MB 上限。
async function loadImagesInOrder(refs, { origin, logLabel = "图片失败", cacheDir = "", cacheKeyPrefix = "" } = {}) {
  const list = await Promise.all(refs.map(async (ref, i) => {
    try {
      const img = cacheDir && cacheKeyPrefix
        ? await loadImageCached(ref, { dir: cacheDir, key: `${cacheKeyPrefix}${i}`, ttlMs: CFG.quoteCacheTtlMs })
        : await loadImage(ref);
      return img ? { i, img } : null;
    } catch (e) {
      console.log(`[${logLabel}] ${e.message}`);
      return null;
    }
  }));
  return list.filter(Boolean).sort((a, b) => a.i - b.i).map((x) => (origin ? { ...x.img, origin } : x.img));
}

// 群聊连续短文本合并：只合并“纯文本、非 @/非回复、非 owner/admin”的普通聊天。
// 合并后按 1、2、3 标发言顺序，避免模型把多个人的话当成一个人说的。
const mergeBuffers = new Map();
function mergeInbound(chatKey, item, ms) {
  return new Promise((resolve) => {
    let b = mergeBuffers.get(chatKey);
    if (!b) {
      b = {
        items: [],
        waiters: [],
        timer: setTimeout(() => {
          const buf = b;
          mergeBuffers.delete(chatKey);
          for (let i = 0; i < buf.waiters.length; i++) {
            buf.waiters[i](i === 0 ? buf.items : null);
          }
        }, ms),
      };
      mergeBuffers.set(chatKey, b);
    }
    b.items.push(item);
    b.waiters.push(resolve);
  });
}

function mergeInboundText(items) {
  const lines = items.map((it, i) => `${i + 1}｜【${safeName(it.name) || "?"}】${it.text}`);
  return [...lines.join("\n")].slice(0, Math.max(200, CFG.maxTextChars * 2)).join("");
}

// 核心处理：喂一条 OneBot 事件进来，返回要发出去的话（ask 可注入，方便单测路由）
export async function onEvent(ev, { getSelfId, getSelfName, askBrain = ask, sendAsync, runDraw = generateImage, isSendCapped = null } = {}) {
  const selfId = getSelfId?.();
  if (!shouldReply(ev, selfId)) return null;

  const segs = segments(ev);
  const isGroup = ev.message_type === "group";
  const chatKey = isGroup ? `g:${ev.group_id}` : `p:${ev.user_id}`;
  // 禁言期间：旁路缓冲（connect 里的 recordGroupRecent）照常留档，回复链路整体跳过省额度
  if (isGroup && isGroupMuted(ev.group_id)) {
    console.log(`[${chatKey}] 本号禁言中，本条只留档不处理`);
    return null;
  }
  // 发送额度打满：同禁言只留档不进模型——否则生成完再被闸门丢掉，白烧一轮额度（2026-10-30）
  if (isSendCapped?.(chatKey)) {
    console.log(`[${chatKey}] 本会话发送额度已满（滚动 1 小时），消息只留档不处理`);
    return null;
  }
  const maxImgs = CFG.maxImagesPerMessage;
  // WP11：先在后台下载当前图，同时等引用回查；两者没有依赖
  const currentP = loadImagesInOrder(imagesOf(segs).slice(0, maxImgs));
  let qc = null;
  try { qc = await (ev._quotePromise ?? Promise.resolve(null)); } catch {}
  const quotedText = qc?.text ?? ev._quotedText ?? "";
  const quotedName = qc?.name ?? ev._quotedName ?? "";
  const quotedRefs = qc?.images ?? ev._quotedImages ?? [];
  // 点名三层判定（2026-11-03 调研 A/B/C）：硬证据=@她 或 回复指向她；称呼命中只算弱证据，
  // 单独给提示不点名。私聊恒为点名（沿用旧语义）。
  // uid 回退链（审查修复）：经同源校验的回查值优先于 reply 段自带 uid——NapCat 实测段内根本
  // 不下发 uid，而 string 消息模式下 parseCq 会把群友字面输入的 [CQ:reply,...,uid=...] 解析
  // 成段数据，属可伪造面；段内 uid 只作 array 段实现（可信来源）的兜底。
  const rel = relationsOf(segs, selfId);
  const replyUid = qc?.uid ?? ev._quotedUid ?? rel.replyTo?.uid ?? null;
  const replyToMe = isGroup && replyUid != null && selfId != null && String(replyUid) === String(selfId);
  const addressedHard = !isGroup || rel.atMe || replyToMe;
  // 按码点截断：slice 按 UTF-16 code unit 会把代理对（emoji）切一半
  const ownText = [...textOf(segs)].slice(0, CFG.maxTextChars).join("");
  const text = [
    ev._forwardText,
    // ①（2026-11-03）署名来自 get_msg 的 sender（已过 safeName）；拿不到就维持原形状不加"·?"
    quotedText ? `【引用的消息${quotedName ? `·${quotedName}` : ""}】${quotedText}` : "",
    ownText,
  ].filter(Boolean).join("\n").trim();
  const sender = ev.sender ?? {};
  const currentImgs = await currentP;
  const remaining = Math.max(0, maxImgs - currentImgs.length);
  const quoteCachePrefix = ev._quotedId ? `quote:${ev._quotedId}:` : "";
  const quoteImgs = remaining
    ? await loadImagesInOrder(quotedRefs.slice(0, remaining), {
        origin: "quote", logLabel: "引用图片失败",
        cacheDir: quoteCachePrefix ? groupDir(chatKey) : "",
        cacheKeyPrefix: quoteCachePrefix,
      })
    : [];
  const forwardRefs = ev._forwardImages ?? [];
  const remainingAfterQuote = Math.max(0, maxImgs - currentImgs.length - quoteImgs.length);
  const forwardImgs = remainingAfterQuote
    ? await loadImagesInOrder(forwardRefs.slice(0, remainingAfterQuote), { origin: "forward", logLabel: "转发图片失败" })
    : [];
  const images = [];
  let totalBytes = 0;
  for (const img of [...currentImgs, ...quoteImgs, ...forwardImgs]) {
    if ((img?.bytes ?? 0) > 0 && totalBytes + img.bytes > CFG.imageTotalBytes) break;
    totalBytes += img?.bytes ?? 0;
    images.push(img);
  }

  if (!text && !images.length) return null; // 图片下载失败/被拒时不要发空回复
  // 连续普通短文本合并：@/回复/owner/admin/图片/引用/转发/定时任务一律不合并。
  // 只合并到第一个消息的 turn；后续消息在 timer 到点后直接返回 null。
  const privileged = isGroup && (CFG.owners.includes(String(ev.user_id)) || CFG.admins.includes(String(ev.user_id)));
  const blocked = isGroup && CFG.blockedUsers.includes(String(ev.user_id));
  let askText = text;
  let mergedTurn = false;
  if (isGroup && CFG.inboundMergeMs > 0 && !addressedHard && !rel.atMeWeak && !blocked
    && images.length === 0 && !quotedText && !ev._forwardText && text && !privileged) {
    const items = await mergeInbound(chatKey, {
      text,
      name: sender.card || sender.nickname || String(ev.user_id),
    }, CFG.inboundMergeMs);
    if (!items) return null;   // 后续消息：由第一条的合并 turn 一起处理
    askText = items.length > 1 ? mergeInboundText(items) : items[0].text;
    mergedTurn = items.length > 1;
    if (mergedTurn) console.log(`[${chatKey}] 合并 ${items.length} 条短消息`);
  }
  // WP1-C3：把群聊缓冲渲染进 L4（缓冲里含当前这条，和施工图示例一致）。省略疑似指令时记一笔日志。
  let recentLines;
  if (isGroup) {
    const block = renderRecent(readRecent(groupDir(chatKey), CFG.recentBufferSize), {
      selfId,
      selfName: getSelfName?.() || "我",
      feedN: CFG.recentFeedN,
      coref: CFG.corefEnabled,
      corefMaxAnnotated: CFG.corefMaxAnnotated,
      corefMaxPerMessage: CFG.corefMaxPerMessage,
      botAliases: CFG.addressAliases,
      replyUidOverride: replyUid != null && ev.message_id != null ? { id: ev.message_id, uid: replyUid } : null,
    });
    if (block.lines.length) recentLines = block.lines;
    if (block.coref?.annotated) console.log(`[${chatKey}] L4 指代标注 你=${block.coref.you}（?${block.coref.youAmbiguous}） 他她它=${block.coref.third}（?${block.coref.thirdAmbiguous}）`);
    if (block.omitted) console.log(`[${chatKey}] L4 省略疑似指令文本 ×${block.omitted}`);
  }
  const res = await askBrain({
    chatKey,
    text: askText,
    images,
    priority: addressedHard,
    actor: { userId: String(ev.user_id), name: sender.card || sender.nickname || String(ev.user_id), platformRole: sender.role },
    runtime: {
      group: isGroup ? String(ev.group_id) : "",
      time: new Date().toLocaleString("zh-CN", { hour12: false }),
      // 有没有被点名：@她 或 回复她算硬点名；称呼命中只给弱提示（weakAddress）；
      // 都不沾时 L4 靠 addressed=false 告诉她"接不接由你判断"
      addressed: addressedHard,
      replyToMe,
      weakAddress: isGroup && !addressedHard && rel.atMeWeak,
      merged: mergedTurn,
      speaker: { name: sender.card || sender.nickname || String(ev.user_id), relation: sender.role ? `群角色 ${sender.role}` : "" },
      ...(recentLines ? { recent: recentLines } : {}),
    },
  });
  if (res.dropped) {
    const why = res.dropped === "timeout-pause" ? "（连续超时熔断暂停中，本条不烧额度）"
      : res.dropped === "downshift" ? "（积压降载）"
        : res.dropped === "stale" ? "过旧" : "排队";
    console.log(`[${chatKey}] 丢掉一条${why}消息（等了 ${Math.round((res.ms || 0) / 1000)}s）：${text.slice(0, 16)}…`);
    return null;
  }
  if (res.silent) {
    console.log(res.quota
      ? `[${chatKey}] 限额静默（本条跳过，已换免费轨或等零点重置）：${text.slice(0, 16)}…`
      : `[${chatKey}] 她看了看这句，没接（${text.slice(0, 16)}…）`);
    return null;
  }
  const toTarget = (message) => isGroup
    ? { group_id: Number(ev.group_id), message }
    : { user_id: Number(ev.user_id), message };
  const generated = Array.isArray(res.images) ? res.images.slice(0, CFG.imageGenMaxPerTurn) : [];
  const searched = Array.isArray(res.searchImages) ? res.searchImages.slice(0, 1) : [];
  const staged = [];
  for (const src of generated) {
    try { staged.push(stageOutboundImage(src, chatKey)); }
    catch (e) { console.log(`[${chatKey}] 生成图发送准备失败：${e.message}`); }
  }
  const stagedSearch = [];
  for (const item of searched) {
    try { stagedSearch.push(await stageOutboundUrl(item?.url, chatKey)); }
    catch (e) { console.log(`[${chatKey}] 搜索图下载失败：${e.message}`); }
  }
  if (!staged.length && !stagedSearch.length) {
    // 图没准备好就不要发"画好了/找到了"这种假成功；给一句实话，让她下一轮重试
    if (generated.length) return { chatKey, turnId: res.turnId, deliveryHint: "failed", sends: [toTarget("图没发出去，你再来一次？")], meta: { ms: res.ms, retried: res.retried, error: "image stage failed", turnId: res.turnId } };
    if (searched.length) return { chatKey, turnId: res.turnId, deliveryHint: "failed", sends: [toTarget("图找到了但没发出去，你再来一次？")], meta: { ms: res.ms, retried: res.retried, error: "image download failed", turnId: res.turnId } };
  }
  if (!res.text && !staged.length && !stagedSearch.length) {
    const why = res.refused ?? res.error ?? "空回复";
    console.log(`[${chatKey}] 没回：${String(why).slice(0, 80)}（角色 ${res.role ?? "?"}）`);
    return null;
  }
  if (res.draw && res.role === "owner" && typeof sendAsync === "function") {
    console.log(`[${chatKey}] 画图排队：${String(res.draw.prompt ?? "").slice(0, 40)}…`);
    startAsyncDraw({ chatKey, prompt: res.draw.prompt, name: res.draw.name, sendTo: (_key, message) => sendAsync(message), runDraw });
  }
  const replyText = res.text || (stagedSearch.length && !staged.length ? "找到了，你看看这张。" : staged.length ? "画好了，给你。" : "");
  const sends = splitMessages(replyText, { maxChars: CFG.splitMaxChars, maxParts: CFG.splitMaxParts })
    .map((part) => toTarget(part));
  for (const file of staged) sends.push(toTarget(`[CQ:image,file=${file}]`));
  for (const file of stagedSearch) sends.push(toTarget(`[CQ:image,file=${file}]`));
  return {
    chatKey,
    turnId: res.turnId,
    sends,
    meta: { ms: res.ms, retried: res.retried, error: res.error, images: staged.length + stagedSearch.length, searchImages: stagedSearch.length, draw: Boolean(res.draw), turnId: res.turnId },
  };
}

class Api {
  constructor(socket) { this.socket = socket; this.seq = 0; this.pending = new Map(); }
  call(action, params) {
    const echo = `qf_${++this.seq}`;
    return new Promise((resolve, reject) => {
      this.pending.set(echo, { resolve, reject });
      this.socket.send(JSON.stringify({ action, params, echo }));
      setTimeout(() => { if (this.pending.has(echo)) { this.pending.delete(echo); reject(new Error(`${action} 超时`)); } }, 30_000);
    });
  }
  feed(frame) {
    if (frame.echo && this.pending.has(frame.echo)) {
      const { resolve, reject } = this.pending.get(frame.echo);
      this.pending.delete(frame.echo);
      const code = Number(frame.retcode ?? frame.info?.retcode ?? 0);
      code !== 0 || frame.status === "failed"
        ? reject(new Error(`${frame.echo} 失败 retcode=${code} ${JSON.stringify(frame.message ?? frame.info ?? "")}`.slice(0, 180)))
        : resolve(frame.data);
    }
  }
  dropAll(reason) {
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
  }
  async sendMsg(target) {
    const action = target.group_id ? "send_group_msg" : "send_private_msg";
    // 真 NapCat 实测：message 传 segment 数组会 retcode=1200 "Cannot read properties of undefined (reading 'text')"，
    // 传字符串才收。我们只发纯文本，所以固定用字符串形状（mock 服务端照这个行为拒绝数组）
    return this.call(action, { group_id: target.group_id, user_id: target.user_id, message: String(target.message ?? "") });
  }
}

function mask(u) { return String(u).replace(/(access_token|token)=([^&]+)/gi, "$1=***"); }

export function connect(rawUrl, { token = process.env.ONEBOT_TOKEN || "", askBrain, onEventRaw, recordRecent = true } = {}) {
  let url = rawUrl;
  if (token && !/[?&](access_token|token)=/i.test(url)) {
    url += (url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(token);
  }
  // 本进程的启动时刻：补推重放防护用（重连 open() 会刷新 openedAt，但不能刷新它）
  const processStart = Date.now();
  let ws, api, stopped = false, connected = false;
  const selfIdHolder = { id: null, name: "" };
  const sendGate = createSendGate();
  let drawRecovered = false;
  let sweepTimer = null;
  const chatKeyOf = (ev) => ev.message_type === "group" ? `g:${ev.group_id}` : `p:${ev.user_id}`;
  const sweepCaches = () => {
    try {
      for (const d of readdirSync(GROUPS_ROOT, { withFileTypes: true })) {
        if (d.isDirectory()) cacheSweep(join(GROUPS_ROOT, d.name));
      }
    } catch {}
  };
  const sendPaced = async (chatKey, target) => {
    const r = await sendGate(chatKey, () => api.sendMsg(target));
    if (!r.ok) {
      console.log(`[发送上限] ${chatKey} 本小时已发 ${r.sent} 条，丢弃：${String(target.message).slice(0, 40)}`);
      return false;
    }
    // A 回写（2026-11-03 调研缺口 1）：NapCat 不回推她发的消息（主群缓冲实测 0 条 mine），
    // 她的话不进缓冲 → 有人回复她时 reply#N 查不到位次，最强的"对她说话"信号被渲染成"全体"。
    // 发送返回的 message_id 就是将来 reply 段会引用的同一个 id，据此回写。
    // 纯图发送（[CQ:image 开头）没有可转述的正文不回写；私聊没有 L4 缓冲，跳过。
    if (String(chatKey).startsWith("g:") && selfIdHolder.id != null) {
      const msg = String(target.message ?? "");
      if (msg && !msg.startsWith("[CQ:image")) {
        appendRecent(groupDir(chatKey), {
          // || 而非 ??：个别实现回 message_id:0，0 进 indexOfId 会和她人消息的真实 0 位撞车
          id: r.value?.message_id || `sent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ts: Math.floor(Date.now() / 1000),
          uid: String(selfIdHolder.id),
          name: selfIdHolder.name || "我",
          to: [], replyTo: null, text: msg, atMe: false, mine: true,
        }, { max: CFG.recentBufferSize });
      }
    }
    return true;
  };

  // 后台任务投递预检：连接态 + 白名单 + 禁言 + 小时上限。调度器在调用模型前先用它，
  // 避免不可投递时白烧一次模型/额度。
  function canDeliverOf(chatKey) {
    const key = String(chatKey);
    if (!connected || !api) return { ok: false, reason: "连接未就绪" };
    if (!targetOf(key)) return { ok: false, reason: "目标无效" };
    if (key.startsWith("g:")) {
      const gid = key.slice(2);
      if (!groupAllowed(gid)) return { ok: false, reason: "群不在白名单" };
      if (isGroupMuted(Number(gid))) return { ok: false, reason: "本号禁言中" };
    } else if (key.startsWith("p:")) {
      const uid = key.slice(2);
      const allowed = RULES.allowPrivate.map(String).includes(uid) || CFG.owners.includes(uid);
      if (!allowed) return { ok: false, reason: "私聊不在白名单" };
    } else {
      return { ok: false, reason: "目标类型不支持" };
    }
    if (sendGate.capped(key)) return { ok: false, reason: "发送额度已满" };
    return { ok: true };
  }

  function open() {
    const openedAt = Date.now();
    selfIdHolder.id = null;   // 重连后可能是另一个号登录，旧 selfId 不能沿用（否则会把新号的话当群友的话回）
    selfIdHolder.name = "";
    ws = new WebSocket(url);
    ws.addEventListener("open", async () => {
      console.log(`[onebot] 已连接 ${mask(url)}`);
      connected = true;
      capMutesForReconnect();   // 断线期错过的解禁 notice 不补发：重连把残余禁言按重启口径封顶
      try {
        const me = await api.call("get_login_info", {});
        selfIdHolder.id = me?.user_id;
        selfIdHolder.name = me?.nickname || "";
        console.log(`[onebot] 机器人 QQ=${selfIdHolder.id} ${me?.nickname ?? ""}`);
        // 权威禁言同步：拿到 self 立刻问服务端每群的真实禁言状态，覆盖落盘的封顶估算值
        if (selfIdHolder.id != null && RULES.allowGroups.length) {
          syncMutesFromServer(api, selfIdHolder.id, RULES.allowGroups)
            .then((n) => { if (n) console.log(`[onebot] 服务端确认 ${n} 个群仍在禁言（按真实到期时间静默）`); })
            .catch((e) => console.log(`[onebot] 禁言同步失败：${e.message ?? e}`));
        }
      } catch (e) { console.log(`[onebot] 取登录信息失败：${e.message}`); }
    });
    ws.addEventListener("message", async (ev) => {
      let frame;
      try {
        frame = JSON.parse(typeof ev.data === "string" ? ev.data : await new Response(ev.data).text());
      } catch { return; }
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) return; // 合法 JSON 但不是对象（null / 数字 / 数组）
      // 只有带 echo 的才是对我们请求的回包；事件一律按 post_type 走（OneBot 事件里没有 echo）
      if (frame.echo) { api.feed(frame); return; }
      // get_login_info 失败时用事件自带的 self_id 兜底，别让 selfId 永远为空（否则后台任务 ready 永远 false）
      if (selfIdHolder.id == null && frame.self_id != null) selfIdHolder.id = frame.self_id;
      // 群禁言/解禁 notice：维护该群的静默标记（禁言期间消息只留档不调模型，省额度）
      if (frame.post_type === "notice" && frame.notice_type === "group_ban") {
        const note = groupBanNotice(frame, selfIdHolder.id ?? frame.self_id);
        if (note) console.log(`[g:${frame.group_id}] ${note}`);
        return;
      }
      if (frame.post_type !== "message") return;
      // 回复/引用消息：被引用的卡片可能早已不在 30 条缓冲里，用 get_msg 把原文拉回来，
      // 交给 onEvent 拼进本轮 text；失败就安静放弃，不影响正常回话。
      const segs = segments(frame);
      const frameChatKey = chatKeyOf(frame);
      const quoteId = quoteIdOf(segs);
      // WP11：引用回查与 onEvent 里的当前图下载并行；onEvent 会在用前 await 这个 Promise
      if (quoteId) {
        frame._quotedId = quoteId;
        frame._quotePromise = quotedContextOf(quoteId, api, { chatKey: frameChatKey, selfId: selfIdHolder.id ?? frame.self_id }).then((qc) => {
          if (qc.text) frame._quotedText = qc.text;
          if (qc.uid != null) frame._quotedUid = qc.uid;
          if (qc.name) frame._quotedName = qc.name;
          if (qc.images.length) {
            frame._quotedImages = qc.images;
            console.log(`[引用图片] 取到 ${qc.images.length} 张，随本轮一起喂模型`);
          }
          return qc;
        }).catch(() => null);
      }
      try {
        const forwardImages = [];
        const ft = await renderForwardText(segs, api, frameChatKey, forwardImages);
        if (ft) frame._forwardText = ft.slice(0, 2200);
        if (forwardImages.length) {
          frame._forwardImages = [...new Set(forwardImages)];
          console.log(`[转发图片] 取到 ${frame._forwardImages.length} 张，随本轮一起喂模型`);
        }
      } catch {}
      // WP1-C1 旁路缓冲：白名单群每条消息先记档再谈回不回——限流挡的、她跳过的、下面 10 秒窗口
      // 丢弃的都必须留在缓冲里，所以这行必须待在一切判定之前。recordRecent:false 供只读诊断脚本
      // （napcat-doctor）禁用，避免诊断工具污染各群的 recent.jsonl
      try { if (recordRecent) recordGroupRecent(frame, selfIdHolder.id ?? frame.self_id); } catch {}
      // 接入排障用的原始事件钩子（napcat-doctor 的 OBSERVE_SECONDS 走这里），不影响回不回
      try { onEventRaw?.(frame); } catch {}
      // 补推重放防护：bot 重启后 NapCat 会把断线期间的消息原样补推（其 time 早于本进程启动时刻）。
      // tooOld 只拦 EVENT_MAX_AGE 之外的旧消息；这里把「启动之前就存在的消息」挡在回复之外——
      // 只留档不回，防止重启窗口内对同一条消息重复回复（审核 F-15）。5 秒容差覆盖投递/时钟抖动。
      if (typeof frame.time === "number" && frame.time * 1000 < processStart - 5_000) {
        console.log(`[onebot] 启动前的补推旧消息，只留档不回（message_id=${frame.message_id ?? "?"}）`);
        return;
      }
      // 登录信息还没回来时先不回话，免得把自己发的消息当成群友的话（10 秒后放行，兼容拿不到 self 的实现）
      if (selfIdHolder.id == null && Date.now() - openedAt < 10_000) { console.log("[onebot] 等 self 中，先忽略一条事件"); return; }
      const asyncTarget = frame.message_type === "group"
        ? { group_id: Number(frame.group_id) }
        : { user_id: Number(frame.user_id) };
      const sendAsync = (message) => sendPaced(frameChatKey, { ...asyncTarget, message });
      const out = await onEvent(frame, {
        getSelfId: () => selfIdHolder.id ?? frame.self_id,
        getSelfName: () => selfIdHolder.name,
        askBrain,
        sendAsync,
        isSendCapped: (key) => sendGate.capped(key),   // 额度打满的会话只留档不进模型（同禁言）
      }).catch((e) => console.log(`[onebot] 处理出错 ${e.message}`));
      if (!out) return;
      // 长回复拆成几条发：每条之间留一点间隔，别三句同一毫秒砸出去
      const sendStart = Date.now();
      let sent = 0, sendFailed = 0, sendDropped = 0;
      for (let i = 0; i < out.sends.length; i++) {
        const target = out.sends[i];
        if (i > 0) await new Promise((r) => setTimeout(r, CFG.splitGapMs));
        try {
          if (!(await sendPaced(out.chatKey, target))) { sendDropped++; break; }
          sent++;
          noteSendSuccess(target);
          const label = String(target.message).startsWith("[CQ:image") ? "[图片]" : target.message;
          console.log(`[${out.chatKey}] ${label}  (${i + 1}/${out.sends.length}${i === 0 ? ` ${out.meta?.ms}ms` : ""})`);
        } catch (e) {
          sendFailed++;
          console.log(`[onebot] 发送失败：${e.message} ｜ 这条本来要回：${target.message}`);
          const heal = noteSendFailure(target, e);
          if (heal) console.log(`[${out.chatKey}] ${heal}`);
        }
      }
      recordTurn(out.chatKey, {
        turnId: out.meta?.turnId ?? out.turnId ?? null,
        phase: "send", sendMs: Date.now() - sendStart,
        sendParts: sent, sendPlanned: out.sends.length,
        sendFailed, sendDropped,
      });
      // A10：交付事件。摘要/SearchHistory据此区分“拟回复”和“已发送”，失败回复不算群史。
      // 图片准备失败时只发了兜底文本，原回复没发出去：用 deliveryHint=failed 覆盖“发送成功”。
      const deliveryStatus = out.deliveryHint === "failed"
        ? "failed"
        : out.sends.length === 0 ? "sent" : sent === 0 ? "failed" : (sendFailed || sendDropped) ? "partial" : "sent";
      appendDelivery(groupDir(out.chatKey), {
        turnId: out.meta?.turnId ?? out.turnId ?? "",
        chatKey: out.chatKey,
        status: deliveryStatus,
        partsSent: sent,
        partsPlanned: out.sends.length,
        error: sendFailed ? "send failed" : sendDropped ? "dropped" : "",
      });
    });
    ws.addEventListener("close", () => {
      connected = false;
      api.dropAll("连接已断开");
      if (stopped) return;
      console.log("[onebot] 断线，3 秒后重连");
      setTimeout(open, 3000);
    });
    ws.addEventListener("error", (e) => console.log(`[onebot] 连接错误 ${e.message ?? e.type}`));
    api = new Api(ws);
    if (!drawRecovered) {
      drawRecovered = true;
      setTimeout(() => {
        recoverDrawJobs({
          sendTo: async (chatKey, message) => {
            const target = targetOf(chatKey);
            return target ? sendPaced(chatKey, { ...target, message }) : false;
          },
        }).catch((e) => console.log(`[画图恢复] 失败：${e.message ?? e}`));
        sweepCaches();
        if (!sweepTimer) {
          sweepTimer = setInterval(sweepCaches, 6 * 3600_000);
          sweepTimer.unref?.();
        }
      }, 1500).unref?.();
    }
  }

  open();
  return {
    close() { stopped = true; if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; } try { ws.close(); } catch {} },
    get selfId() { return selfIdHolder.id; },
    get connected() { return connected; },
    // 后台任务预检：连接态/白名单/禁言/小时上限
    canDeliver(chatKey) { return canDeliverOf(chatKey); },
    // 只读自查用（napcat-doctor）：等连上再发，避免还没握手就打空
    call(action, params = {}) {
      if (!api) return Promise.reject(new Error("还没连上"));
      return api.call(action, params);
    },
    // 后台任务（定时任务）用：先走投递预检（连接/白名单/禁言/小时上限），再走同一发送闸门。
    // 返回 boolean 给调度器记日志，不抛异常、不带垮调度循环。
    async send(chatKey, message) {
      const key = String(chatKey);
      const d = canDeliverOf(key);
      if (!d.ok) { console.log(`[onebot] 后台发送跳过（${d.reason}）：${key}`); return false; }
      const target = targetOf(key);
      try {
        const ok = await sendPaced(key, { ...target, message });
        if (ok) noteSendSuccess(target);
        return ok;
      } catch (e) {
        console.log(`[onebot] 后台发送失败：${String(e?.message ?? e).slice(0, 100)}`);
        const heal = noteSendFailure(target, e);
        if (heal) console.log(`[${key}] ${heal}`);
        return false;
      }
    },
  };
}
