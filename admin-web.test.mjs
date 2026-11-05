import { startAdminServer } from "./admin-web.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
let switched = null, saved = null, listed = null;
const status = () => ({
  now: Date.now(), pid: 1, uptimeSec: 2, edition: "cn", cooldownMs: 0,
  availability: { cn: true, global: true, byok: false },
  bot: { live: 1, queue: { waiting: 0 } },
  byok: { enabled: false, ready: false, provider: "", model: "", hasKey: false, baseEdition: "global" },
  history: [],
});
const admin = await startAdminServer({
  port: 0, token: "test-token",
  getStatus: status,
  switchEdition: async (e) => { switched = e; return { edition: e }; },
  saveByok: async (p) => { saved = p; return { ok: true }; },
  listModels: async (p) => { listed = p; return ["model-a", "model-b"]; },
});
ok("管理台启动", Boolean(admin) && typeof admin.port === "number" && admin.port > 0, JSON.stringify(admin?.port));
const base = `http://127.0.0.1:${admin.port}`;
let r = await fetch(`${base}/`);
let html = await r.text();
ok("首页可访问且是管理台", r.status === 200 && html.includes("SDK 管理台"));
r = await fetch(`${base}/api/status`);
const st = await r.json();
ok("状态接口返回当前轨道", r.status === 200 && st.ok === true && st.status.edition === "cn");
r = await fetch(`${base}/api/edition`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ edition: "global" }) });
ok("没有写操作 token 被拒", r.status === 403 && switched === null);
r = await fetch(`${base}/api/edition`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "bad" }, body: JSON.stringify({ edition: "global" }) });
ok("错误 token 被拒", r.status === 403 && switched === null);
r = await fetch(`${base}/api/edition`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "test-token" }, body: JSON.stringify({ edition: "global" }) });
ok("正确 token 可手动切轨", r.status === 200 && switched === "global", JSON.stringify(switched));
r = await fetch(`${base}/api/edition`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "test-token" }, body: JSON.stringify({ edition: "nope" }) });
ok("非法轨道被拒", r.status === 400 && switched === "global");
r = await fetch(`${base}/api/byok`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "test-token" }, body: JSON.stringify({ provider: "deepseek", model: "x", apiKey: "secret" }) });
ok("BYOK 设置写入", r.status === 200 && saved?.provider === "deepseek" && saved?.apiKey === "secret");
r = await fetch(`${base}/api/models`, { method: "POST", headers: { "content-type": "application/json", "x-admin-token": "test-token" }, body: JSON.stringify({ baseUrl: "https://api.example/v1", apiKey: "secret", style: "openai" }) });
const mj = await r.json();
ok("拉模型接口返回列表", r.status === 200 && mj.ok === true && mj.models?.join(",") === "model-a,model-b" && listed?.baseUrl === "https://api.example/v1");
await admin.close();
console.log(fail === 0 ? "\n管理台 HTTP 全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
