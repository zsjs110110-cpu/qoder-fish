// 极简本机管理台：只绑 127.0.0.1，页面自带一次性 CSRF token。
// 状态接口不返回 API Key；设置接口把 BYOK 配置写到 byok-config.json。
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const MAX_BODY = 32 * 1024;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("invalid json")); }
    });
    req.on("error", reject);
  });
}

function tokenOk(req, token) {
  const given = String(req.headers["x-admin-token"] ?? "");
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function html(token) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>小千 · SDK 管理台</title>
<style>
:root{color-scheme:dark}body{margin:0;background:#11151c;color:#e7edf6;font:14px/1.5 system-ui,"Segoe UI",sans-serif}
main{max-width:1040px;margin:0 auto;padding:24px}h1{font-size:21px;margin:0}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.muted{color:#8d9aab}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:16px}
.card,section{background:#1a202a;border:1px solid #2a3442;border-radius:10px;padding:14px}.card b{display:block;font-size:18px;margin-top:4px}
section{margin-bottom:14px}h2{font-size:15px;margin:0 0 10px;color:#b8c6d8}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{background:#2b6de0;color:#fff;border:0;border-radius:7px;padding:8px 13px;cursor:pointer}button.secondary{background:#2a3442}button:disabled{opacity:.45;cursor:wait}
button.active{outline:2px solid #7db4ff}input,select{background:#10151c;border:1px solid #334052;color:#e7edf6;border-radius:6px;padding:7px 9px;min-width:130px}
label{display:flex;gap:7px;align-items:center}form .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}form .field{display:flex;flex-direction:column;gap:5px}
input[type=checkbox]{min-width:auto}code{color:#9fd1ff}pre{white-space:pre-wrap;color:#b8c6d8;margin:0}.msg{min-height:22px;margin:8px 0;color:#84d6a2}.msg.bad{color:#ff9b9b}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:6px;border-bottom:1px solid #26303d}th{color:#8d9aab;font-weight:500}
</style></head><body><main>
<header><h1>小千 · SDK 管理台</h1><span class="muted" id="clock"></span></header>
<div class="cards">
  <div class="card">当前轨道<b id="edition">-</b></div>
  <div class="card">切换冷却<b id="cooldown">-</b></div>
  <div class="card">BYOK 状态<b id="byokState">-</b></div>
  <div class="card">会话 / 队列<b id="live">-</b></div>
</div>
<section><h2>运行轨道</h2><div class="row" id="editionButtons">
  <button data-edition="cn">cn</button><button data-edition="global">global</button><button data-edition="byok">byok</button>
  <span class="muted" id="availability"></span></div><div class="msg" id="editionMsg"></div></section>
<section><h2>运行状态</h2><pre id="botStatus">加载中…</pre></section>
<section><h2>BYOK 第三方备用</h2>
<div class="muted">Key 只保存在本机 <code>byok-config.json</code>，页面和日志不显示原文；空 Key 表示保留已存 Key。</div>
<form id="byokForm"><div class="grid">
  <label class="field">启用 BYOK <span><input type="checkbox" id="enabled"></span></label>
  <label class="field">provider<input id="provider" placeholder="deepseek / openai / kimi"></label>
  <label class="field">model<span class="row"><input id="model" list="modelList" placeholder="模型 id"><button type="button" class="secondary" id="fetchModels">拉取模型</button></span><datalist id="modelList"></datalist></label>
  <label class="field">API Key<input id="apiKey" type="password" autocomplete="new-password" placeholder="留空不改"></label>
  <label class="field">Base URL（可选）<input id="baseUrl" placeholder="https://站点/v1"></label>
  <label class="field">style<select id="style"><option value="">默认(openai)</option><option value="openai">openai</option><option value="openai-responses">openai-responses</option><option value="anthropic">anthropic</option></select></label>
  <label class="field">基础轨<select id="baseEdition"><option value="global">global</option><option value="cn">cn</option></select></label>
  <label class="field">推理档（可选）<input id="reasoningEffort" placeholder="如 medium"></label>
  <label class="field">上下文窗口（可选）<input id="contextWindow" type="number" min="0" step="1000" placeholder="0=默认"></label>
  <label class="field">视觉 <span><input type="checkbox" id="isVl"> 模型支持图片</span></label>
  <label class="field">自动兜底 <span><input type="checkbox" id="fallback"> Qoder 不可用时自动切 BYOK</span></label>
  <label class="field">清空 Key <span><input type="checkbox" id="clearKey"> 保存时删除已存 Key</span></label>
</div><div class="row" style="margin-top:12px"><button type="submit">保存 BYOK 设置</button><span class="muted" id="byokHint"></span></div></form>
<div class="msg" id="modelsMsg"></div><div class="msg" id="byokMsg"></div></section>
<section><h2>最近切轨</h2><table><thead><tr><th>时间</th><th>方向</th><th>原因</th></tr></thead><tbody id="history"></tbody></table></section>
<div class="msg" id="globalMsg"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);
let formReady = false;
function text(id, v) { const el = $(id); if (el) el.textContent = v == null ? "-" : String(v); }
function setMsg(id, text, bad) { const el = $(id); el.textContent = text || ""; el.className = "msg" + (bad ? " bad" : ""); }
function fmtMs(ms) { if (!ms) return "可切换"; const m = Math.ceil(ms / 60000); return m >= 60 ? Math.floor(m/60) + "h" + (m%60) + "m" : m + "m"; }
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.method === "POST") { headers["content-type"] = "application/json"; headers["x-admin-token"] = TOKEN; }
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || ("HTTP " + r.status));
  return j;
}
function fillForm(b) {
  $("enabled").checked = !!b.enabled; $("provider").value = b.provider || ""; $("model").value = b.model || "";
  $("apiKey").value = ""; $("apiKey").placeholder = b.hasKey ? "已设置（留空不改）" : "未设置";
  $("baseUrl").value = b.baseUrl || ""; $("style").value = b.style || ""; $("baseEdition").value = b.baseEdition || "global";
  $("reasoningEffort").value = b.reasoningEffort || ""; $("contextWindow").value = b.contextWindow || 0;
  $("isVl").checked = !!b.isVl; $("fallback").checked = b.fallback !== false; $("clearKey").checked = false;
  $("byokHint").textContent = b.ready ? "配置完整，可切到 byok" : (b.enabled ? "配置不完整" : "未启用");
  formReady = true;
}
function render(s) {
  text("edition", s.edition); text("cooldown", fmtMs(s.cooldownMs));
  const b = s.byok || {};
  text("byokState", b.ready ? "ready" : b.enabled ? "不完整" : "off");
  const q = (s.bot && s.bot.queue) || {};
  text("live", (s.bot ? s.bot.live : "-") + " / " + (q.waiting || 0) + " waiting");
  const av = s.availability || {};
  text("availability", "cn=" + (av.cn ? "✓" : "✗") + "  global=" + (av.global ? "✓" : "✗") + "  byok=" + (av.byok ? "✓" : "✗"));
  document.querySelectorAll("[data-edition]").forEach((el) => el.classList.toggle("active", el.dataset.edition === s.edition));
  text("botStatus", JSON.stringify({ pid: s.pid, uptimeSec: s.uptimeSec, bot: s.bot }, null, 1));
  const tbody = $("history"); tbody.replaceChildren();
  for (const h of (s.history || [])) {
    const tr = document.createElement("tr");
    for (const v of [new Date(h.at).toLocaleString("zh-CN", {hour12:false}), h.from + " → " + h.to, h.reason]) {
      const td = document.createElement("td"); td.textContent = v; tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  if (!formReady) fillForm(b);
  $("clock").textContent = new Date(s.now || Date.now()).toLocaleString("zh-CN", {hour12:false});
}
async function refresh() {
  try { const j = await api("/api/status"); render(j.status); setMsg("globalMsg", ""); }
  catch (e) { setMsg("globalMsg", "读取失败：" + e.message, true); }
}
document.querySelectorAll("[data-edition]").forEach((el) => el.onclick = async () => {
  setMsg("editionMsg", "切换中…");
  try { await api("/api/edition", { method: "POST", body: JSON.stringify({ edition: el.dataset.edition }) }); setMsg("editionMsg", "已切换"); formReady = false; await refresh(); }
  catch (e) { setMsg("editionMsg", "失败：" + e.message, true); }
});
$("fetchModels").onclick = async () => {
  setMsg("modelsMsg", "拉取中…"); $("fetchModels").disabled = true;
  try {
    const j = await api("/api/models", { method: "POST", body: JSON.stringify({ baseUrl: $("baseUrl").value.trim(), apiKey: $("apiKey").value, style: $("style").value }) });
    const list = j.models || [];
    const dl = $("modelList"); dl.replaceChildren();
    for (const id of list) { const o = document.createElement("option"); o.value = id; dl.appendChild(o); }
    if (list.length && !$("model").value.trim()) $("model").value = list[0];
    setMsg("modelsMsg", "拉取到 " + list.length + " 个模型，点 model 输入框选择");
  } catch (e) { setMsg("modelsMsg", "拉取失败：" + e.message, true); }
  finally { $("fetchModels").disabled = false; }
};
$("byokForm").onsubmit = async (ev) => {
  ev.preventDefault(); setMsg("byokMsg", "保存中…");
  const body = {
    enabled: $("enabled").checked, provider: $("provider").value.trim(), model: $("model").value.trim(),
    apiKey: $("apiKey").value, baseUrl: $("baseUrl").value.trim(), style: $("style").value,
    baseEdition: $("baseEdition").value, reasoningEffort: $("reasoningEffort").value.trim(),
    contextWindow: Number($("contextWindow").value || 0), isVl: $("isVl").checked,
    fallback: $("fallback").checked, clearKey: $("clearKey").checked,
  };
  try { await api("/api/byok", { method: "POST", body: JSON.stringify(body) }); setMsg("byokMsg", "已保存"); formReady = false; await refresh(); }
  catch (e) { setMsg("byokMsg", "失败：" + e.message, true); }
};
refresh(); setInterval(refresh, 5000);
</script></main></body></html>`;
}

export async function startAdminServer({
  port = 6100,
  host = "127.0.0.1",
  token = randomBytes(18).toString("hex"),
  getStatus,
  switchEdition,
  saveByok,
  listModels,
  log = console,
} = {}) {
  if (typeof getStatus !== "function" || typeof switchEdition !== "function" || typeof saveByok !== "function") {
    throw new Error("startAdminServer 需要 getStatus/switchEdition/saveByok");
  }
  const server = createServer(async (req, res) => {
    if (!LOOPBACK.has(String(req.socket.remoteAddress ?? ""))) return json(res, 403, { ok: false, error: "local only" });
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
          "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        });
        return res.end(html(token));
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return json(res, 200, { ok: true, status: await getStatus() });
      }
      if (req.method === "POST" && (url.pathname === "/api/edition" || url.pathname === "/api/byok" || url.pathname === "/api/models")) {
        if (!tokenOk(req, token)) return json(res, 403, { ok: false, error: "bad token" });
        const body = await readBody(req);
        if (url.pathname === "/api/edition") {
          if (!["cn", "global", "byok"].includes(body.edition)) return json(res, 400, { ok: false, error: "edition must be cn/global/byok" });
          await switchEdition(body.edition);
        } else if (url.pathname === "/api/byok") {
          await saveByok(body);
        } else {
          if (typeof listModels !== "function") return json(res, 501, { ok: false, error: "拉取模型未启用" });
          return json(res, 200, { ok: true, models: await listModels(body) });
        }
        return json(res, 200, { ok: true, status: await getStatus() });
      }
      return json(res, 404, { ok: false, error: "not found" });
    } catch (e) {
      return json(res, 400, { ok: false, error: String(e?.message ?? e).slice(0, 240) });
    }
  });
  const handle = { server, token, close: () => new Promise((r) => server.close(() => r())) };
  const ok = await new Promise((resolve) => {
    const onError = (e) => {
      log.log(`[管理台] 启动失败：${e.code === "EADDRINUSE" ? `端口 ${port} 已被占用` : e.message}`);
      resolve(false);
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      server.on("error", (e) => log.log(`[管理台] ${e.message}`));
      server.unref?.();   // 不因管理台监听而阻止 bot/REPL 正常退出
      handle.port = server.address().port;
      resolve(true);
    });
  });
  return ok ? handle : null;
}
