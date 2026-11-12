import { readFileSync, existsSync, mkdirSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CFG } from "./config.mjs";
import { urlCheck } from "./auth.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const norm = (p) => String(p).replace(/[\\/]+/g, "/").toLowerCase();
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
const OK_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

function typeFromName(ref) {
  const m = /\.([a-z0-3]{3,4})(?:\?|$)/i.exec(ref ?? "");
  return MIME[(m && m[1].toLowerCase())] || null;
}

async function readCapped(res, maxBytes) {
  const chunks = [];
  let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > maxBytes) throw new Error(`响应超过 ${maxBytes} 字节，已中断`);
    chunks.push(c);
  }
  return Buffer.concat(chunks, n);
}

// 只接受：本群媒体缓存目录里的文件、或经过 auth.urlCheck 的公网 http(s) 图片
export async function loadImage(ref, { allowLocalAny = false } = {}) {
  if (!ref) return null;

  if (ref.startsWith("data:")) {
    const [head, b64] = ref.slice(5).split(",");
    const mediaType = head.split(";")[0] || "";
    if (!OK_TYPES.has(mediaType)) throw new Error(`不接受的图片类型 ${mediaType}`);
    const bytes = Buffer.from(b64 ?? "", "base64");
    if (!bytes.length) throw new Error("图片是空的");
    if (bytes.length > CFG.imageMaxBytes) throw new Error(`图片太大 ${bytes.length} 字节`);
    return { mediaType, data: bytes.toString("base64"), bytes: bytes.length };
  }

  if (/^https?:\/\//i.test(ref)) {
    const g = await urlCheck(ref);
    if (!g.ok) throw new Error(`图片地址不安全，不下载：${g.reason}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(ref, { signal: ctrl.signal, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) throw new Error("图片地址在重定向，按规矩不追");
      if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
      const declared = (res.headers.get("content-type") || "").split(";")[0].trim();
      // 审核修复 F-11：扩展名伪装不再放行——URL 以 .png 结尾但服务端明确返回 text/html 等非图片类型时直接拒。
      // declared 为空或 octet-stream（部分图床不给准确类型）仍按扩展名判，避免误杀正常图源
      if (/^(text\/|application\/(json|xml|javascript|xhtml))/i.test(declared)) {
        throw new Error(`不是可识别的图片类型（${declared}）`);
      }
      const mediaType = (typeFromName(ref) ?? declared) || "";
      if (!OK_TYPES.has(mediaType)) throw new Error(`不是可识别的图片类型（${mediaType || "未知"}）`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > CFG.imageMaxBytes) throw new Error(`图片太大 ${len} 字节`);
      const bytes = await readCapped(res, CFG.imageMaxBytes);
      return { mediaType, data: bytes.toString("base64"), bytes: bytes.length };
    } finally {
      clearTimeout(timer);
    }
  }

  // 本地路径：默认只允许媒体缓存目录内的文件（越界/读源码文件一律拒）
  const mediaRoot = norm(join(HERE, CFG.mediaCacheDir));
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(ref) || ref.startsWith("/");
  const abs = norm(isAbsolute ? ref : join(HERE, ref));
  if (!allowLocalAny && !abs.startsWith(mediaRoot + "/")) throw new Error("本地图片只认缓存目录里的，其他路径不读");
  if (!existsSync(abs)) throw new Error(`图片不存在：${String(ref).slice(0, 60)}`);
  const mediaType = typeFromName(abs);
  if (!mediaType) throw new Error("本地文件不像图片（要 png/jpg/gif/webp/bmp）");
  const bytes = readFileSync(abs);
  if (bytes.length > CFG.imageMaxBytes) throw new Error(`图片太大 ${bytes.length} 字节`);
  return { mediaType, data: bytes.toString("base64"), bytes: bytes.length };
}

export function ensureMediaDir() {
  mkdirSync(join(HERE, CFG.mediaCacheDir), { recursive: true });
  return join(HERE, CFG.mediaCacheDir);
}
