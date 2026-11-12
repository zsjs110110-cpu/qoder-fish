// 群目录快照 + 哨兵（2026-11-07 数据安全第二批）。
// 原则：快照放在模型不可写、与工作目录不同卷的位置；只增不镜像删除源文件；
// 哨兵只报告“曾经存在、现在缺失”的文件，绝不自动重建，也不覆盖仍在运行的目录。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

const DEFAULT_BACKUP_DIR = process.env.GROUPS_BACKUP_DIR || "D:/napcat/backups/qoder-fish-groups";
const DEFAULT_KEEP_DAYS = Math.max(1, Number(process.env.GROUPS_BACKUP_KEEP_DAYS || 14) || 14);
const DEFAULT_MAX_SNAPSHOTS = Math.max(2, Number(process.env.GROUPS_BACKUP_MAX || 40) || 40);
const DEFAULT_INTERVAL_MS = Math.max(1, Number(process.env.GROUPS_BACKUP_INTERVAL_HOURS || 24) || 24) * 3600_000;
const HASH_LIMIT = 2 * 1024 * 1024;   // 大文件只记大小，避免备份时把事件循环拖住

function stamp(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function dayOfName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}/.exec(name);
  return m ? m[1] : null;
}

function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(obj, null, 1));
    renameSync(tmp, path);
    return true;
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

// 遍历源目录，返回相对路径 + 大小 + mtime（跳过锁和临时文件）
function walk(root) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? join(root, rel) : root;
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (name === ".bot.lock" || name.endsWith(".tmp")) continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      const childRel = rel ? join(rel, name) : name;
      if (st.isDirectory()) { stack.push(childRel); continue; }
      if (!st.isFile()) continue;
      const item = { path: childRel.split(sep).join("/"), size: st.size, mtimeMs: st.mtimeMs };
      if (st.size <= HASH_LIMIT) {
        try { item.sha256 = createHash("sha256").update(readFileSync(abs)).digest("hex"); } catch {}
      }
      out.push(item);
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function readSentinel(backupDir) {
  try {
    const j = JSON.parse(readFileSync(join(backupDir, ".sentinel.json"), "utf8"));
    return Array.isArray(j.files) ? j : null;
  } catch { return null; }
}

function writeSentinel(backupDir, files) {
  return writeJsonAtomic(join(backupDir, ".sentinel.json"), {
    at: Date.now(),
    files: files.map((f) => ({ path: f.path, size: f.size })),
  });
}

// 只清理过期快照目录；永不触碰源 groups 目录
function prune(backupDir, { keepDays, maxSnapshots, now }) {
  const cutoff = now - keepDays * 86_400_000;
  const dirs = [];
  for (const name of readdirSync(backupDir)) {
    const day = dayOfName(name);
    if (!day) continue;
    const abs = join(backupDir, name);
    try { if (statSync(abs).isDirectory()) dirs.push({ name, abs, day }); } catch {}
  }
  dirs.sort((a, b) => b.name.localeCompare(a.name));   // 新的在前
  for (const d of dirs) {
    const ts = new Date(`${d.day}T00:00:00`).getTime();
    if (Number.isFinite(ts) && ts >= cutoff) continue;
    try { rmSync(d.abs, { recursive: true, force: true }); } catch {}
  }
  for (const d of dirs.slice(Math.max(1, maxSnapshots))) {
    try { rmSync(d.abs, { recursive: true, force: true }); } catch {}
  }
  return dirs.length;
}

let running = null;

// 生成一份快照；同进程内单飞，避免启动/定时任务并发复制。
// 返回 { ok, dest, files, missing[], skipped? }；missing 只报告，不修复。
export async function snapshotGroups(groupsRoot, {
  reason = "manual",
  backupDir = DEFAULT_BACKUP_DIR,
  keepDays = DEFAULT_KEEP_DAYS,
  maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
  now = Date.now(),
} = {}) {
  if (running) return running;
  running = (async () => {
    // 防呆：备份目录必须在源目录之外，否则会自我递归/把历史快照再塞回源
    const rel = relative(groupsRoot, backupDir);
    const outside = isAbsolute(rel) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`);
    if (!outside) return { ok: false, error: "备份目录不能位于 groups 目录内" };
    const prev = readSentinel(backupDir);
    const allPrev = prev ? prev.files.map((f) => f.path) : [];
    if (!existsSync(groupsRoot)) {
      if (existsSync(backupDir)) prune(backupDir, { keepDays, maxSnapshots, now });
      return { ok: false, skipped: "groups 目录不存在", missing: allPrev, truncated: [] };
    }
    const files = walk(groupsRoot);
    if (!files.length) {
      if (existsSync(backupDir)) prune(backupDir, { keepDays, maxSnapshots, now });
      return { ok: true, skipped: "空目录", files: 0, missing: allPrev, truncated: [] };
    }
    mkdirSync(backupDir, { recursive: true });

    // 哨兵：先和上一份基线比，发现“曾经存在、现在缺失/被清空”的文件
    const nowByPath = new Map(files.map((f) => [f.path, f.size]));
    const missing = prev ? prev.files.filter((f) => !nowByPath.has(f.path)).map((f) => f.path) : [];
    const truncated = prev
      ? prev.files.filter((f) => nowByPath.has(f.path) && f.size > 0 && nowByPath.get(f.path) === 0).map((f) => f.path)
      : [];

    // 同秒同名会互相并入；加随机后缀，保证每份快照独立
    const dest = join(backupDir, `${stamp(now)}-${reason}-${Math.random().toString(36).slice(2, 7)}`);
    try {
      await fsp.cp(groupsRoot, dest, {
        recursive: true,
        filter: (src) => !src.endsWith(`${sep}.bot.lock`) && !src.endsWith(".tmp"),
      });
    } catch (e) {
      try { rmSync(dest, { recursive: true, force: true }); } catch {}
      return { ok: false, error: `快照复制失败：${String(e?.message ?? e).slice(0, 120)}` };
    }
    // manifest 写不出来就当这份快照作废：删掉半成品，也不推进哨兵基线
    if (!writeJsonAtomic(join(dest, "manifest.json"), { at: now, reason, source: groupsRoot, files })) {
      try { rmSync(dest, { recursive: true, force: true }); } catch {}
      return { ok: false, error: "manifest 写入失败，快照作废" };
    }
    // 只有快照成功后才更新基线；失败时保留旧基线，下次继续报缺
    const baselineOk = writeSentinel(backupDir, files);
    const kept = prune(backupDir, { keepDays, maxSnapshots, now });
    return { ok: true, dest, files: files.length, missing, truncated, baselineOk, kept };
  })().finally(() => { running = null; });
  return running;
}

// 启动即拍一份，之后按间隔拍；全部在后台，不阻塞聊天。
export function startGroupBackup(groupsRoot, {
  log = console,
  backupDir = DEFAULT_BACKUP_DIR,
  keepDays = DEFAULT_KEEP_DAYS,
  maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
  intervalMs = DEFAULT_INTERVAL_MS,
} = {}) {
  const run = async (reason) => {
    try {
      const r = await snapshotGroups(groupsRoot, { reason, backupDir, keepDays, maxSnapshots });
      const reportSentinel = () => {
        if (r.missing?.length) {
          const sample = r.missing.slice(0, 8).join(", ");
          log.log(`[哨兵] 发现 ${r.missing.length} 个曾存在、现在缺失的文件：${sample}${r.missing.length > 8 ? "…" : ""}；未自动重建，请人工核对`);
        }
        if (r.truncated?.length) {
          const sample = r.truncated.slice(0, 8).join(", ");
          log.log(`[哨兵] 发现 ${r.truncated.length} 个文件被清空（原非空）：${sample}${r.truncated.length > 8 ? "…" : ""}；未自动重建，请人工核对`);
        }
      };
      if (r.skipped) { log.log(`[备份] 快照跳过（${reason}）：${r.skipped}`); reportSentinel(); return r; }
      if (!r.ok) { log.log(`[备份] 快照失败（${reason}）：${r.error ?? "未知"}`); reportSentinel(); return r; }
      log.log(`[备份] ${reason} 快照完成：${r.files} 个文件 → ${r.dest}（保留 ${keepDays} 天 / ${maxSnapshots} 份）`);
      reportSentinel();
      if (!r.baselineOk) log.log("[备份] 哨兵基线写入失败，本轮不推进基线");
      return r;
    } catch (e) {
      log.log(`[备份] 快照失败（${reason}）：${String(e?.message ?? e).slice(0, 160)}`);
      return { ok: false, error: String(e?.message ?? e) };
    }
  };
  const timer = setInterval(() => { run("daily").catch(() => {}); }, intervalMs);
  timer.unref?.();
  run("startup").catch(() => {});
  return { run, stop: () => clearInterval(timer) };
}

// 测试/运维用：返回备份目录与当前快照列表
export function listSnapshots(backupDir = DEFAULT_BACKUP_DIR) {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((n) => dayOfName(n))
    .sort()
    .reverse()
    .map((name) => ({ name, dir: join(backupDir, name) }));
}

export { DEFAULT_BACKUP_DIR, DEFAULT_KEEP_DAYS, DEFAULT_MAX_SNAPSHOTS };
