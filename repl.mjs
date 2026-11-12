import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { ask, sessionStats, flushAll, readNotes, memoryLog } from "./brain.mjs";
import { loadImage } from "./media.mjs";

function chatKeyOf(t) {
  return t.group ? `g:${t.group}` : `p:${t.user || "私聊"}`;
}
function nowLabel() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function handle(turn) {
  const images = [];
  if (turn.image) {
    try { images.push(await loadImage(turn.image)); }
    catch (e) { console.log(`   [图片读取失败] ${e.message}`); }
  }
  const res = await ask({
    chatKey: chatKeyOf(turn),
    text: turn.text,
    images,
    actor: { userId: String(turn.qq ?? turn.user ?? ""), name: turn.user, platformRole: turn.role },
    runtime: {
      group: turn.group,
      time: turn.time || nowLabel(),
      speaker: { name: turn.user, relation: turn.relation },
      memory: turn.memory,
      recent: turn.recent,
    },
  });
  const flags = [res.error && `错误:${res.error}`, res.refused && `拒回:${res.refused}`, res.retried && "重试过", res.leakScrubbed && "洗掉过标签", res.truncated && "截断过", res.broken && "坏输出", res.resumed ? `续会话(已${res.turns}轮)` : `新会话(已${res.turns}轮)`, res.role && `角色:${res.role}`]
    .filter(Boolean).join(" ");
  console.log(`  [${turn.group || "私聊"}] ${turn.user}：${turn.text}${images.length ? ` +图${images[0].bytes}B` : ""}`);
  console.log(`  → 小千：${res.text}   (${res.ms}ms${flags ? " " + flags : ""})`);
  return res;
}

const scriptArg = process.argv.indexOf("--script");
if (scriptArg > -1) {
  const turns = JSON.parse(readFileSync(process.argv[scriptArg + 1], "utf8"));
  console.log(`脚本模式：${turns.length} 条消息 ｜ ${JSON.stringify(sessionStats())}\n`);
  const keys = new Set();
  for (const t of turns) { const r = await handle(t); keys.add(r.chatKey); }
  await flushAll();
  console.log(`\n=== 记事本落盘情况 ===`);
  for (const k of keys) {
    const log = memoryLog(k);
    const notes = readNotes(k);
    console.log(`\n[${k}] 门控 ${log?.gate.length ?? 0} 次（放行 ${log?.gate.filter((g) => g.run).length ?? 0}）｜生成结果 ${log?.gen.length ?? 0} 次：${JSON.stringify(log?.gen ?? [])}`);
    console.log(`   注入 ${JSON.stringify(log?.consume ?? [])}`);
    console.log(`   记事本内容（${[...notes].length} 字）：\n${notes.trim() ? notes.trim().split("\n").map((l) => "   " + l).join("\n") : "   （空）"}`);
  }
  console.log(`\n完成。当前存活会话：${sessionStats().live}`);
  process.exit(0);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
let state = { group: "本地测试群", user: "你", relation: "常聊的群友" };
console.log(`本地 REPL ｜ ${JSON.stringify(sessionStats())}`);
console.log("指令：/g 群名  /u 昵称  /p 私聊  /i 图片路径或链接  /r 群最近消息（分号分隔）  /stat  /quit\n");

function prompt() { rl.question(`${state.group || "私聊"}|${state.user}> `, run); }

async function run(line) {
  line = line.trim();
  if (!line) return prompt();
  if (line === "/quit") return rl.close();
  if (line === "/stat") { console.log(sessionStats()); return prompt(); }
  if (line.startsWith("/g ")) { state.group = line.slice(3).trim(); return prompt(); }
  if (line.startsWith("/u ")) { state.user = line.slice(3).trim(); return prompt(); }
  if (line === "/p") { state.group = ""; return prompt(); }
  if (line.startsWith("/r ")) { state.recent = line.slice(3).split(";").map((s) => s.trim()); return prompt(); }

  let image = null;
  if (line.startsWith("/i ")) {
    image = line.slice(3).trim();
    line = await new Promise((res) => rl.question("   配什么话？> ", res));
  }
  await handle({ ...state, text: line, image, recent: state.recent });
  prompt();
}
prompt();
