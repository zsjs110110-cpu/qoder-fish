import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheGetBytes, cachePutBytes, cacheSweep } from "./media-cache.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "media-cache-test-"));
const other = mkdtempSync(join(tmpdir(), "media-cache-test2-"));
try {
  const bytes = Buffer.from("hello-image");
  ok("未通过 urlCheck 不落盘", cachePutBytes(dir, "k", { bytes, urlCheckOk: false }) === false);
  ok("未通过 urlCheck 取不到", cacheGetBytes(dir, "k", 60_000) === null);
  ok("通过 urlCheck 可落盘", cachePutBytes(dir, "k", { bytes, mediaType: "image/png", urlCheckOk: true }) === true);
  const hit = cacheGetBytes(dir, "k", 60_000);
  ok("命中返回原字节", hit?.bytes.toString() === "hello-image", hit?.bytes?.length);
  ok("跨群不命中", cacheGetBytes(other, "k", 60_000) === null);
  await sleep(5);
  ok("过期不返回", cacheGetBytes(dir, "k", 1) === null);
  cachePutBytes(dir, "new", { bytes, urlCheckOk: true });
  const swept = cacheSweep(dir, { ttlMs: 1 });
  ok("sweep 清理过期条目", swept.removed >= 1, JSON.stringify(swept));
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(other, { recursive: true, force: true });
}
console.log(fail === 0 ? "\n媒体缓存全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
