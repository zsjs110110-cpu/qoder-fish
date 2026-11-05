import { createServer } from "node:http";
import { fetchModelList } from "./model-list.mjs";

let fail = 0;
const ok = (n, c, x = "") => { if (!c) fail++; console.log(`${c ? "ok  " : "FAIL"} ${n}${x ? " ｜ " + x : ""}`); };
let sawBearer = "", sawAnthropic = "";
const srv = createServer((req, res) => {
  if (req.url === "/v1/models" && req.headers.authorization === "Bearer key-1") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }] }));
  }
  if (req.url === "/v1/models" && req.headers["x-api-key"] === "key-1") {
    sawAnthropic = req.headers["anthropic-version"] || "";
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: [{ id: "claude-x" }] }));
  }
  if (req.url === "/ollama/models") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ models: [{ name: "llama3" }, { name: "qwen" }] }));
  }
  sawBearer = req.headers.authorization || "";
  const provided = sawBearer.replace(/^Bearer\s+/i, "");
  res.writeHead(401, { "content-type": "text/plain" });
  res.end(`bad key ${provided || "unknown"}`);
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${srv.address().port}`;

const ids = await fetchModelList({ baseUrl: `${base}/v1`, apiKey: "key-1" });
ok("OpenAI /models 拉取并去重", ids.join(",") === "model-a,model-b", ids.join(","));
const anthropic = await fetchModelList({ baseUrl: `${base}/v1`, apiKey: "key-1", style: "anthropic" });
ok("Anthropic 使用 x-api-key", anthropic[0] === "claude-x" && sawAnthropic === "2023-06-01", sawAnthropic);
const ollama = await fetchModelList({ baseUrl: `${base}/ollama`, apiKey: "key-1" });
ok("兼容 Ollama models[name]", ollama.join(",") === "llama3,qwen", ollama.join(","));
try { await fetchModelList({ baseUrl: `${base}/v1`, apiKey: "wrong" }); ok("401 应报错", false); }
catch (e) { ok("401 报错且 Key 脱敏", e.message.includes("401") && e.message.includes("***") && !e.message.includes("wrong"), e.message); }
try { await fetchModelList({ baseUrl: "", apiKey: "k" }); ok("空 URL 应报错", false); }
catch (e) { ok("空 URL 报错", e.message.includes("Base URL"), e.message); }
try { await fetchModelList({ baseUrl: `${base}/v1`, apiKey: "" }); ok("空 Key 应报错", false); }
catch (e) { ok("空 Key 报错", e.message.includes("API Key"), e.message); }
srv.close();
console.log(fail === 0 ? "\n模型列表拉取全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
