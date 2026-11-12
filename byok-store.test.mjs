import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadByokStore, saveByokStore } from "./byok-store.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
const dir = mkdtempSync(join(tmpdir(), "qoder-byok-store-"));

let s = saveByokStore(dir, { enabled: true, provider: "deepseek", model: "deepseek-flash-pg", apiKey: "key-1", baseEdition: "global", isVl: true });
ok("保存并读取 BYOK 配置", loadByokStore(dir).provider === "deepseek" && loadByokStore(dir).enabled === true);
ok("保存 Key", loadByokStore(dir).apiKey === "key-1", JSON.stringify(s).replace("key-1", "***"));
saveByokStore(dir, { provider: "kimi" });
ok("空 Key 不覆盖已存 Key", loadByokStore(dir).apiKey === "key-1" && loadByokStore(dir).provider === "kimi");
saveByokStore(dir, { apiKey: "" });
ok("空字符串 Key 也不覆盖", loadByokStore(dir).apiKey === "key-1");
saveByokStore(dir, { clearKey: true });
ok("clearKey 才清空 Key", loadByokStore(dir).apiKey === "");
saveByokStore(dir, { provider: "evil\nprovider", baseEdition: "not-a-track", contextWindow: 99_999_999 });
const guard = loadByokStore(dir);
ok("字段清洗：换行/非法轨/超大窗口", guard.provider === "evil provider" && guard.baseEdition === "global" && guard.contextWindow === 2_000_000, JSON.stringify(guard));
rmSync(dir, { recursive: true, force: true });
console.log(fail === 0 ? "\nBYOK 本机配置全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
