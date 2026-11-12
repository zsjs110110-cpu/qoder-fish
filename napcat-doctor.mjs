// 只读自查：连上 NapCat，打印机器人身份、状态、它所在的群（群号就是 ALLOW_GROUPS 要填的东西）。
// 不回任何消息（askBrain 桩返回 null），也不写各群的旁路缓冲（connect 传 recordRecent:false），
// 所以可以安全地在真号上跑。注意：OBSERVE_SECONDS 会把收到的消息字段打印到控制台——别把输出贴到群里。
//   ONEBOT_WS=ws://127.0.0.1:3001/ ONEBOT_TOKEN=xxx node napcat-doctor.mjs
import { connect, textOf } from "./adapters/onebot.mjs";

const url = process.env.ONEBOT_WS || process.argv[2];
if (!url) {
  console.log("用法：ONEBOT_WS=ws://127.0.0.1:3001/ ONEBOT_TOKEN=你的token node napcat-doctor.mjs");
  console.log("（NapCat 侧要开的是「WebSocket 服务器」，路径要跟 WebUI 里填的一致）");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${label} 超时`); })]);

const rawEvents = [];
const client = connect(url, { token: process.env.ONEBOT_TOKEN, askBrain: async () => ({ text: "" }), onEventRaw: (ev) => rawEvents.push(ev), recordRecent: false });

// 等握手把 self_id 拿回来（token 不对时这里会一直为空）
for (let i = 0; i < 20 && client.selfId == null; i++) await sleep(250);
if (client.selfId == null) {
  console.log("× 没拿到登录信息：地址/路径/token 至少有一个不对，或者 NapCat 还没登录。");
  console.log("  先确认 NapCat 控制台有没有显示「WebSocket 服务器 已启动」，再核对 token。");
  client.close();
  process.exit(2);
}
console.log(`√ 已连接 ${url.replace(/(access_token|token)=[^&]*/gi, "$1=***")}`);
console.log(`  机器人 QQ=${client.selfId}`);

const grab = async (action) => {
  try { return await withTimeout(client.call(action), 12_000, action); }
  catch (e) { return { __err: e.message }; }
};

const me = await grab("get_login_info");
console.log(`  昵称：${me?.nickname ?? me.__err ?? "?"}`);
const st = await grab("get_status");
console.log(`  状态：${st.__err ? st.__err : `online=${st?.online} 群消息开关=${st?.group_message}`}`);

const groups = await grab("get_group_list");
if (groups.__err) console.log(`  群列表：拿不到（${groups.__err}）——改去 QQ 里看群资料，群号写在群公告页底部。`);
else if (!Array.isArray(groups)) console.log(`  群列表：返回的不是数组（${JSON.stringify(groups).slice(0, 80)}）`);
else {
  // 实测 NapCat 的群对象是 group_name/group_remark/member_count，没有 name、也没有 role
  console.log(`  所在群 ${groups.length} 个：`);
  for (const g of groups) console.log(`    ${g.group_id}  ${g.group_name ?? g.name ?? g.group_remark ?? "(没给名字)"}（成员 ${g.member_count ?? "?"}）`);
  if (groups.length) console.log(`\n  填白名单用：ALLOW_GROUPS=${groups.map((g) => g.group_id).join(",")}`);
}

const friends = await grab("get_friend_list");
console.log(`  好友：${friends.__err ? friends.__err : `${(friends ?? []).length} 个`}（私聊默认只回主人，要放开就填 ALLOW_PRIVATE=<qq号>）`);

let mem = null;
if (Array.isArray(groups) && groups[0]) {
  try { mem = await withTimeout(client.call("get_group_member_list", { group_id: groups[0].group_id }), 12_000, "成员列表"); }
  catch (e) { console.log(`  成员列表：${e.message}`); }
}
if (Array.isArray(mem)) {
  const me = mem.find((m) => String(m.user_id) === String(client.selfId));
  console.log(`  示例群 ${groups[0].group_id} 成员 ${mem.length} 人，我在名单里：${me ? "是" : "否"}${me?.role ? `，角色 ${me.role}` : ""}`);
}

// 1) 只读观察：抓真实入站事件的字段形状（默认不发任何东西）
// 2) SEND_TEST=<群号>：往那个群发一条自检文本，验发送通路（这条是给真人看的，只在明确授权时用）
const observe = Number(process.env.OBSERVE_SECONDS || 0);
const sendTo = process.env.SEND_TEST ? String(process.env.SEND_TEST) : "";
if (observe > 0 || sendTo) {
  if (observe > 0) console.log(`\n观察 ${observe} 秒：在群里 @ 机器人发一条消息（带张图更好），这里会打出真实事件形状。`);
  const t0 = Date.now();
  let printed = 0;
  if (sendTo) {
    const text = process.env.SEND_TEXT || "（自检）这条是发送通路测试，不是我搭讪。";
    try {
      const d = await withTimeout(client.call("send_group_msg", { group_id: Number(sendTo), message: String(text) }), 15_000, "send_group_msg");
      console.log(`\n√ 已发到群 ${sendTo}，message_id=${d?.message_id ?? "?"}（去 QQ 里确认肉眼可见）`);
    } catch (e) { console.log(`\n× 发送失败：${String(e.message ?? e).slice(0, 160)}`); }
  }
  while (Date.now() - t0 < Math.max(observe, sendTo ? 10 : 0) * 1000) {
    await sleep(500);
    while (printed < rawEvents.length) {
      const ev = rawEvents[printed++];
      console.log(`  事件#${printed}：message_type=${ev.message_type} 群=${ev.group_id ?? "-"} 人=${ev.user_id} sender键=${Object.keys(ev.sender ?? {}).join("/")} message=${Array.isArray(ev.message) ? "array" : typeof ev.message}`);
      console.log(`    原始段=${JSON.stringify(ev.message).slice(0, 260)}`);
      const segs = Array.isArray(ev.message) ? ev.message : [{ type: "text", text: String(ev.message ?? "") }];
      console.log(`    解析出的文本=${JSON.stringify(textOf(segs))}  图片段=${segs.filter((s) => s.type === "image").length}  @段=${segs.filter((s) => s.type === "at").length}`);
    }
  }
  if (!rawEvents.length && observe > 0) console.log("  这期间没收到任何 message 事件（没人发消息，或者 NapCat 的事件推送没打通）。");
}

client.close();
console.log("\n结论：OneBot 链路通。要让小千进群说话，就把上面的群号填进 ALLOW_GROUPS 再跑 index.mjs。");
process.exit(0);
