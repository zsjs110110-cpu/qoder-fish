// 对 mock OneBot 服务端联调 WS 传输层：握手、发送、白名单、自消息、token、断线重连。
// 不打模型（askBrain 注入桩），不依赖真 NapCat。
import { WebSocketServer } from "ws";
import { createServer } from "node:http";
import { rmSync } from "node:fs";
import { RULES, connect, isGroupMuted, muteRemaining, persistMutes, _resetMutes } from "./adapters/onebot.mjs";
import { CFG } from "./config.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupDir } from "./brain.mjs";
import { readRecent } from "./recent.mjs";

// 测试隔离（2026-11-01 事故修复）：禁言落盘别写进生产 groups/mute-state.json
CFG.groupsDir = join(tmpdir(), `xq-mock-mute-isolate-${process.pid}`);

const TOKEN = "test-token-abc";
let fail = 0;
const ok = (name, cond, extra = "") => { if (!cond) fail++; console.log(`${cond ? "ok  " : "FAIL"} ${name}${extra ? " ｜ " + String(extra).slice(0, 80) : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = null;
const stub = async (req) => { lastReq = req; return { text: `桩回复:${(req.text || "").slice(0, 6)}`, ms: 5, role: "member" }; };

function makeServer({ requireToken = TOKEN, port = 0 } = {}) {
  const sent = [];
  const requests = [];
  const msgStore = new Map();          // 发出去的消息可按 message_id 回查（get_msg），模拟 NapCat 的会话内消息表
  const state = { fail1200: false };   // 模拟本号被禁言：群发送一律 retcode=1200
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: "/onebot" });
  let conn = null;
  wss.on("connection", (ws, req) => {
    const u = new URL(req.url, "http://x");
    if (requireToken && u.searchParams.get("access_token") !== requireToken) { ws.close(1008, "bad token"); return; }
    conn = ws;
    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      requests.push(msg);
      if (msg.action === "get_login_info") {
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { user_id: 100001, nickname: "小千" }, echo: msg.echo }));
      } else if (msg.action === "get_status") {
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { online: true, good: true, group_message: true }, echo: msg.echo }));
      } else if (msg.action === "get_group_list") {
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data: [{ group_id: 111, name: "测试群", member_count: 3, role: "member" }], echo: msg.echo }));
      } else if (msg.action === "get_friend_list") {
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data: [{ user_id: 222, nickname: "阿哲" }], echo: msg.echo }));
      } else if (msg.action === "get_group_member_list") {
        ws.send(JSON.stringify({ status: "ok", retcode: 0, data: [{ user_id: 100001, nickname: "小千" }, { user_id: 222, card: "哲哥" }], echo: msg.echo }));
      } else if (msg.action === "send_group_msg" || msg.action === "send_private_msg") {
        sent.push(msg);
        // 照真 NapCat 的行为来：message 传 segment 数组就报 1200（真机实测），只收字符串；
        // fail1200 开关模拟禁言（禁言中 send_group_msg 稳定 1200，私聊不受影响）
        if (Array.isArray(msg.params?.message) || (state.fail1200 && msg.action === "send_group_msg")) {
          ws.send(JSON.stringify({ status: "failed", retcode: 1200, message: "EventChecker Failed: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg", echo: msg.echo }));
        } else {
          // message_id 递增：A 回写用发送返回的 id 当缓冲位次锚点，固定 9001 会掩盖重复/错位问题
          const mid = 9000 + sent.length;
          // 存进消息表：她回写的 id 必须能被 get_msg 查回（端到端"群友回复她"闭环的前提）
          if (msg.action === "send_group_msg") {
            msgStore.set(mid, {
              group_id: msg.params.group_id, user_id: 100001,
              message: [{ type: "text", data: { text: String(msg.params.message ?? "") } }],
            });
          }
          ws.send(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: mid }, echo: msg.echo }));
        }
      } else if (msg.action === "get_msg") {
        const m = msgStore.get(Number(msg.params?.message_id));
        m
          ? ws.send(JSON.stringify({ status: "ok", retcode: 0, data: m, echo: msg.echo }))
          : ws.send(JSON.stringify({ status: "failed", retcode: 1000, message: "no such msg", echo: msg.echo }));
      } else {
        ws.send(JSON.stringify({ status: "failed", retcode: 1000, message: "mock 不认这个动作", echo: msg.echo }));
      }
    });
  });
  const listening = new Promise((r) => http.once("listening", r));
  http.listen(port, "127.0.0.1");
  return {
    sent, requests, listening,
    setFail1200: (v) => { state.fail1200 = v; },
    get port() { return http.address().port; },
    push: (ev) => conn?.send(JSON.stringify(ev)),
    close: async () => {
      try { conn?.close(); } catch {}
      await new Promise((r) => { wss.close(); http.close(() => r()); });
    },
  };
}

// 真实 OneBot v11 事件：没有 echo，也没有 retcode
const groupEv = (over = {}) => ({
  time: Math.floor(Date.now() / 1000), self_id: 100001, post_type: "message", message_type: "group",
  sub_type: "normal", message_id: 1, group_id: 111, user_id: 222,
  sender: { user_id: 222, nickname: "阿哲", card: "哲哥", role: "member", title: "", area: "" },
  message: [{ type: "text", text: "在吗" }], raw_message: "在吗", ...over,
});

RULES.allowGroups = ["111"];
RULES.allowPrivate = [];
RULES.requireAtInGroup = false;

let srv = makeServer();
await srv.listening;
const firstPort = srv.port;
const client = connect(`ws://127.0.0.1:${firstPort}/onebot`, { token: TOKEN, askBrain: stub });
await sleep(800);
ok("A1 握手取到 self_id", client.selfId === 100001, `selfId=${client.selfId}`);
ok("A1b 首个请求是 get_login_info", srv.requests[0]?.action === "get_login_info", srv.requests[0]?.action);

srv.push(groupEv({ message_id: 101 }));
await sleep(700);
ok("A2 白名单内群消息 → 发出 send_group_msg", srv.sent.length === 1, `sent=${srv.sent.length}`);
const p = srv.sent[0]?.params ?? {};
ok("A2b 目标群号正确", p.group_id === 111, JSON.stringify(p).slice(0, 60));
ok("A2c 内容是桩回复", String(p.message).startsWith("桩回复:"), p.message);
ok("A2d message 发的是字符串（真 NapCat 不认段数组）", typeof p.message === "string", true);
// A 回写：她自己的话进旁路缓冲，id=发送返回的 message_id，将来 reply 段引用它时 reply#N 能对上
const recA2 = readRecent(groupDir("g:111"), 30);
ok("A2e 她的回复回写进缓冲（mine=true，id=发送返回）",
  recA2.some((x) => x.mine === true && x.uid === "100001" && x.id === 9001 && String(x.text).startsWith("桩回复:")),
  JSON.stringify(recA2.at(-1) ?? {}).slice(0, 90));

// 端到端闭环（缺口 1 的验收标准）：群友 reply 段引用她刚回写的 9001（NapCat 真实形状：只有 id 没有 uid）
// → connect 层 get_msg 回查解析出发送者=她 → onEvent 三层判定认出硬点名。minGap 2000ms，睡足再查。
srv.push(groupEv({ message_id: 120, message: [{ type: "reply", data: { id: "9001" } }, { type: "text", data: { text: "你刚才那句什么意思" } }] }));
await sleep(2600);
ok("A2f 回复她（get_msg 端到端解析）→ replyToMe=true", lastReq?.runtime?.replyToMe === true, JSON.stringify(lastReq?.runtime ?? {}).slice(0, 140));
ok("A2g 回复她 → addressed=true", lastReq?.runtime?.addressed === true, true);

srv.sent.length = 0;
srv.push(groupEv({ group_id: 999, message_id: 102 }));
srv.push(groupEv({ user_id: 100001, message_id: 103 }));
srv.push(groupEv({ message: [{ type: "face", id: 1 }], message_id: 104 }));
await sleep(700);
ok("A3/A4 白名单外群、自己发的、无文本消息都不回", srv.sent.length === 0, `sent=${srv.sent.length}`);

RULES.allowPrivate = ["222"];
srv.push({ ...groupEv(), message_type: "private", message_id: 105, sender: { user_id: 222, nickname: "阿哲", role: "friend" } });
await sleep(600);
ok("A4b 私聊 → send_private_msg", srv.sent[0]?.action === "send_private_msg", srv.sent[0]?.action);
// 私聊没有 L4 缓冲：她的私聊回复不得回写进群缓冲。此刻群缓冲里 mine 恰好 2 条：A2 回写(9001) +
// A2f 那轮的再回写(9002)；事件 103（她的回显）已被事件通道关门、私聊发送不回写——计数同时锁两道护栏
const mineN = () => readRecent(groupDir("g:111"), 50).filter((x) => x.mine === true).length;
ok("A4b2 私聊发送不回写群缓冲（mine 恒为两条群回写）", mineN() === 2, `mine=${mineN()}`);

srv.sent.length = 0;
srv.push(groupEv({ message: [{ type: "record", file: "x.amr" }, { type: "text", text: "顺便问一句" }], message_id: 106 }));
await sleep(600);
ok("A5 语音段不影响文本，进程存活", srv.sent.length === 1, `sent=${srv.sent.length}`);

console.log("\n— WP1：旁路缓冲在真实事件流里落盘 —");
const recentLines = readRecent(groupDir("g:111"), 30);
ok("C1 白名单群消息进了 recent.jsonl（不管她回没回）", recentLines.some((r) => r.id === 101 && r.text === "在吗" && r.uid === "222" && r.mine === false), JSON.stringify(recentLines.at(-1)).slice(0, 90));
ok("C1b 白名单外群（999）没进缓冲", !recentLines.some((r) => r.id === 102), true);
ok("C1c 她本人的回显不走事件通道（她的话只由 sendPaced 回写进缓冲）", !recentLines.some((r) => r.id === 103), true);
ok("C1d 语音+文本的也记了正文", recentLines.some((r) => r.id === 106 && r.text === "顺便问一句"), true);
ok("C1e 纯表情没正文不记录", !recentLines.some((r) => r.id === 104), true);
ok("C2 L4 请求里带了【刚才群里】的行", Array.isArray(lastReq?.runtime?.recent) && lastReq.runtime.recent.length >= 1, JSON.stringify(lastReq?.runtime?.recent?.slice(-1)).slice(0, 90));
// 2026-11-03 D：行可能带 [线X] 标记（话题线），正则要允许可选标记，否则真实场景会误报
ok("C2b 行形状是 #编号 [线X]? 时:分 名字(uid) → 目标：正文", /^#\d+(?: \[线[A-Z]+\])? \d{2}:\d{2} .+\(\d+\) → .+：/.test(lastReq?.runtime?.recent?.at(-1) ?? ""), lastReq?.runtime?.recent?.at(-1));

// napcat-doctor 依赖的只读通道
const gl = await client.call("get_group_list");
ok("A8 client.call 能拿群列表（doctor 靠这个填白名单）", Array.isArray(gl) && gl[0]?.group_id === 111, JSON.stringify(gl).slice(0, 60));
const stt = await client.call("get_status");
ok("A8b get_status 读到 online", stt?.online === true, JSON.stringify(stt).slice(0, 60));
const mm = await client.call("get_group_member_list", { group_id: 111 });
ok("A8c 成员列表里能认出自己", Array.isArray(mm) && mm.some((m) => m.user_id === 100001), JSON.stringify(mm).slice(0, 60));
let rejected = "";
try { await client.call("不存在的动作"); } catch (e) { rejected = e.message; }
ok("A8d 未知动作是报错而不是挂住", /失败|超时|1000/.test(rejected), rejected);

console.log("\n— 禁言自愈接线（真实事件流 + 发送循环） —");
// 禁言跳过发生在 onEvent 里、模型调用之前：若自愈/跳过失灵，第 3 条消息会产生新的 send_group_msg
// 尝试（mock 的 sent 连失败也计），用发送次数增量就能同时暴露"没静默"和"静默了但还在调模型后发送"两种回归
srv.setFail1200(true);                       // 模拟禁言生效（无 notice——对应"停机期被禁言"场景）
const sentBase = srv.sent.length;
srv.push(groupEv({ message_id: 107 }));      // 第 1 轮：调模型 → 发送 1200
await sleep(2600);
srv.push(groupEv({ message_id: 108 }));      // 第 2 轮：再 1200 → 触发自愈
await sleep(2600);
ok("M1 连续两轮 1200 触发自愈静默", isGroupMuted(111), `remaining=${muteRemaining(111)}`);
const sentAtHeal = srv.sent.length - sentBase;
srv.push(groupEv({ message_id: 109 }));      // 第 3 轮：应被静默跳过（不调模型不发送）
await sleep(800);
ok("M2 自愈后不再发送（onEvent 层静默）", srv.sent.length - sentBase === sentAtHeal,
  `sentΔ=${srv.sent.length - sentBase - sentAtHeal}`);
srv.push({ time: Math.floor(Date.now() / 1000), self_id: 100001, post_type: "notice", notice_type: "group_ban", sub_type: "lift_ban", group_id: 111, user_id: 100001, duration: 0 });
await sleep(500);
srv.push(groupEv({ message_id: 110 }));      // 解除后恢复发送
await sleep(2800);
ok("M3 解除 notice 清静默并恢复发送", !isGroupMuted(111) && srv.sent.length - sentBase === sentAtHeal + 1,
  `muted=${isGroupMuted(111)} sentΔ=${srv.sent.length - sentBase - sentAtHeal}`);
srv.setFail1200(false);
_resetMutes();
persistMutes();   // 收尾清真实 groupsDir 的落盘残留

console.log("\n— 发送额度打满：只留档不进模型（真实闸门接线） —");
const privEv = (id) => ({ ...groupEv(), message_type: "private", message_id: id, sender: { user_id: 222, nickname: "阿哲", role: "friend" } });
// 私聊窗口里 A4b 已发 1 条；把额度调到 2 → 再发 1 条正好打满，第 3 条应在接收侧被跳过
const origCap = CFG.sendHourlyCap;
CFG.sendHourlyCap = 2;
srv.push(privEv(111));
await sleep(2600);                       // 用掉最后一条额度
const sentAtCap = srv.sent.length;
srv.push(privEv(112));
await sleep(800);
ok("G1 额度打满后不发送（接收侧跳过）", srv.sent.length === sentAtCap, `sentΔ=${srv.sent.length - sentAtCap}`);
CFG.sendHourlyCap = origCap;
srv.push(privEv(113));
await sleep(2600);
ok("G2 额度恢复后照常发送", srv.sent.length > sentAtCap, `sentΔ=${srv.sent.length - sentAtCap}`);

await srv.close();
await sleep(400);
srv = makeServer({ port: firstPort });
await srv.listening;
await sleep(4500);
ok("A6 断线后自动重连并重新握手", srv.requests.some((r) => r.action === "get_login_info"), JSON.stringify(srv.requests.map((r) => r.action)).slice(0, 60));

const bad = makeServer({ requireToken: "另一个token" });
await bad.listening;
const c2 = connect(`ws://127.0.0.1:${bad.port}/onebot`, { token: TOKEN, askBrain: stub });
await sleep(1200);
ok("A7 token 不对时被踢掉且不崩（selfId 仍为空）", c2.selfId === null, `selfId=${c2.selfId}`);

c2.close();
client.close();
await bad.close();
await sleep(200);
// 审核 F-13：清掉测试写进真实 groups/ 的假群目录（g:111），不在生产数据目录留垃圾
try { rmSync(groupDir("g:111"), { recursive: true, force: true }); } catch {}
console.log(fail === 0 ? "\nOneBot 传输层联调通过（mock 服务端）" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
