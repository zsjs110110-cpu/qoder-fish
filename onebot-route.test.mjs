import { onEvent, RULES, textOf, shouldReply, createSendGate, renderMessageText, quotedContextOf, quoteIdOf, groupBanNotice, isGroupMuted, muteRemaining, persistMutes, loadMutes, noteSendFailure, noteSendSuccess, capMutesForReconnect, syncMutesFromServer, _resetMutes } from "./adapters/onebot.mjs";
import { renderRecent } from "./recent.mjs";
import { groupDir } from "./brain.mjs";
import { ensureMediaDir } from "./media.mjs";
import { writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CFG } from "./config.mjs";

// 测试隔离（2026-11-01 事故修复）：禁言落盘绝不能写进生产 groups/mute-state.json。
// 昨天套件末尾的 persistMutes() 把正在生效的 24h 禁言清成了 {}，重启后 bot 会误判"没禁言"、
// 白调模型再吃 1200。groupDir() 用的是 import 时锁定的 GROUPS_ROOT，不受这里影响。
CFG.groupsDir = join(tmpdir(), `xq-mute-isolate-${process.pid}`);

const SELF = "100001";
let mid = 100;
let last = null;
const stub = async (req) => { last = req; return { text: `回声:${(req.text || "").slice(0, 8)}${req.images?.length ? `+图${req.images.length}` : ""}|${req.chatKey}|${req.actor?.userId}|${req.actor?.platformRole ?? "-"}`, ms: 1 }; };
const ctx = { getSelfId: () => SELF, askBrain: stub };

// 真实 OneBot v11 事件形状：发言者信息在 sender 里，顶层没有 nickname/card/role
const groupEv = (segs, extra = {}) => ({
  time: Math.floor(Date.now() / 1000), self_id: Number(SELF), post_type: "message", message_type: "group", sub_type: "normal",
  message_id: ++mid, group_id: 111, user_id: 222, font: 0, sender: { user_id: 222, nickname: "阿哲", card: "哲哥", role: "admin", title: "", area: "" },
  message: segs, raw_message: "", echo: null, retcode: 0, ...extra,
});
const privEv = (segs, uid = 333) => ({
  time: Math.floor(Date.now() / 1000), self_id: Number(SELF), post_type: "message", message_type: "private", sub_type: "friend",
  message_id: ++mid, user_id: uid, sender: { user_id: uid, nickname: "老王", card: "", role: "friend", title: "", area: "" },
  message: segs, raw_message: "", retcode: 0,
});

let fail = 0;
const check = (name, got, want) => { const ok = String(got) === String(want); if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name} → ${got}${ok ? "" : `（应为 ${want}）`}`); };

RULES.allowGroups = []; RULES.allowPrivate = []; RULES.requireAtInGroup = false;

let r = await onEvent(groupEv([{ type: "text", text: "在吗" }]), ctx);
check("群消息放行", r?.sends[0].group_id, 111);
check("card 优先于 nickname", last.actor.name, "哲哥");
check("平台角色取自 sender.role", last.actor.platformRole, "admin");
check("chatKey 用群号", last.chatKey, "g:111");
check("群消息回复目标只带群号", r.sends[0].user_id === undefined ? "undefined" : "有", "undefined");

// 图片：缓存目录外的本地路径一律不读，缓存目录内的正常读
check("本地越界图片不读", await onEvent(groupEv([{ type: "image", file: "C:/Users/you/config.mjs" }]), ctx), "null");
const cache = ensureMediaDir();
const sample = join(cache, "route-test.png");
// 自包含的 1x1 PNG 样本，不依赖本机任何图片文件
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
writeFileSync(sample, Buffer.from(PNG_B64, "base64"));
r = await onEvent(groupEv([{ type: "image", file: sample }]), ctx);
check("缓存目录内图片可读", /图1/.test(r?.sends[0].message ?? ""), true);
r = await onEvent(groupEv([{ type: "image", data: { file: sample } }]), ctx);
check("真实 data 包裹的图片可读", /图1/.test(r?.sends[0].message ?? ""), true);

check("空消息不回", await onEvent(groupEv([{ type: "face", data: { id: "1" } }]), ctx), "null");
check("自己发的消息不回", await onEvent(groupEv([{ type: "text", text: "hi" }], { user_id: Number(SELF) }), ctx), "null");

RULES.allowGroups = ["999"];
check("群不在白名单", await onEvent(groupEv([{ type: "text", text: "hi" }]), ctx), "null");
RULES.allowGroups = ["111"];

RULES.requireAtInGroup = true;
check("要@但没@", await onEvent(groupEv([{ type: "text", text: "hi" }]), ctx), "null");
check("要@且被@", (await onEvent(groupEv([{ type: "at", qq: Number(SELF) }, { type: "text", text: " hi" }]), ctx)) ? "ok" : "null", "ok");
check("真实 data 包裹的 @+文本", (await onEvent(groupEv([{ type: "at", data: { qq: SELF } }, { type: "text", data: { text: " 在吗" } }]), ctx)) ? "ok" : "null", "ok");
RULES.requireAtInGroup = false;

RULES.allowPrivate = ["999"];
check("私聊不在白名单", await onEvent(privEv([{ type: "text", text: "hi" }]), ctx), "null");
r = await onEvent(privEv([{ type: "text", text: "hi" }], 999), ctx);
check("私聊在白名单 → 私回", r?.sends[0].user_id, 999);
check("私聊 chatKey", last.chatKey, "p:999");
check("未知 message_type 不回", await onEvent({ ...privEv([{ type: "text", text: "hi" }]), message_type: "other" }, ctx), "null");
RULES.allowPrivate = [];
RULES.allowGroups = [];

check("textOf 跨 at 段拼接", textOf([{ type: "text", text: "你" }, { type: "at", qq: 1 }, { type: "text", text: "好" }]), "你好");
RULES.allowPrivate = ["999"];
check("字符串 message 兼容", shouldReply({ post_type: "message", message_type: "private", user_id: 999, sender: {}, message: "你好" }, SELF), true);
RULES.allowPrivate = [];
check("sender 缺失也不崩", shouldReply({ post_type: "message", message_type: "group", group_id: 1, user_id: 5, message: [{ type: "text", text: "x" }] }, SELF), true);
r = await onEvent({ post_type: "message", message_type: "group", group_id: 1, user_id: 5, message: [{ type: "text", text: "没有 sender 的事件" }] }, ctx);
check("无 sender 时回退到 user_id", last.actor.name, "5");

check("textOf 解包 data", textOf([{ type: "text", data: { text: "你" } }, { type: "at", data: { qq: 1 } }, { type: "text", data: { text: "好" } }]), "你好");
const dup = groupEv([{ type: "text", data: { text: "去重" } }]);
await onEvent(dup, ctx);
check("重复 message_id 只回一次", await onEvent(dup, ctx), "null");
check("旧消息不回", await onEvent(groupEv([{ type: "text", data: { text: "旧" } }], { time: Math.floor(Date.now() / 1000) - 3600 }), ctx), "null");

console.log("\n— 不 @ 也接话（默认）与「跳过」出口 —");
RULES.requireAtInGroup = false;
r = await onEvent(groupEv([{ type: "text", data: { text: "有人要吃炸鸡吗" } }]), ctx);
check("不@ 的闲聊她也会回", String(r?.sends[0].message ?? "").startsWith("回声:"), true);
check("并且告诉她这句不是点名说的", last.runtime.addressed, false);
r = await onEvent(groupEv([{ type: "at", data: { qq: Number(SELF) } }, { type: "text", data: { text: " 小千你觉得呢" } }]), ctx);
check("被 @ 时 addressed=true", last.runtime.addressed, true);
r = await onEvent(groupEv([{ type: "text", data: { text: "今晚看球不" } }]), { getSelfId: () => SELF, askBrain: async () => ({ text: "", silent: true, ms: 1 }) });
check("她判断不值得接 → 一个字都不发", r, null);
RULES.requireAtInGroup = true;
check("REQUIRE_AT=1 时不@ 仍然不回", await onEvent(groupEv([{ type: "text", data: { text: "再试一次不@的" } }]), ctx), "null");

console.log("\n— 长回复拆成几条发 —");
RULES.requireAtInGroup = false;
const longStub = { getSelfId: () => SELF, askBrain: async () => ({ text: "今天最戳我的是 Anthropic 递交了 IPO 文件准备上市啦。AI 圈又热闹起来了。你今天过得怎么样呀？", ms: 1 }) };
r = await onEvent(groupEv([{ type: "text", data: { text: "今天有什么新闻" } }]), longStub);
check("一条长回复变成多个气泡", r.sends.length >= 2, true);
check("每个气泡都不超长", r.sends.every((x) => [...x.message].length <= 26), true);
check("都发给同一个群", r.sends.every((x) => x.group_id === 111), true);
r = await onEvent(groupEv([{ type: "text", data: { text: "短的那条" } }]), { getSelfId: () => SELF, askBrain: async () => ({ text: "在呀", ms: 1 }) });
check("短回复还是发一条", r.sends.length, 1);

console.log("\n— 生成图走 CQ 字符串发送 —");
CFG.imageOutDir = join(tmpdir(), "xiaoqian-route-images");
const imgStub = { getSelfId: () => SELF, askBrain: async () => ({ text: "画好了", images: [sample], ms: 1 }) };
r = await onEvent(groupEv([{ type: "text", data: { text: "画张图" } }]), imgStub);
check("文本 + 图片两条", r?.sends.length, 2);
check("第二条是 CQ 图片", String(r?.sends[1]?.message ?? "").startsWith("[CQ:image,file="), true);
const stagedPath = String(r?.sends[1]?.message ?? "").replace(/^\[CQ:image,file=/, "").replace(/\]$/, "");
check("图片已复制到无空格目录", existsSync(stagedPath) && !/\s/.test(stagedPath), true);
check("图片目标仍是群 111", r?.sends[1]?.group_id, 111);

console.log("\n— ImageSearch 下载图走 CQ 字符串发送 —");
const onePx = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0XcAAAAASUVORK5CYII=";
const searchStub = { getSelfId: () => SELF, askBrain: async () => ({ text: "找到了一张：测试", searchImages: [{ url: onePx, title: "测试" }], ms: 1 }) };
r = await onEvent(groupEv([{ type: "text", data: { text: "找张图" } }]), searchStub);
check("搜索结果是文字+图片两条", r?.sends.length, 2);
check("搜索图也是 CQ 图片", String(r?.sends[1]?.message ?? "").startsWith("[CQ:image,file="), true);
const searchPath = String(r?.sends[1]?.message ?? "").replace(/^\[CQ:image,file=/, "").replace(/\]$/, "");
check("搜索图已落盘且无空格", existsSync(searchPath) && !/\s/.test(searchPath), true);
check("搜索图目标仍是群 111", r?.sends[1]?.group_id, 111);
const badSearchStub = { getSelfId: () => SELF, askBrain: async () => ({ text: "找到了", searchImages: [{ url: "http://127.0.0.1/x.jpg" }], ms: 1 }) };
r = await onEvent(groupEv([{ type: "text", data: { text: "找张图" } }]), badSearchStub);
check("搜索图下载失败 → 不发假成功", r?.sends[0]?.message, "图找到了但没发出去，你再来一次？");

console.log("\n— 引用消息里的图片 —");
check("引用纯图有占位文本", await renderMessageText([{ type: "image", data: { url: "https://example.com/a.png" } }], {}), "[图片]");
const quoteImgEv = groupEv([{ type: "text", text: "这张图里有什么" }]);
quoteImgEv._quotedText = "【引用的消息】[图片]";
quoteImgEv._quotedImages = [onePx];
r = await onEvent(quoteImgEv, ctx);
check("引用图进了本轮 images", last.images.length, 1);
check("引用图带 quote 来源", last.images[0]?.origin, "quote");
check("引用图占位进本轮 text", String(last.text).includes("[图片]"), true);
const bothImgEv = groupEv([{ type: "image", url: onePx }, { type: "text", text: "对比一下" }]);
bothImgEv._quotedImages = [onePx];
r = await onEvent(bothImgEv, ctx);
check("当前图在前、引用图在后", last.images.map((x) => x.origin ?? "current").join(","), "current,quote");
const qc = await quotedContextOf(123, {
  call: async (action, params) => {
    check("引用回查用 get_msg+message_id", `${action}/${params.message_id}`, "get_msg/123");
    return { message: [{ type: "image", data: { url: onePx } }] };
  },
});
check("引用回查文本占位", qc.text, "[图片]");
check("引用回查收集图片", qc.images.length, 1);
check("真实 reply 段 data.id 能取到", quoteIdOf([{ type: "reply", data: { id: 456 } }]), "456");
check("CQ 字符串 reply 段顶层 id 也能取到", quoteIdOf([{ type: "reply", id: "789" }]), "789");
check("没有引用段时返回空", quoteIdOf([{ type: "text", data: { text: "hi" } }]), "");

console.log("\n— 引用回查同源校验（跨会话短号碰撞/伪造不进来） —");
const qApi = (msg) => ({ call: async () => ({ message: [{ type: "text", data: { text: "原文" } }], ...msg }) });
check("群回查同群放行", (await quotedContextOf(501, qApi({ group_id: 111, user_id: 222 }), { chatKey: "g:111" })).text, "原文");
check("群回查他群拒绝", (await quotedContextOf(502, qApi({ group_id: 999, user_id: 222 }), { chatKey: "g:111" })).text, "");
check("群回查私聊原文拒绝（无 group_id）", (await quotedContextOf(503, qApi({ user_id: 555 }), { chatKey: "g:111" })).text, "");
check("私聊回查群消息拒绝", (await quotedContextOf(504, qApi({ group_id: 111, user_id: 222 }), { chatKey: "p:333" })).text, "");
check("私聊回查对方消息放行", (await quotedContextOf(505, qApi({ user_id: 333 }), { chatKey: "p:333" })).text, "原文");
check("私聊回查她本人消息放行", (await quotedContextOf(506, qApi({ user_id: 100001 }), { chatKey: "p:333", selfId: "100001" })).text, "原文");
check("私聊回查第三者消息拒绝", (await quotedContextOf(507, qApi({ user_id: 555 }), { chatKey: "p:333", selfId: "100001" })).text, "");
check("不带 chatKey 的老用法不受校验影响", (await quotedContextOf(508, qApi({ user_id: 999999 }))).text, "原文");
// fail-closed 边界与缓存交互
let probeCalls = 0;
const probeApi = { call: async () => { probeCalls++; return { user_id: 555 }; } };   // 群 key 下无私聊字段 → 越界
await quotedContextOf(511, probeApi, { chatKey: "g:111" });
await quotedContextOf(511, probeApi, { chatKey: "g:111" });
check("越界结果不缓存：重复回查仍会重新拉取", probeCalls, 2);
check("私聊回查缺发送者 fail-closed", (await quotedContextOf(512, qApi({}), { chatKey: "p:333", selfId: "100001" })).text, "");
check("私聊 selfId 缺失时对方消息放行", (await quotedContextOf(513, qApi({ user_id: 333 }), { chatKey: "p:333" })).text, "原文");
check("群回查她本人消息按群号放行", (await quotedContextOf(514, qApi({ group_id: 111, user_id: 100001 }), { chatKey: "g:111" })).text, "原文");

// 超长正文截断：入站正文只留前 maxTextChars 字
r = await onEvent(groupEv([{ type: "text", text: "啊".repeat(5000) }]), ctx);
check("超长正文截断到 maxTextChars", (last?.text ?? "").length <= CFG.maxTextChars, true);

console.log("\n— 点名三层判定 A/B/C（2026-11-03） —");
// B：quotedContextOf 顺带回传被引用消息发送者 uid（get_msg 本来就拿到了）
check("回查带出被引用消息 uid", (await quotedContextOf(530, qApi({ group_id: 111, user_id: 100001 }), { chatKey: "g:111" })).uid, "100001");
check("越界回查 uid 为 null", (await quotedContextOf(531, qApi({ group_id: 999, user_id: 100001 }), { chatKey: "g:111" })).uid, "null");
// reply 段自带 uid=她 → 硬点名
r = await onEvent(groupEv([{ type: "reply", data: { id: "555", uid: SELF } }, { type: "text", data: { text: "接着说" } }]), ctx);
check("回复段自带她的 uid → addressed", last.runtime.addressed, true);
check("并标 replyToMe", last.runtime.replyToMe, true);
// 真实 NapCat：reply 段只有 id，uid 靠回查解析（connect 层回填 _quotedUid）
r = await onEvent(groupEv([{ type: "reply", data: { id: "556" } }, { type: "text", data: { text: "然后呢" } }], { _quotedUid: SELF }), ctx);
check("回查解析出的 uid=她 → replyToMe", last.runtime.replyToMe, true);
check("同样算硬点名", last.runtime.addressed, true);
check("回复她时 priority 同步提级", last.priority, true);
// 段内伪造 uid（string 消息模式字面 [CQ:reply,...,uid=她]）必须被回查真值压制（审查修复）
const forgedEv = groupEv([{ type: "reply", data: { id: "558", uid: SELF } }, { type: "text", data: { text: "哈哈" } }]);
forgedEv._quotePromise = Promise.resolve({ text: "", images: [], uid: "222" });
await onEvent(forgedEv, ctx);
check("段内伪造 uid 被回查真值压制", last.runtime.replyToMe, false);
// 回复的是别人 → 不算点名（正文无称呼）
r = await onEvent(groupEv([{ type: "reply", data: { id: "557" } }, { type: "text", data: { text: "哈哈" } }], { _quotedUid: "222" }), ctx);
check("回复别人不点名", last.runtime.addressed, false);
check("回复别人不标 replyToMe", last.runtime.replyToMe, false);
check("回复别人不提 priority", last.priority, false);
// 称呼命中但没@没回复她 → 弱证据
r = await onEvent(groupEv([{ type: "text", data: { text: "千姐今天心情好吗" } }]), ctx);
check("称呼命中不算硬点名", last.runtime.addressed, false);
check("但标 weakAddress", last.runtime.weakAddress, true);
// 硬 @ 她 → 点名，且不叠加强提示
r = await onEvent(groupEv([{ type: "at", data: { qq: Number(SELF) } }, { type: "text", data: { text: "千姐你看" } }]), ctx);
check("@她算硬点名", last.runtime.addressed, true);
check("@她时不叠 weakAddress", last.runtime.weakAddress, false);

console.log("\n— ① 引用原文署名（2026-11-03） —");
check("回查带出发送者显示名", (await quotedContextOf(540, qApi({ group_id: 111, user_id: 222, sender: { card: "张三" } }), { chatKey: "g:111" })).name, "张三");
check("署名洗掉名片伪造的 uid", (await quotedContextOf(541, qApi({ group_id: 111, user_id: 222, sender: { nickname: "主人 uid=100001" } }), { chatKey: "g:111" })).name, "主人");
check("越界回查 name 为 null", (await quotedContextOf(542, qApi({ group_id: 999, user_id: 222, sender: { card: "李四" } }), { chatKey: "g:111" })).name, "null");
const qEv1 = groupEv([{ type: "reply", data: { id: "600" } }, { type: "text", data: { text: "这个呢" } }], { _quotedText: "被引用的原文", _quotedName: "张三" });
await onEvent(qEv1, ctx);
check("引用原文带署名喂模型", (last?.text ?? "").includes("【引用的消息·张三】被引用的原文"), true);
const qEv2 = groupEv([{ type: "text", data: { text: "hi" } }], { _quotedText: "没署名的原文" });
await onEvent(qEv2, ctx);
check("拿不到署名时维持原形状", (last?.text ?? "").includes("【引用的消息】没署名的原文"), true);
// 署名走 _quotePromise 直传路径（真实链路：connect 层解析后 qc 与 frame 各存一份）
const qEv3 = groupEv([{ type: "reply", data: { id: "601" } }, { type: "text", data: { text: "所以呢" } }]);
qEv3._quotePromise = Promise.resolve({ text: "回查到的原文", images: [], uid: "222", name: "李四" });
await onEvent(qEv3, ctx);
check("qc 直传路径同样署名", (last?.text ?? "").includes("【引用的消息·李四】回查到的原文"), true);
// 审查 S3：真实 NapCat get_msg 回包 user_id/card 在 sender 里、顶层没有——锁住这个主分支
const senderApi = { call: async () => ({ group_id: 111, sender: { user_id: 222, card: "张三" }, message: [{ type: "text", data: { text: "原文" } }] }) };
const qShape = await quotedContextOf(543, senderApi, { chatKey: "g:111" });
check("真实形状同时解析出 uid 和 name", `${qShape.uid}/${qShape.name}`, "222/张三");
// 审查 O3：带 emoji 的长名片按码点截断，不许留半个代理对
const emoApi = { call: async () => ({ group_id: 111, sender: { user_id: 222, nickname: "🐟".repeat(30) }, message: [{ type: "text", data: { text: "原文" } }] }) };
const emoName = (await quotedContextOf(544, emoApi, { chatKey: "g:111" })).name;
check("emoji 名片截到 24 码点且无半个代理对", [...emoName].length === 24 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(emoName), true);

console.log("\n— 卡片/引用消息解析 —");
const cardJson = JSON.stringify({
  prompt: "[QQ小程序]弹幕：这个演示视频真好看",
  meta: { detail_1: { title: "某视频站", desc: "弹幕：这个演示视频真好看", qqdocurl: "https://example.com/video123", url: "m.q.qq.com/a/s/abc" } },
});
const cardText = textOf([{ type: "json", data: { data: cardJson } }]);
check("JSON 卡片带出真实链接", cardText.includes("example.com/video123"), true);
check("JSON 卡片带出正文", cardText.includes("这个演示视频"), true);
const xmlCard = textOf([{ type: "xml", data: { data: "<msg><title>测试卡片</title><summary>卡片正文</summary><url>https://example.com/card</url></msg>" } }]);
check("XML 卡片带出链接/正文", xmlCard.includes("example.com/card") && xmlCard.includes("卡片正文"), true);
const quotedEv = groupEv([{ type: "text", data: { text: "这个" } }]);
quotedEv._quotedText = "【卡片】链接：https://example.com/video123；正文：弹幕：这个演示...";
r = await onEvent(quotedEv, ctx);
check("引用的卡片进入本轮 text", String(last.text).includes("example.com/video123"), true);
const fwdEv = groupEv([{ type: "text", data: { text: "看这个" } }]);
fwdEv._forwardText = "【转发消息 2 条】\n甲：你好\n乙：【卡片】链接：https://example.com/card；正文：转发里的卡片";
r = await onEvent(fwdEv, ctx);
check("转发消息进入本轮 text", String(last.text).includes("【转发消息 2 条】"), true);
const fwdOnly = groupEv([]);
fwdOnly._forwardText = "【转发消息 1 条】\n甲：你好";
r = await onEvent(fwdOnly, ctx);
check("纯转发消息也能进模型", String(last.text).includes("【转发消息 1 条】"), true);

console.log("\n— 转发消息里的图片 —");
const fwdImgEv = groupEv([{ type: "text", data: { text: "看这个转发" } }]);
fwdImgEv._forwardText = "【转发消息 1 条】\n甲：[图片]";
fwdImgEv._forwardImages = [onePx];
r = await onEvent(fwdImgEv, ctx);
check("转发图片进本轮 images", last.images.length, 1);
check("转发图片来源 forward", last.images[0]?.origin, "forward");
check("转发图片占位仍在 text", String(last.text).includes("[图片]"), true);
const fwdCollector = [];
const fwdApi = { call: async (action) => action === "get_forward_msg"
  ? { messages: [{ sender: { nickname: "甲" }, message: [{ type: "image", data: { url: onePx } }] }] }
  : {} };
const fwdText = await renderMessageText([{ type: "forward", data: { id: "fwd-img-1" } }], fwdApi, "g:forward-test", fwdCollector);
check("转发文本保留图片占位", fwdText.includes("[图片]"), true);
check("转发图片 ref 被收集", fwdCollector[0], onePx);
const fwdCollector2 = [];
await renderMessageText([{ type: "forward", data: { id: "fwd-img-1" } }], fwdApi, "g:forward-test", fwdCollector2);
check("转发图缓存命中仍收集图片", fwdCollector2[0], onePx);
const quotedFwd = await quotedContextOf(777, {
  call: async (action) => action === "get_msg"
    ? { group_id: 111, user_id: 222, message: [{ type: "forward", data: { id: "fwd-img-quoted" } }] }
    : { messages: [{ sender: { nickname: "甲" }, message: [{ type: "image", data: { url: onePx } }] }] },
}, { chatKey: "g:111" });
check("引用里的转发图片也被收集", quotedFwd.images.includes(onePx), true);

console.log("\n— ImageGen 异步：主回一句，后台补图 —");
const asyncSends = [];
const drawStub = async () => sample;
const drawRes = {
  getSelfId: () => SELF,
  askBrain: async () => ({ text: "好，我画一下，画好了发你。", role: "owner", draw: { prompt: "测试猫娘" }, ms: 1 }),
  sendAsync: async (m) => { asyncSends.push(m); },
  runDraw: drawStub,
};
r = await onEvent(groupEv([{ type: "text", data: { text: "画一张猫娘" } }]), drawRes);
check("主回合只回一句", r?.sends.length, 1);
check("ack 是短句", String(r?.sends[0]?.message ?? "").includes("画好了发你"), true);
check("meta 标记 draw", r?.meta?.draw, true);
await new Promise((resolve) => setTimeout(resolve, 1000));
check("后台发了完成语", asyncSends.includes("画好了，给你。"), true);
const asyncImg = asyncSends.find((m) => String(m).startsWith("[CQ:image,file="));
check("后台补了 CQ 图片", Boolean(asyncImg), true);
if (asyncImg) {
  const p = String(asyncImg).replace(/^\[CQ:image,file=/, "").replace(/\]$/, "");
  check("后台图片已落盘", existsSync(p), true);
}

console.log("\n— 发送节奏闸门 —");
{
  let clock = 1_000_000;
  const waits = [];
  const order = [];
  const gate = createSendGate({
    minGapMs: 2000,
    hourlyCap: 4,
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); clock += ms; },
  });
  const send = (tag) => async () => { order.push(tag); };
  let g = await gate("g:1", send("a1"));
  check("第一条不等待", g.waitedMs, 0);
  g = await gate("g:1", send("a2"));
  check("同群第二条等满 2 秒", g.waitedMs, 2000);
  g = await gate("g:2", send("b1"));
  check("不同群各算各的", g.waitedMs, 0);
  g = await gate("g:1", send("a3"));
  check("第三条仍按 2 秒排", g.waitedMs, 2000);
  g = await gate("g:1", send("a4"));
  check("第四条到上限前还能发", g.ok, true);
  g = await gate("g:1", send("a5"));
  check("第 5 条被小时上限挡下", `${g.ok}/${g.reason}/${g.sent}`, "false/hourly/4");
  clock += 3_600_000;
  g = await gate("g:1", send("a6"));
  check("滑过 1 小时重新放行", g.ok, true);
  check("发送顺序保持串行", order.join(","), "a1,a2,b1,a3,a4,a6");

  let c2 = 2_000_000;
  const waits2 = [];
  const gate2 = createSendGate({ minGapMs: 2000, hourlyCap: 0, now: () => c2, sleep: async (ms) => { waits2.push(ms); c2 += ms; } });
  let release;
  const p1 = gate2("g:9", () => new Promise((resolve) => { release = resolve; }));
  const p2 = gate2("g:9", async () => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  check("并发时第二条先等着", waits2.length, 0);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  check("并发两条都发成功", `${r1.ok}/${r2.ok}`, "true/true");
  check("并发第二条补等 2 秒", waits2[0], 2000);

  let c3 = 3_000_000;
  const gate3 = createSendGate({ minGapMs: 0, hourlyCap: 0, now: () => c3, sleep: async (ms) => { c3 += ms; } });
  let threw = false;
  try { await gate3("g:3", async () => { throw new Error("ws down"); }); } catch { threw = true; }
  check("发送失败向上抛", threw, true);
  const r3 = await gate3("g:3", async () => "ok");
  check("失败后同群还能继续发", r3.value, "ok");

  // capped 查询：接收侧跳过的依据（打满为真、未打满/别的会话/不限额为假）
  let c4 = 4_000_000;
  const gate4 = createSendGate({ minGapMs: 0, hourlyCap: 2, now: () => c4, sleep: async (ms) => { c4 += ms; } });
  check("capped 初始为假", gate4.capped("g:5"), false);
  await gate4("g:5", async () => "x");
  check("capped 未满为假", gate4.capped("g:5"), false);
  await gate4("g:5", async () => "x");
  check("capped 打满为真", gate4.capped("g:5"), true);
  check("capped 按会话隔离", gate4.capped("g:6"), false);
  c4 += 3_600_000;
  check("capped 滑过 1 小时为假", gate4.capped("g:5"), false);
}

// 审核 F-13：清掉落在真实 media-cache 里的测试图，不在生产目录留垃圾
try { rmSync(sample, { force: true }); } catch {}
// 本次改动会写 g:111 的 turns/recent/draw-jobs，测试结束一并清掉
try { rmSync(groupDir("g:111"), { recursive: true, force: true }); } catch {}

console.log("\n— 禁言感知（2026-10-30 省额度） —");
const banEv = (sub, uid, dur) => ({ time: Math.floor(Date.now() / 1000), self_id: Number(SELF), post_type: "notice", notice_type: "group_ban", sub_type: sub, group_id: 111, user_id: uid, duration: dur });
check("他人被禁言不影响本号", groupBanNotice(banEv("ban", 999, 600), Number(SELF)), "null");
check("本号被禁言事件被识别", typeof groupBanNotice(banEv("ban", Number(SELF), 600), Number(SELF)), "string");
check("全员禁言同样触发", groupBanNotice(banEv("ban", 0, 600), Number(SELF)) !== null, true);
let muteCalls = 0;
const muteCtx = { getSelfId: () => SELF, askBrain: async (r) => { muteCalls++; return stub(r); } };
check("禁言期间消息不调模型", await onEvent(groupEv([{ type: "text", text: "禁言期有人说话" }]), muteCtx), "null");
check("禁言期零模型调用", muteCalls, 0);
groupBanNotice(banEv("lift_ban", Number(SELF), 0), Number(SELF));
check("解禁后恢复处理", (await onEvent(groupEv([{ type: "text", text: "解禁了说句话" }]), muteCtx)) ? "ok" : "null", "ok");
check("解禁后模型恢复调用", muteCalls, 1);
groupBanNotice(banEv("ban", Number(SELF), 1), Number(SELF));
check("短禁言立即生效", isGroupMuted(111), true);
groupBanNotice(banEv("ban", Number(SELF), 3600), Number(SELF));
check("重复禁言覆盖刷新", isGroupMuted(111), true);
check("非 group_ban notice 不误伤", groupBanNotice({ notice_type: "group_increase", group_id: 111, user_id: Number(SELF) }, Number(SELF)), "null");

console.log("\n— 禁言持久化 + 1200 自愈（重启不裸跑） —");
const err1200 = () => new Error(`qf_1 失败 retcode=1200 "EventChecker Failed: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg"`);
{
  const muteDir = join(tmpdir(), `xq-mute-test-${process.pid}-${Date.now()}`);
  // 落盘 → 清空内存（模拟重启）→ 恢复
  _resetMutes();
  groupBanNotice(banEv("ban", Number(SELF), 3600), Number(SELF));
  persistMutes(muteDir);
  check("禁言状态已落盘", existsSync(join(muteDir, "mute-state.json")), true);
  _resetMutes();
  check("清空后不再禁言", isGroupMuted(111), false);
  loadMutes(muteDir);
  check("重启后禁言状态恢复", isGroupMuted(111), true);
  check("恢复的残余禁言封顶 10 分钟", muteRemaining(111) > 0 && muteRemaining(111) <= 630_000, true);
  // 解除：清内存也清落盘，重启不会带着旧禁言
  groupBanNotice(banEv("lift_ban", Number(SELF), 0), Number(SELF));
  check("解除后不再禁言", isGroupMuted(111), false);
  persistMutes(muteDir);
  _resetMutes();
  loadMutes(muteDir);
  check("解除后落盘为空", isGroupMuted(111), false);
  rmSync(muteDir, { recursive: true, force: true });
}
// 停机期错过禁言 notice：靠发送侧连续 1200 自愈
_resetMutes();
check("单次 1200 不自愈", noteSendFailure({ group_id: 111 }, err1200()) ?? "null", "null");
check("单次 1200 后照常处理", isGroupMuted(111), false);
check("连续第二次 1200 触发自愈", typeof noteSendFailure({ group_id: 111 }, err1200()), "string");
check("自愈后本群静默", isGroupMuted(111), true);
check("自愈静默约 10 分钟", muteRemaining(111) > 0 && muteRemaining(111) <= 630_000, true);
noteSendSuccess({ group_id: 111 });
check("发送成功清零失败连击", muteRemaining(111) > 0, true); // 静默本身不被成功清掉
groupBanNotice(banEv("lift_ban", Number(SELF), 0), Number(SELF));
check("自愈静默可被解除 notice 清掉", isGroupMuted(111), false);
// 非 1200（风控/偶发）不该让整群沉默
_resetMutes();
noteSendFailure({ group_id: 111 }, new Error(`x 失败 retcode=500 "boom"`));
noteSendFailure({ group_id: 111 }, new Error(`x 失败 retcode=500 "boom"`));
check("非 1200 连续失败不自愈", isGroupMuted(111), false);
check("私聊发送失败不触发群自愈", noteSendFailure({ user_id: 333 }, err1200()) ?? "null", "null");
// ban/lift notice 都要清发送失败连击：解禁后旧连击不该让下一次偶发失败直接触发自愈
_resetMutes();
noteSendFailure({ group_id: 111 }, err1200());
groupBanNotice(banEv("lift_ban", Number(SELF), 0), Number(SELF));
check("解除 notice 清连击：单次 1200 不自愈", noteSendFailure({ group_id: 111 }, err1200()) ?? "null", "null");
check("清连击后未静默", isGroupMuted(111), false);
groupBanNotice(banEv("ban", Number(SELF), 3600), Number(SELF));
noteSendFailure({ group_id: 111 }, err1200());
noteSendFailure({ group_id: 111 }, err1200());
check("已禁言时 1200 不重设静默时长", muteRemaining(111) > 3000_000, true);
// 重连视同重启：内存残余禁言封顶 10 分钟
groupBanNotice(banEv("ban", Number(SELF), 3600), Number(SELF));
capMutesForReconnect();
check("重连封顶残余禁言", muteRemaining(111) > 0 && muteRemaining(111) <= 630_000, true);

console.log("\n— 发送额度打满：接收侧只留档不进模型（2026-10-30） —");
_resetMutes();   // 清掉禁言用例留下的状态，别污染额度判定
{
  let capAsk = 0;
  const capCtx = (capped, key = "g:111") => ({
    getSelfId: () => SELF,
    askBrain: async (r) => { capAsk++; return stub(r); },
    isSendCapped: (k) => capped && k === key,
  });
  check("额度打满不回话", await onEvent(groupEv([{ type: "text", text: "满了还说吗" }]), capCtx(true)), "null");
  check("打满时零模型调用", capAsk, 0);
  check("未打满照常回话", (await onEvent(groupEv([{ type: "text", text: "还有额度呢" }]), capCtx(false))) ? "ok" : "null", "ok");
  check("额度按会话隔离：别的群不受影响", (await onEvent(groupEv([{ type: "text", text: "别的群没事" }]), capCtx(true, "g:999"))) ? "ok" : "null", "ok");
}
// groupBanNotice 默认落盘到真实 groupsDir，收尾清空避免测试残留
_resetMutes();
persistMutes();

console.log("\n— 服务端权威禁言同步（get_group_member_info.shut_up_timestamp） —");
{
  const future = Math.floor(Date.now() / 1000) + 3600;
  const fakeApi = (resp) => ({ call: async (action, params) => {
    if (action !== "get_group_member_info") throw new Error("不该调别的 API");
    return resp(params.group_id);
  } });
  _resetMutes();
  const n1 = await syncMutesFromServer(fakeApi((g) => ({ group_id: g, shut_up_timestamp: future })), SELF, [111, 222]);
  check("服务端说在禁言 → 标记生效", isGroupMuted(111) && isGroupMuted(222), true);
  check("返回仍在禁言的群数", n1, 2);
  check("按真实到期时间而非封顶值", muteRemaining(111) > 3_500_000, true);
  const n2 = await syncMutesFromServer(fakeApi((g) => ({ group_id: g, shut_up_timestamp: 0 })), SELF, [111]);
  check("服务端说没禁言 → 清掉陈旧标记", isGroupMuted(111), false);
  check("确认没禁言的群数", n2, 0);
  // 查询失败不能把内存里的禁言误清（网络抖动 ≠ 已解禁）
  groupBanNotice(banEv("ban", Number(SELF), 3600), Number(SELF));
  const flaky = await syncMutesFromServer({ call: async () => { throw new Error("超时"); } }, SELF, [111]);
  check("查询失败时不动已有禁言", isGroupMuted(111), true);
  check("查询失败不计入确认数", flaky, 0);
  check("selfId 缺失时安全跳过", await syncMutesFromServer(fakeApi(() => ({ shut_up_timestamp: 0 })), null, [111]), 0);
  _resetMutes();
  persistMutes();
}

console.log("\n— P0-3 聚合语义（编号指向与独占防护） —");
const mrec = (over = {}) => ({ id: 0, ts: Math.floor(new Date(2026, 9, 30, 15, 0).getTime() / 1000), uid: "100555", name: "土豆", to: [], replyTo: null, text: "", atMe: false, mine: false, ...over });
// A 连发两条（聚合为一组，显示 #尾条位次），B 回复 A 的第一条——回复#N 应指向可见行
const aggBlock = renderRecent([
  mrec({ id: 30, text: "A 的第一条" }),
  mrec({ id: 31, ts: Math.floor(new Date(2026, 9, 30, 15, 0, 30).getTime() / 1000), text: "A 的第二条" }),
  mrec({ id: 32, ts: Math.floor(new Date(2026, 9, 30, 15, 1).getTime() / 1000), uid: "100777", name: "阿哲", replyTo: { id: 30 }, text: "回复 A 的第一条" }),
], { selfId: SELF });
check("A 连发两条聚合为一行", aggBlock.lines[0].includes("A 的第一条 ／ A 的第二条"), true);
check("回复指向组内首条时映射到组显示编号", aggBlock.lines[1].includes(`回复#${aggBlock.lines[0].slice(1, aggBlock.lines[0].indexOf(" "))}`), true);
// 极端连发：一人 20 条不独占 L4（组上限 5 条 → 单行 ≤ maxLine×5）
const spam = Array.from({ length: 20 }, (_, i) => mrec({ id: 50 + i, ts: Math.floor(new Date(2026, 9, 30, 16, 0).getTime() / 1000) + i, text: `刷屏第${i + 1}号，这句写长一点凑足单行上限好验证独占防护是否生效。` }));
const spamBlock = renderRecent(spam, { selfId: SELF, feedN: 20 });
check("极端连发单行不超 maxLine×5", Math.max(...spamBlock.lines.map((l) => [...l].length)) <= 80 * 5 + 1, true);
check("极端连发被拆成多组", spamBlock.lines.length, 4);

console.log(fail === 0 ? "\n路由与字段全部通过（真实 OneBot v11 事件形状）" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
