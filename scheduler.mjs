// 会话级定时任务：每个会话一个 schedule.json（与记事本同目录，隔离边界一致）。
// 只认 HH:MM + daily/weekdays/weekly:N/once，避免 cron 表达式写错的误触发。
// 配额：非主人每人每天在所有会话合计最多新建 1 个（主人不限）；每个会话总共最多 5 个。
// 执行：由进程内 tick 触发，交给 ask() 现场生成一句，再经适配层发送闸门发出。
// lastRunDay 在执行前落盘（周期任务一天一次）；once 未发出时保留并在窗口内最多重试 2 次，
// 过期/错过的一次性任务自动清理，避免永久占名额。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CFG } from "./config.mjs";
import { splitMessages } from "./sanitize.mjs";
import { safeName } from "./prompt-layers/layers.mjs";

const FILE = "schedule.json";
const MAX_JOBS = 5;
const MAX_PROMPT = 200;
const FIRE_WINDOW_MS = 10 * 60_000;
const ONCE_CREATE_GRACE_MS = FIRE_WINDOW_MS - 2 * 60_000;   // 一次性建任务留 2 分钟余量给 tick
const MAX_ONCE_ATTEMPTS = 2;      // 一次性任务窗口内最多尝试 2 次（模型/发送失败时保留重试）
const QUOTA_KEEP_DAYS = 3;
const WEEK_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const pad = (n) => String(n).padStart(2, "0");
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseTime(v) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? "").trim());
  if (!m) return null;
  return `${pad(Number(m[1]))}:${m[2]}`;
}

// daily | weekdays | weekly:0-6（0=周日）| once（一次性，需配合 date）
export function parseRepeat(v) {
  const s = String(v ?? "daily").trim().toLowerCase();
  if (s === "daily") return { kind: "daily" };
  if (s === "weekdays") return { kind: "weekdays" };
  if (s === "once") return { kind: "once" };
  const w = /^weekly[:：]?\s*([0-6])$/.exec(s);
  if (w) return { kind: "weekly", day: Number(w[1]) };
  return null;
}

function parseDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export function repeatLabel(job) {
  const r = job?.repeat ?? {};
  if (r.kind === "once") return `仅一次 ${job.date || "?"}`;
  if (r.kind === "weekdays") return "工作日";
  if (r.kind === "weekly") return `每周${WEEK_LABEL[Number(r.day)] ?? "?"}`;
  return "每天";
}

export function statePath(dir) { return join(dir, FILE); }

const warned = new Set();
function warnOnce(key, msg) {
  if (warned.has(key)) return;
  warned.add(key);
  console.log(msg);
}

function normalizeState(raw) {
  const isJob = (j) => j && typeof j === "object" && typeof j.id === "string";
  if (Array.isArray(raw)) {
    const jobs = raw.filter(isJob);
    return { jobs, quota: {}, corrupt: jobs.length !== raw.length };
  }
  const jobsRaw = raw?.jobs;
  const badJobs = jobsRaw !== undefined && !Array.isArray(jobsRaw);
  const jobs = Array.isArray(jobsRaw) ? jobsRaw.filter(isJob) : [];
  const badElems = Array.isArray(jobsRaw) && jobs.length !== jobsRaw.length;
  return {
    jobs,
    quota: raw?.quota && typeof raw.quota === "object" ? raw.quota : {},
    corrupt: badJobs || badElems,
  };
}

export function readState(dir) {
  const p = statePath(dir);
  if (!existsSync(p)) return { jobs: [], quota: {} };
  try {
    return normalizeState(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    // 区分"不存在"和"损坏"：损坏时返回 corrupt 让调用方拒绝覆盖，别把整个任务表清空
    warnOnce(p, `[定时] schedule.json 解析失败，已跳过（先备份再修）：${p}`);
    return { jobs: [], quota: {}, corrupt: true };
  }
}

// 原子落盘：写 tmp 再 rename，避免半截 JSON 把任务表毁掉
function atomicWrite(file, state) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const text = JSON.stringify(state, null, 1);
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, file);
  } catch {
    // Windows 上 rename 偶发被占用：直接写回成功后视为成功（不能一边写成功一边报失败）
    writeFileSync(file, text);
    try { unlinkSync(tmp); } catch {}
  }
}

export function writeState(dir, state) {
  const p = statePath(dir);
  try {
    mkdirSync(dir, { recursive: true });
    atomicWrite(p, state);
    return true;
  } catch (e) {
    warnOnce(`${p}:write`, `[定时] 写入失败 ${p}：${String(e?.message ?? e).slice(0, 80)}`);
    return false;
  }
}

function pruneQuota(state, now) {
  const keep = new Set([0, 1, 2].map((i) => dayKey(new Date(now.getTime() - i * 86400_000))));
  let changed = false;
  for (const k of Object.keys(state.quota)) {
    if (!keep.has(k)) { delete state.quota[k]; changed = true; }
  }
  return changed;
}

// 跨会话统计某人当天已建任务数（quota 存在各会话 schedule.json 里）。
// 有损坏文件时返回 corrupt=true：非主人新建要 fail-closed，别让"坏了就当 0"绕过配额。
export function usedToday(root, uid, today = dayKey()) {
  let count = 0, corrupt = false;
  for (const entry of scanStates(root)) {
    if (entry.state.corrupt) { corrupt = true; continue; }
    const v = Number(entry.state.quota?.[today]?.[String(uid)]);
    if (Number.isFinite(v) && v > 0) count += v;
  }
  return { count, corrupt };
}

export function addJob(dir, { chatKey, time, repeat, date = "", prompt, createdBy, createdByName = "", role = "member", now = new Date(), quotaRoot = null } = {}) {
  const t = parseTime(time);
  if (!t) return { ok: false, error: "时间格式不对，要 24 小时制的 HH:MM（例如 12:00）" };
  const rep = parseRepeat(repeat);
  if (!rep) return { ok: false, error: "重复规则不对，只能填 daily、weekdays、weekly:0-6（0=周日）或 once" };
  let jobDate = "";
  if (rep.kind === "once") {
    jobDate = parseDate(date);
    if (!jobDate) return { ok: false, error: "一次性任务要同时给 date（YYYY-MM-DD）" };
    const [hh, mm] = t.split(":").map(Number);
    const [y, mo, da] = jobDate.split("-").map(Number);
    const scheduled = new Date(y, mo - 1, da, hh, mm, 0, 0);
    // 允许落在窗口内（马上触发），但留 2 分钟余量给 tick；更早的过去时间拒绝
    if (scheduled.getTime() < now.getTime() - ONCE_CREATE_GRACE_MS) return { ok: false, error: "这个时间已经过了，换一个未来的时间" };
  }
  const body = [...String(prompt ?? "").replace(/\s+/g, " ").trim()].slice(0, MAX_PROMPT).join("");
  if (!body) return { ok: false, error: "任务内容不能为空" };
  const uid = String(createdBy ?? "");
  if (!uid) return { ok: false, error: "拿不到创建者身份，不能挂任务" };
  if (!["owner", "admin", "member"].includes(String(role))) return { ok: false, error: "这个身份不能挂定时任务" };

  const state = readState(dir);
  if (state.corrupt) return { ok: false, error: "这个会话的 schedule.json 坏了，先让主人备份/修复再挂" };
  const today = dayKey(now);
  if (String(role) !== "owner") {
    // 配额按"人+当天"跨会话合计（用户口径：一天不能超过一次）；quotaRoot 由调用方给整个 groups 根。
    // addJob 全程同步读改写，单线程事件循环内不会与另一次创建交错。
    let used = 0;
    if (quotaRoot) {
      const q = usedToday(quotaRoot, uid, today);
      if (q.corrupt) return { ok: false, error: "有会话的任务表损坏，今天暂时不能新建，先让主人修" };
      used = q.count;
    } else {
      const v = Number(state.quota[today]?.[uid]);
      used = Number.isFinite(v) && v > 0 ? v : 0;
    }
    if (used >= 1) return { ok: false, error: "每人每天只能挂一个定时任务，今天这个额度已经用过了" };
  }
  if (state.jobs.length >= MAX_JOBS) {
    return { ok: false, error: String(role) === "owner" ? `这个会话最多挂 ${MAX_JOBS} 个定时任务，先取消一个再挂` : "这个会话的任务满了，让主人处理" };
  }

  const job = {
    id: `sch-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    chatKey,
    time: t,
    repeat: rep,
    ...(jobDate ? { date: jobDate } : {}),
    prompt: body,
    createdBy: uid,
    createdByName: safeName(createdByName),
    createdRole: String(role),
    createdAt: now.getTime(),
    enabled: true,
    lastRunDay: "",
    attempts: 0,
  };
  state.jobs.push(job);
  if (String(role) !== "owner") {
    state.quota[today] = state.quota[today] ?? {};
    state.quota[today][uid] = Number(state.quota[today][uid] ?? 0) + 1;
  }
  pruneQuota(state, now);
  if (!writeState(dir, state)) return { ok: false, error: "任务落盘失败，没挂上" };
  return { ok: true, job };
}

export function listJobs(dir, { createdBy = "", role = "member", now = new Date() } = {}) {
  const state = readState(dir);
  const visible = state.jobs.filter((j) => !onceExpired(j, now) && !j.doneAt);
  const jobs = String(role) === "owner"
    ? visible
    : visible.filter((j) => String(j.createdBy) === String(createdBy));
  return jobs.slice().sort((a, b) => String(a.time).localeCompare(String(b.time)));
}

export function cancelJob(dir, id, { createdBy = "", role = "member" } = {}) {
  const state = readState(dir);
  if (state.corrupt) return { ok: false, error: "schedule.json 损坏，先让主人备份/修复" };
  const i = state.jobs.findIndex((j) => String(j.id) === String(id));
  if (i < 0) return { ok: false, error: "没找到这个任务（可能已经被取消）" };
  const job = state.jobs[i];
  if (String(role) !== "owner" && String(job.createdBy) !== String(createdBy)) {
    return { ok: false, error: "只能取消自己挂的任务" };
  }
  state.jobs.splice(i, 1);
  if (!writeState(dir, state)) return { ok: false, error: "取消落盘失败，任务还在" };
  return { ok: true, job };
}

// 一次性任务执行完就删（不保留墓碑）；返回是否成功落盘
export function removeJob(dir, id) {
  const state = readState(dir);
  if (state.corrupt) return false;
  const before = state.jobs.length;
  state.jobs = state.jobs.filter((j) => String(j.id) !== String(id));
  if (state.jobs.length === before) return true;
  return writeState(dir, state);
}

// 时间窗判定（不含"今天是否已跑过"）：供 tick 在标记 lastRunDay 之后复核用
function windowOk(job, now = new Date()) {
  if (!job || job.enabled === false || job.doneAt) return false;
  const t = parseTime(job.time);
  if (!t) return false;
  const [hh, mm] = t.split(":").map(Number);
  const rep = job.repeat?.kind ? job.repeat : parseRepeat(job.repeat);
  if (!rep) return false;
  let scheduled;
  if (rep.kind === "once") {
    const d = parseDate(job.date);
    if (!d) return false;
    const [y, mo, da] = d.split("-").map(Number);
    scheduled = new Date(y, mo - 1, da, hh, mm, 0, 0);
  } else {
    scheduled = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  }
  const diff = now.getTime() - scheduled.getTime();
  if (diff < 0 || diff > FIRE_WINDOW_MS) return false;
  // 一次性允许"刚过点就建"（比如现在提醒），不再套防补跑阈值；周期任务仍防"建完立刻补跑"
  if (rep.kind === "once") return true;
  if (Number(job.createdAt ?? 0) > scheduled.getTime()) return false;
  const day = now.getDay();
  if (rep.kind === "weekdays" && (day === 0 || day === 6)) return false;
  if (rep.kind === "weekly" && day !== Number(rep.day)) return false;
  return true;
}

// 到点判定：时间窗内且今天还没跑过（只认当天，停机过点不补发）
export function isDue(job, now = new Date()) {
  return windowOk(job, now) && String(job.lastRunDay ?? "") !== dayKey(now);
}

// 一次性任务的“已过期”判定：日期时间已过窗口（或字段损坏）→ 应该清理，避免永久占名额。
// 与 isDue 不同，这里不看 lastRunDay：跑过但删除失败的任务也一并清掉（它不可能再跑）。
export function onceExpired(job, now = new Date()) {
  if (!job || job.enabled === false) return false;
  const rep = job.repeat?.kind ? job.repeat : parseRepeat(job.repeat);
  if (rep?.kind !== "once") return false;
  const d = parseDate(job.date);
  const t = parseTime(job.time);
  if (!d || !t) return true;
  const [y, mo, da] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  const scheduled = new Date(y, mo - 1, da, hh, mm, 0, 0);
  return now.getTime() - scheduled.getTime() > FIRE_WINDOW_MS;
}

// 扫描所有会话的 schedule.json；**没有 job 的目录也要收**——quota 可能还在（建了又取消），
// 否则当天配额会被绕过。chatKey 从 job 里取（目录名不可逆），空则执行时跳过。
export function scanStates(root) {
  const out = [];
  let names = [];
  try { names = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const ent of names) {
    if (!ent.isDirectory()) continue;
    const dir = join(root, ent.name);
    const p = join(dir, FILE);
    if (!existsSync(p)) continue;
    const state = readState(dir);
    const chatKey = state.jobs.find((j) => j.chatKey)?.chatKey ?? "";
    out.push({ chatKey: String(chatKey || ""), dir, path: p, state });
  }
  return out;
}

async function runJob(job, { askFn, send, now, log }) {
  const timeLabel = job.time;
  const creator = job.createdByName || job.createdBy;
  const group = job.chatKey.startsWith("g:") ? job.chatKey.slice(2) : "";
  let res;
  try {
    res = await askFn({
      chatKey: job.chatKey,
      text: `【定时任务】${job.prompt}\n这是${creator}之前挂的定时任务，现在到 ${timeLabel} 了。直接按约定说一句，不要解释这是定时任务，也不要提工具名。`,
      runtime: {
        group,
        time: now.toLocaleString("zh-CN", { hour12: false }),
        addressed: true,
        scheduled: true,
        speaker: { name: `定时任务（${creator}）`, relation: "定时任务" },
      },
      actor: { userId: String(job.createdBy), name: creator, platformRole: "", roleCap: job.createdRole || "member" },
      priority: true,
    });
  } catch (e) {
    log(`[定时] ${job.chatKey} ${job.id} 执行失败：${String(e?.message ?? e).slice(0, 100)}`);
    return { sent: 0, reason: "error" };
  }
  if (res?.silent) { log(`[定时] ${job.chatKey} ${job.id} 她判断这次不说（跳过）`); return { sent: 0, reason: "silent" }; }
  // 失败/超时/限流都不适合在定时任务里原样发出去（会变成莫名其妙的话或空消息）
  if (res?.broken || res?.error || res?.turn?.phase === "fallback" || res?.turn?.phase === "broken") {
    log(`[定时] ${job.chatKey} ${job.id} 生成失败（失败结果不用于定时任务）`);
    return { sent: 0, reason: "broken" };
  }
  if (res?.refused) { log(`[定时] ${job.chatKey} ${job.id} 被拒（${res.refused}），这次不发`); return { sent: 0, reason: `refused:${res.refused}` }; }
  if (res?.dropped) { log(`[定时] ${job.chatKey} ${job.id} 排队过期（${res.dropped}），这次没跑`); return { sent: 0, reason: `dropped:${res.dropped}` }; }
  // 定时轮只发纯文本：图/找图需要适配层的 staging 与发送逻辑，这里不支持，避免发出"画好了"却无图
  if (res?.draw || (Array.isArray(res?.searchImages) && res.searchImages.length)) {
    log(`[定时] ${job.chatKey} ${job.id} 产生了图片类结果，定时任务不支持，已跳过`);
    return { sent: 0, reason: "image" };
  }
  const text = String(res?.text ?? "").trim();
  if (!text) { log(`[定时] ${job.chatKey} ${job.id} 没有可发送的内容`); return { sent: 0, reason: "empty" }; }
  const parts = splitMessages(text, { maxChars: CFG.splitMaxChars, maxParts: CFG.splitMaxParts });
  let sent = 0;
  for (const part of parts) {
    let ok = false;
    try { ok = await send(job.chatKey, part); } catch (e) { log(`[定时] ${job.chatKey} 发送异常：${String(e?.message ?? e).slice(0, 80)}`); }
    if (ok) sent++;
    log(ok ? `[定时] ${job.chatKey} ${part}` : `[定时] ${job.chatKey} 发送被拒绝：${part.slice(0, 40)}`);
  }
  return { sent, reason: sent ? "ok" : "send-failed" };
}

// 一次性任务完成/放弃时先写 doneAt 墓碑：即使删除失败、跨午夜也不会重复发送
function markDone(dir, id, at) {
  const st = readState(dir);
  if (st.corrupt) return;
  const j = st.jobs.find((x) => String(x.id) === String(id));
  if (!j) return;
  j.doneAt = at;
  writeState(dir, st);
}

// tick 每 30s 一次；busy 防重入；ready=false 时整轮跳过（避免启动/断线窗口把当天任务烧掉）。
// canDeliver 在调用模型前做投递预检（白名单/禁言/小时上限），不可投递就不烧额度、不标记。
// 返回 tick 供测试直接驱动。
export function startScheduler({ root, send, askFn, nowFn = () => new Date(), tickMs = 30_000, log = console.log, ready = () => true, canDeliver = () => ({ ok: true }) } = {}) {
  let timer = null, busy = false, current = null, lastReady = null;
  async function tick() {
    let isReady = false;
    try { isReady = Boolean(ready()); } catch { isReady = false; }
    if (busy) return;
    if (!isReady) {
      if (lastReady !== false) { log("[定时] OneBot 未就绪，暂停调度"); lastReady = false; }
      return;
    }
    if (lastReady !== true) { log("[定时] OneBot 已就绪，恢复调度"); lastReady = true; }
    busy = true;
    try {
      const now0 = nowFn();
      for (const entry of scanStates(root)) {
        if (!entry.chatKey) continue;
        try {
          const st = readState(entry.dir);
          if (st.corrupt) { log(`[定时] ${entry.chatKey} schedule.json 损坏，本轮跳过`); continue; }
          pruneQuota(st, now0);
          // 1) 清理已过期的一次性任务：错过窗口/跑过但删除失败/字段损坏，都别永久占 5 个名额
          const expired = st.jobs.filter((j) => onceExpired(j, now0));
          if (expired.length) {
            const idset = new Set(expired.map((j) => String(j.id)));
            st.jobs = st.jobs.filter((j) => !idset.has(String(j.id)));
            if (writeState(entry.dir, st)) {
              for (const j of expired) log(`[定时] ${entry.chatKey} ${j.id} 一次性任务已过期未执行，已清理`);
            } else {
              log(`[定时] ${entry.chatKey} 过期任务清理落盘失败`);
            }
          }
          // 2) 逐任务：重读最新文件 → 判窗口 → 投递预检 → 只标记它自己 → 执行。
          // 不再整批预标记 lastRunDay：前面任务跑太久时，后面的任务留空，下一 tick/第二天仍有机会。
          const dueIds = readState(entry.dir).jobs.filter((j) => isDue(j, now0)).map((j) => String(j.id));
          for (const id of dueIds) {
            const latest = readState(entry.dir);
            if (latest.corrupt) break;
            const job = latest.jobs.find((j) => String(j.id) === id);
            if (!job) { log(`[定时] ${entry.chatKey} ${id} 已被取消，跳过`); continue; }
            const jobNow = nowFn();
            if (!windowOk(job, jobNow)) { log(`[定时] ${entry.chatKey} ${id} 已过触发窗口，跳过（不标记）`); continue; }
            let d = null;
            try { d = canDeliver(job.chatKey); } catch { d = { ok: false, reason: "预检异常" }; }
            if (typeof d === "boolean") d = { ok: d };
            if (!d?.ok) { log(`[定时] ${entry.chatKey} ${id} 暂不可投递（${d?.reason ?? "未知"}），本次不执行`); continue; }
            job.lastRunDay = dayKey(jobNow);
            job.lastAttemptAt = jobNow.getTime();
            job.attempts = Number(job.attempts ?? 0) + 1;
            if (!writeState(entry.dir, latest)) { log(`[定时] ${entry.chatKey} ${id} 状态落盘失败，本次跳过`); continue; }
            log(`[定时] ${job.chatKey} 触发 ${job.id}（${repeatLabel(job)} ${job.time}）：${String(job.prompt).slice(0, 30)}…`);
            const r = await runJob(job, { askFn, send, now: jobNow, log });
            if (job.repeat?.kind !== "once") continue;
            const attempts = Number(job.attempts ?? 1);
            if (r.sent > 0) {
              markDone(entry.dir, job.id, jobNow.getTime());
              if (!removeJob(entry.dir, job.id)) log(`[定时] ${job.chatKey} ${job.id} 一次性任务删除失败（doneAt 防重跑）`);
              else log(`[定时] ${job.chatKey} ${job.id} 一次性任务已删除`);
            } else if (attempts >= MAX_ONCE_ATTEMPTS) {
              markDone(entry.dir, job.id, jobNow.getTime());
              removeJob(entry.dir, job.id);
              log(`[定时] ${job.chatKey} ${job.id} 一次性任务尝试 ${attempts} 次仍未发出（${r.reason}），已放弃`);
            } else {
              // 失败保留：清掉 lastRunDay，让下一次 tick 在剩余窗口内重试
              const st2 = readState(entry.dir);
              if (!st2.corrupt) {
                const j2 = st2.jobs.find((j) => String(j.id) === id);
                if (j2) { j2.lastRunDay = ""; writeState(entry.dir, st2); }
              }
              log(`[定时] ${job.chatKey} ${job.id} 本次未发出（${r.reason}），保留任务，窗口内重试（${attempts}/${MAX_ONCE_ATTEMPTS}）`);
            }
          }
        } catch (e) {
          log(`[定时] ${entry.chatKey || "?"} 处理失败：${String(e?.message ?? e).slice(0, 100)}`);
        }
      }
    } catch (e) {
      log(`[定时] tick 失败：${String(e?.message ?? e).slice(0, 100)}`);
    } finally {
      busy = false;
    }
  }
  function start() {
    current = tick().catch((e) => log(`[定时] 首次 tick 失败：${String(e?.message ?? e).slice(0, 100)}`));
    timer = setInterval(() => {
      current = tick().catch((e) => log(`[定时] tick 失败：${String(e?.message ?? e).slice(0, 100)}`));
    }, tickMs);
    timer.unref?.();
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    return current ?? Promise.resolve();
  }
  return { tick, start, stop };
}
