// A10 交付事件：append/read/最新状态，未发送判定
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDelivery, readDeliveries, deliveryOf, isUnsent } from "./delivery.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const dir = mkdtempSync(join(tmpdir(), "delivery-test-"));
try {
  ok("写入 sent 事件", appendDelivery(dir, { turnId: "t1", chatKey: "g:1", status: "sent", partsSent: 2, partsPlanned: 2 }), true);
  ok("写入 failed 事件", appendDelivery(dir, { turnId: "t2", status: "failed", error: "boom" }), true);
  ok("写入 partial 事件", appendDelivery(dir, { turnId: "t3", status: "partial", partsSent: 1, partsPlanned: 3 }), true);
  let map = readDeliveries(dir);
  ok("读取状态", deliveryOf(map, "t1") === "sent" && deliveryOf(map, "t2") === "failed" && deliveryOf(map, "t3") === "partial", JSON.stringify([...map]));
  ok("未记录的 turnId 是 unknown", deliveryOf(map, "nope"), "unknown");
  ok("failed/dropped 算未发送", isUnsent("failed") && isUnsent("dropped") && !isUnsent("sent") && !isUnsent("partial") && !isUnsent("unknown"), true);
  appendDelivery(dir, { turnId: "t1", status: "failed" });
  map = readDeliveries(dir);
  ok("同一 turnId 以后写入的为准", deliveryOf(map, "t1"), "failed");
  ok("非法事件不写", appendDelivery(dir, { status: "sent" }) === false, true);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(fail === 0 ? "\n交付事件全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
