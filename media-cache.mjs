// 每群 TTL 磁盘缓存：只存已经通过 urlCheck 的公网图片/截图。
// key 由代码生成并 sha256；命中不发网络请求；没有 urlCheckOk 的条目一律不返回。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { CFG } from "./config.mjs";
import { loadImage } from "./media.mjs";

const META = ".json";

function hashKey(key) {
  return createHash("sha256").update(String(key)).digest("hex").slice(0, 32);
}
function cacheDir(dir) { return join(dir, "cache", "media"); }
function paths(dir, key) {
  const h = hashKey(key);
  return { dir: cacheDir(dir), meta: join(cacheDir(dir), h + META), file: join(cacheDir(dir), h) };
}

export function cacheGetBytes(dir, key, ttlMs) {
  const p = paths(dir, key);
  try {
    if (!existsSync(p.meta) || !existsSync(p.file)) return null;
    const meta = JSON.parse(readFileSync(p.meta, "utf8"));
    if (meta.urlCheckOk !== true) return null;
    if (!ttlMs || Date.now() - Number(meta.ts ?? 0) > ttlMs) return null;
    const bytes = readFileSync(p.file);
    if (!bytes.length) return null;
    return { bytes, mediaType: meta.mediaType || "image/png", ext: meta.ext || ".png" };
  } catch { return null; }
}

export function cachePutBytes(dir, key, { bytes, mediaType = "image/png", ext = ".png", urlCheckOk = false }) {
  if (!urlCheckOk || !bytes?.length) return false;
  const p = paths(dir, key);
  try {
    mkdirSync(p.dir, { recursive: true });
    const tmp = p.file + ".tmp";
    writeFileSync(tmp, bytes);
    renameSync(tmp, p.file);
    writeFileSync(p.meta, JSON.stringify({ ts: Date.now(), mediaType, ext, urlCheckOk: true }));
    return true;
  } catch { return false; }
}

export async function loadImageCached(url, { dir, key, ttlMs = CFG.mediaCacheTtlMs } = {}) {
  if (!CFG.mediaCache || !dir || !key || String(url).startsWith("data:")) return loadImage(url);
  const hit = cacheGetBytes(dir, key, ttlMs);
  if (hit) return { mediaType: hit.mediaType, data: hit.bytes.toString("base64"), bytes: hit.bytes.length };
  const img = await loadImage(url);
  if (img?.data) cachePutBytes(dir, key, { bytes: Buffer.from(img.data, "base64"), mediaType: img.mediaType, ext: img.mediaType === "image/jpeg" ? ".jpg" : ".png", urlCheckOk: true });
  return img;
}

// 启动/定时清理：删过期与超出总大小的条目（按 mtime 从旧到新）。
export function cacheSweep(dir, { ttlMs = Math.max(CFG.mediaCacheTtlMs, CFG.quoteCacheTtlMs, CFG.searchCacheTtlMs), maxBytes = CFG.mediaCacheMaxBytes } = {}) {
  const root = cacheDir(dir);
  try {
    if (!existsSync(root)) return { removed: 0 };
    // 审计修复：rename 失败残留的 .tmp 被 entries 过滤排除、此前永不清理——这里把 10 分钟前的残留一并扫掉
    for (const n of readdirSync(root)) {
      if (!n.endsWith(".tmp")) continue;
      try {
        const p = join(root, n);
        if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) rmSync(p, { force: true });
      } catch {}
    }
    const entries = readdirSync(root).filter((n) => !n.endsWith(META) && !n.endsWith(".tmp")).map((n) => {
      const p = join(root, n);
      try { return { n, p, size: statSync(p).size, mtime: statSync(p).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((s, e) => s + e.size, 0), removed = 0;
    for (const e of entries) {
      const expired = ttlMs > 0 && Date.now() - e.mtime > ttlMs;
      const over = maxBytes > 0 && total > maxBytes;
      if (!expired && !over) continue;
      try {
        // 对应的 meta 与文件同 hash 前缀；直接按文件名前缀删
        const base = e.n.replace(/\.(png|jpg|jpeg|gif|webp|bmp)$/i, "");
        rmSync(e.p, { force: true });
        rmSync(join(root, base + META), { force: true });
        total -= e.size;
        removed++;
      } catch {}
    }
    return { removed };
  } catch { return { removed: 0 }; }
}
