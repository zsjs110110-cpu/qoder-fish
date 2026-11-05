// 能力授权：角色 → 工具策略 → 参数级护栏。提示词只管话术，权限在这里判。
import { resolve, relative, dirname, sep, win32 } from "node:path";
import { realpathSync, existsSync } from "node:fs";
import { promises as dns } from "node:dns";
import { CFG } from "./config.mjs";

// 文件类工具：主 agent 碰文件只认主人。Grep/Glob（WP2）走同一条分支：
// 群友一句"帮我搜搜你本子"就能让搜索根指向别处，比后台记忆 agent 那条路直白得多。
// 自动记忆不受这条影响：后台记忆 agent 的写盘压根不进 canUseTool。
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Read", "Grep", "Glob"]);

// ---------- 路径围栏 ----------
const normS = (p) => String(p).replace(/[\\/]+/g, "/");
function canon(p) {
  // 一律按 Windows 语义归一（本项目就跑在 Windows 上），大小写不敏感比较
  return win32.normalize(normS(p)).replace(/\/+$/g, "").toLowerCase();
}
function realIfThere(p) {
  try { return realpathSync(p); } catch { return null; }
}
export function pathWithin(memRoot, target) {
  if (!memRoot || !target) return { ok: false, code: "path" };
  if (target.includes("\0")) return { ok: false, code: "path" };
  const tAbs = win32.resolve(normS(memRoot), normS(target));
  const rootLex = canon(memRoot);
  const tLex = canon(tAbs);
  // 先纯词法判：.. 到根外、绝对路径、不同盘符，一律拒
  const rel = win32.relative(rootLex, tLex);
  const lexInside = rel === "" || (!rel.startsWith("..") && !win32.isAbsolute(rel) && !/^[a-zA-Z]:/.test(rel));
  if (!lexInside) return { ok: false, code: "outside" };
  // 再用 realpath 复核（防 junction/软链把根内路径指向根外）。realpath 只能加严，不能放行。
  const realRoot = realIfThere(rootLex);
  if (realRoot) {
    const rr = canon(realRoot);
    let cur = tLex, guard = 0;
    // 审核修复 F-12：走查上限 12→64——memRoot 下新建的深目录链（>12 层且尚不存在）此前会提前
    // 放弃 realpath 复核、退回纯词法判定（fail-open 窄窗口）；64 层远超实际目录深度
    while (guard++ < 64) {
      const rt = realIfThere(cur);
      if (rt) {
        const rel2 = win32.relative(rr, canon(rt));
        if (rel2 !== "" && (rel2.startsWith("..") || win32.isAbsolute(rel2) || /^[a-zA-Z]:/.test(rel2))) return { ok: false, code: "escape" };
        break;
      }
      const up = win32.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  }
  return { ok: true, resolved: tAbs };
}

// ---------- URL 护栏 ----------
function v6Unmapped(host) {
  // 去掉方括号，处理 ::ffff:1.2.3.4 / ::ffff:7f00:1 / 6tail 形式
  let h = host.replace(/^\[|\]$/g, "").toLowerCase();
  const m = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/.exec(h);
  if (m) return m[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
    if (a <= 65535 && b <= 65535) return `${(a >> 8) & 255}.${a & 255}.${(b >> 8) & 255}.${b & 255}`;
  }
  if (h.startsWith("::ffff:")) return null;
  const tail = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (tail) return tail[1];
  return null;
}
const V6_SPECIAL = /^(::1?|::|fec0:|fe80:|fc|fd|ff00:|::ffff:|::beef|64:ff9b:|2001:0000:|2002:)/i;
export function ipBlocked(ip) {
  if (!ip) return true;                       // 没地址就按"拦"处理，别 fail-open
  if (ip.includes(":")) {
    const mapped = v6Unmapped(ip);
    if (mapped) return ipBlocked(mapped);
    if (V6_SPECIAL.test(ip.replace(/^\[|\]$/g, ""))) return true;
    // 常见的 v4-in-v6 点分尾巴：64:ff9b::127.0.0.1 / 2002::7f00:1 之类
    const tail = /^::(ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
    if (tail) return ipBlocked(tail[2]);
    return false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 88) return true;            // 6to4 中继任播 192.88.99.0/24
  // 注意：不要把 198.18.0.0/15（RFC2544 基准测试段）加进来。这台机器跑 Clash TUN + fake-ip，
  // 所有域名都解析到 198.18.0.x，一拦就等于把她能读的站全关了（实测踩过，auth.test 抓到）
  if ((a === 192 && b === 0 && (p[2] === 2)) || (a === 198 && b === 51 && p[2] === 100) || (a === 203 && b === 0 && p[2] === 113)) return true; // 文档/示例段
  if (a >= 224) return true;                          // 组播/保留
  return false;
}

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const isIpHost = (h) => IPV4.test(h) || h.includes(":");

export async function urlCheck(rawUrl, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, reason: "URL 解析不了", code: "parse" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: `协议不走 ${u.protocol}`, code: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "URL 里带凭据", code: "creds" };
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  if (!["80", "443", "8080", "8443"].includes(port)) return { ok: false, reason: `端口 ${port} 不放行`, code: "port" };
  const host = u.hostname;
  if (CFG.fetchHosts.length && !CFG.fetchHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return { ok: false, reason: "这个站不在白名单里", code: "hostlist" };
  }
  if (!allowPrivate) {
    if (isIpHost(host)) {
      if (ipBlocked(host)) return { ok: false, reason: "IP 直指内网/本机，不抓", code: "ip" };
    } else {
      if (/(^|\.)(local|internal|intranet|lan|localdomain)$/i.test(host) || host === "localhost") {
        return { ok: false, reason: "内网域名，不抓", code: "host" };
      }
      let ips = [];
      try { const recs = await dns.lookup(host, { all: true }); ips = recs.map((r) => r.address); }
      catch { return { ok: false, reason: "域名解析不了（不冒险抓）", code: "dns" }; }
      if (!ips.length) return { ok: false, reason: "域名没有可用地址", code: "dns" };
      if (ips.some((ip) => ipBlocked(ip))) return { ok: false, reason: "域名解析到内网地址，不抓", code: "rebind" };
    }
  }
  return { ok: true };
}

// ---------- 角色与工具 ----------
export function roleOf({ userId, groupId, platformRole }) {
  const uid = String(userId ?? "");
  if (CFG.blockedUsers.includes(uid)) return "blocked";
  if (CFG.owners.includes(uid)) return "owner";
  if (CFG.admins.includes(uid) || platformRole === "admin" || platformRole === "owner") return "admin";
  if (CFG.allowAllGroups || !CFG.memberGroups.length || CFG.memberGroups.includes(String(groupId ?? ""))) return "member";
  return "guest";
}
export function toolAllowed(role, toolName) {
  const policy = CFG.toolPolicy[role] ?? CFG.toolPolicy.guest;
  return policy === "*" || policy.includes(toolName);
}

export async function checkToolCall(role, name, input, { memRoot } = {}) {
  if (CFG.hardDenied.includes(name)) return { behavior: "deny", message: "这个本事不在她的范围内", code: "hard" };
  if (FILE_TOOLS.has(name)) {
    if (role !== "owner") return { behavior: "deny", message: "本子是她自己的事，只有主人能翻和改", code: "role" };
    // Grep/Glob 的搜索根参数叫 path，Read/Write/Edit 叫 file_path；搜索根缺失时按"没给路径"拒
    // （生产里 brain 会把 Grep/Glob 的 path 强制覆写成 memRoot，这里拦的是直连判定与漏网形状）
    const target = String(input?.file_path ?? input?.path ?? "");
    if (!target) return { behavior: "deny", message: "没给路径", code: "path" };
    const g = pathWithin(memRoot, target);
    if (!g.ok) return { behavior: "deny", message: name === "Read" ? "这个路径不在记事本目录里" : "记事本之外不许写", code: g.code };
    return { behavior: "allow", resolvedPath: g.resolved };
  }
  // 生图是 owner-only 的硬门：不依赖 toolPolicy（群友/管理员即使被误配也不放行）
  if (name === "ImageGen" && role !== "owner") return { behavior: "deny", message: "画图只给主人用", code: "role" };
  if (!toolAllowed(role, name)) return { behavior: "deny", message: `这个角色不能用 ${name}`, code: "role" };
  if (name === "WebFetch") {
    const g = await urlCheck(input?.url);
    if (!g.ok) return { behavior: "deny", message: g.reason, code: g.code };
  }
  return { behavior: "allow" };
}

// ---------- 速率（配额闸门已删除：用的是 priceFactor=0 的免费档模型，账号配额涨不涨与她能不能说话无关） ----------
const buckets = new Map();
let quota = { usedPct: null, exceeded: null, remaining: null, unit: "credits", 桶: "无数据", at: 0, source: "未取到" };

export function updateQuota(info, { at = Date.now() } = {}) {
  if (!info) return quota;
  const list = [info.userQuota, info.addOnQuota, info.orgResourcePackage].filter(Boolean);
  const funded = (b) => Number(b.total ?? b.cap ?? 0) > 0;
  const withTotal = list.filter(funded);
  const remaining = withTotal.length ? withTotal.reduce((s, b) => s + Number(b.remaining ?? 0), 0) : null;
  const session = Number(info.session?.total_credits ?? 0);
  quota = {
    usedPct: typeof info.totalUsagePercentage === "number" ? Number(info.totalUsagePercentage.toFixed(2)) : quota.usedPct,
    exceeded: typeof info.isQuotaExceeded === "boolean" ? info.isQuotaExceeded : quota.exceeded,
    remaining,
    sessionCredits: session,
    unit: info.addOnQuota?.unit ?? info.userQuota?.unit ?? quota.unit ?? "credits",
    桶: withTotal.map((b) => `${b.used ?? 0}/${b.total ?? b.cap ?? "?"}${b.unit ? " " + b.unit : ""}`).join(" + ") || "无额度桶数据",
    at,
    source: "getUsageInfo",
  };
  return quota;
}
export function quotaSnapshot() { return { ...quota }; }

function dayKey(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }
export function rateCheck(userId, { now = Date.now(), dailyCap = CFG.perUserDailyMessages } = {}) {
  const uid = String(userId ?? "?");
  const b = buckets.get(uid) ?? { hits: [], day: dayKey(now), count: 0 };
  if (b.day !== dayKey(now)) { b.day = dayKey(now); b.count = 0; }
  b.hits = b.hits.filter((t) => now - t < 60_000);
  if (!CFG.owners.includes(uid)) {
    if (b.hits.length >= CFG.perUserPerMinute) return { ok: false, reason: "一分钟太多条了" };
    if (b.count >= dailyCap) return { ok: false, reason: "这个人今天问得够多了" };
  }
  b.hits.push(now);
  b.count++;
  buckets.set(uid, b);
  return { ok: true, used: b.hits.length, today: b.count };
}

export function usageSnapshot() {
  return { 配额: quota, 每人: [...buckets.entries()].map(([uid, b]) => ({ uid, 今日条数: b.count, 最近一分钟: b.hits.length })) };
}

// ---------- 生图预算（软限，进程重启清零；硬门是上面的 owner-only） ----------
const imageUse = new Map();
function imageBucket(key, day) {
  const b = imageUse.get(key) ?? { day, count: 0 };
  if (b.day !== day) { b.day = day; b.count = 0; }
  imageUse.set(key, b);
  return b;
}
export function imageBudgetCheck({ userId, chatKey, now = Date.now() } = {}) {
  const day = dayKey(now);
  const u = imageBucket(`u:${String(userId ?? "?")}`, day);
  const c = imageBucket(`c:${String(chatKey ?? "?")}`, day);
  if (u.count >= CFG.imageGenPerUserPerDay) return { ok: false, reason: "今天画图次数用完了" };
  if (c.count >= CFG.imageGenPerChatPerDay) return { ok: false, reason: "这个群今天的图够多了" };
  return { ok: true };
}
export function imageBudgetTake({ userId, chatKey, now = Date.now() } = {}) {
  const check = imageBudgetCheck({ userId, chatKey, now });
  if (!check.ok) return check;
  const day = dayKey(now);
  imageBucket(`u:${String(userId ?? "?")}`, day).count++;
  imageBucket(`c:${String(chatKey ?? "?")}`, day).count++;
  return { ok: true };
}
export function imageBudgetReset() { imageUse.clear(); }

// ---------- 管理动作 ----------
export const ACTIONS = {
  chat: ["owner", "admin", "member", "guest"],
  search: ["owner", "admin", "member", "guest"],
  summarize: ["owner", "admin"],
  viewNotes: ["owner"],
  clearNotes: ["owner"],
  clearSession: ["owner"],
  changeRules: ["owner"],
  confirmRule: ["owner"],
};
export function canDo(role, action) {
  const list = ACTIONS[action];
  return !list ? role === "owner" : list.includes(role);
}
