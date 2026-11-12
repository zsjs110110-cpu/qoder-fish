// 从第三方兼容站点拉模型列表。只接受 http/https；不跟随重定向，避免把 Key 带到别的域。
// OpenAI/OpenAI-Responses 用 Bearer；Anthropic 用 x-api-key + anthropic-version。
export async function fetchModelList({
  baseUrl,
  apiKey,
  style = "openai",
  timeoutMs = 8000,
  fetchImpl = fetch,
} = {}) {
  const raw = String(baseUrl ?? "").trim();
  const key = String(apiKey ?? "").trim();
  if (!raw) throw new Error("需要 Base URL");
  if (!key) throw new Error("需要 API Key");
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error("Base URL 不合法");
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("只支持 http/https");
  u.username = "";
  u.password = "";
  let path = u.pathname.replace(/\/+$/, "");
  if (!/\/models$/i.test(path)) path = `${path}/models`;
  u.pathname = path || "/models";

  const headers = { accept: "application/json" };
  const st = String(style || "").trim().toLowerCase();
  if (st === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${key}`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, Number(timeoutMs) || 8000));
  let res;
  try {
    res = await fetchImpl(u.toString(), { method: "GET", headers, signal: ac.signal, redirect: "error" });
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("拉取模型超时");
    throw new Error(`拉取模型失败：${String(e?.message ?? e).slice(0, 180)}`);
  } finally {
    clearTimeout(timer);
  }

  const len = Number(res.headers?.get?.("content-length") || 0);
  if (len > 2 * 1024 * 1024) throw new Error("模型列表响应过大");
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    const safe = text.split(key).join("***").replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`拉取模型失败：HTTP ${res.status}${safe ? ` ${safe}` : ""}`);
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("模型列表不是 JSON"); }

  const arr = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
      : [];
  const ids = [];
  for (const item of arr) {
    const id = typeof item === "string" ? item : item?.id ?? item?.model ?? item?.name;
    const s = String(id ?? "").trim();
    if (s && !ids.includes(s)) ids.push(s);
    if (ids.length >= 300) break;
  }
  if (!ids.length) throw new Error("响应里没有模型列表");
  return ids;
}
