// 群聊指代 P0（2026-11-04）离线验收：实体表、显式/近邻“你”解析、括号标注、未指名渲染。
// 全部离线，不连 SDK / 不调模型，纳入“全部 exit=0”门禁。
import { analyzeRecent, buildEntityTable, annotateYou } from "./coref.mjs";
import { renderRecent } from "./recent.mjs";

const SELF = "100001";
let fail = 0;
const ok = (name, got, want) => {
  const pass = String(got) === String(want);
  if (!pass) fail++;
  console.log(`${pass ? "ok  " : "FAIL"} ${name} → ${got}${pass ? "" : `（应为 ${want}）`}`);
};
const at = (h, m, s = 0) => Math.floor(new Date(2026, 10, 4, h, m, s).getTime() / 1000);
const rec = (over = {}) => ({ id: 0, ts: at(14, 2), uid: "100555", name: "土豆", to: [], replyTo: null, text: "", atMe: false, mine: false, ...over });

console.log("— 实体表：说话者 / @ / 回复 / 机器人别名 —");
const table = buildEntityTable([
  rec({ id: 1, uid: "100555", name: "土豆", text: "一" }),
  rec({ id: 2, uid: "100777", name: "阿哲", to: ["100888"], text: "二" }),
], { selfId: SELF, selfName: "小千", botAliases: ["千姐"] });
ok("说话者入表", table.byUid.get("100555")?.name, "土豆");
ok("@ 目标入表", table.byUid.has("100888"), true);
ok("机器人入表", table.byUid.get(SELF)?.name, "小千");
ok("单字名不进名字索引", table.names.some((n) => n.name === "一"), false);
ok("机器人别名可检索", table.names.some((n) => n.uid === SELF && n.name === "千姐"), true);

console.log("\n— “你”解析：显式线索 —");
let a = analyzeRecent([
  rec({ id: 1, uid: "100555", name: "土豆", text: "今晚开黑不" }),
  rec({ id: 2, uid: "100777", name: "阿哲", replyTo: { id: "1", uid: "100555" }, text: "你觉得呢" }),
], { selfId: SELF, selfName: "小千" });
ok("回复目标 → 你=土豆", a.annotations.get(1), "你〔土豆〕觉得呢");

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿哲", text: "一" }),
  rec({ id: 2, uid: "100555", name: "土豆", to: ["100777"], text: "你觉得呢" }),
], { selfId: SELF, selfName: "小千" });
ok("@ 目标 → 你=阿哲", a.annotations.get(1), "你〔阿哲〕觉得呢");

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿哲", text: "一" }),
  rec({ id: 2, uid: "100555", name: "土豆", text: "阿哲你觉得呢" }),
], { selfId: SELF, selfName: "小千" });
ok("句首称呼 → 你=阿哲", a.annotations.get(1), "阿哲你〔阿哲〕觉得呢");

a = analyzeRecent([
  rec({ id: 1, uid: "100555", name: "土豆", to: ["100777"], text: "阿哲你来" }),
  rec({ id: 2, uid: "100777", name: "阿哲", ts: at(14, 3), text: "你呢" }),
], { selfId: SELF, selfName: "小千" });
ok("邻接回话 → 你=上一位发言人", a.annotations.get(1), "你〔土豆〕呢");

a = analyzeRecent([rec({ id: 1, uid: "100555", name: "土豆", text: "千姐你觉得呢" })], { selfId: SELF, selfName: "小千", botAliases: ["千姐"] });
ok("称呼别名 → 你=小千", a.annotations.get(0), "千姐你〔小千〕觉得呢");

console.log("\n— 弱线索与克制：不硬绑 —");
a = analyzeRecent([
  rec({ id: 1, uid: "100555", name: "土豆", text: "一" }),
  rec({ id: 2, uid: "100777", name: "阿哲", text: "二" }),
  rec({ id: 3, uid: "100888", name: "老王", text: "你觉得呢" }),
], { selfId: SELF, selfName: "小千" });
ok("多人无结构线索 → 只给候选", a.annotations.get(2), "你〔?阿哲/小千〕觉得呢");

a = analyzeRecent([
  rec({ id: 1, uid: "100555", name: "土豆", text: "一" }),
  rec({ id: 2, uid: "100777", name: "阿哲", text: "二" }),
  rec({ id: 3, uid: "100888", name: "老王", text: "今天阿哲你觉得呢" }),
], { selfId: SELF, selfName: "小千" });
ok("名字在句中不算硬称呼", a.annotations.get(2).includes("〔?阿哲/小千〕"), true);

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿哲", text: "一" }),
  rec({ id: 2, uid: "100555", name: "土豆", text: "你觉得呢" }),
], { selfId: SELF, selfName: "小千" });
ok("窗口内唯一另一人也不硬绑", a.annotations.get(1), "你〔?阿哲〕觉得呢");

a = analyzeRecent([rec({ id: 1, uid: "100555", name: "土豆", to: ["all"], text: "你觉得呢" })], { selfId: SELF, selfName: "小千" });
ok("显式 @全体 不硬绑个人", a.annotations.has(0), false);

a = analyzeRecent([rec({ id: 1, uid: "100555", name: "土豆", text: "你们怎么看" })], { selfId: SELF, selfName: "小千" });
ok("复数“你们”不标", a.annotations.has(0), false);

a = analyzeRecent([rec({ id: 1, uid: SELF, name: "小千", mine: true, text: "你觉得呢" })], { selfId: SELF, selfName: "小千" });
ok("她自己的话不标", a.annotations.has(0), false);

console.log("\n— 标注形态与上限 —");
const b = annotateYou("你你你", { uids: ["100777"], conf: 0.9 }, { max: 2, table, selfId: SELF, selfName: "小千" });
ok("同一句最多标 max 处", b, "你〔阿哲〕你〔阿哲〕你");
a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿哲", text: "一" }),
  rec({ id: 2, uid: "100555", name: "土豆", to: ["100777"], text: "您觉得呢" }),
], { selfId: SELF, selfName: "小千" });
ok("“您”同样标注", a.annotations.get(1), "您〔阿哲〕觉得呢");

console.log("\n— renderRecent 集成 —");
const recs = [
  rec({ id: 1, uid: "100555", name: "土豆", text: "今晚开黑不" }),
  rec({ id: 2, uid: "100777", name: "阿哲", ts: at(14, 3), replyTo: { id: "1", uid: "100555" }, text: "你觉得呢" }),
];
let block = renderRecent(recs, { selfId: SELF, selfName: "小千", feedN: 10 });
ok("渲染行带指代标注", block.lines[1].includes("你〔土豆〕觉得呢"), true);
ok("没有显式对象的行标“未指名”", block.lines[0].includes("→ 未指名："), true);
ok("返回标注计数", block.coref?.annotated, 1);
ok("分类计数：你", block.coref?.you, 1);
ok("分类计数：他她它", block.coref?.third, 0);

block = renderRecent([
  rec({ id: 1, uid: "100555", name: "土豆", text: "一" }),
  rec({ id: 2, uid: "100777", name: "阿哲", text: "二" }),
  rec({ id: 3, uid: "100888", name: "老王", ts: at(14, 4), replyTo: { id: "2" }, text: "你觉得呢" }),
], { selfId: SELF, selfName: "小千", feedN: 10, replyUidOverride: { id: 3, uid: "100777" } });
ok("回查 uid 补进指代解析", block.lines[2].includes("你〔阿哲〕觉得呢"), true);

block = renderRecent([rec({ id: 3, uid: "100555", name: "土豆", to: ["all"], text: "集合" })], { selfId: SELF, selfName: "小千" });
ok("显式 @全体 仍写“全体”", block.lines[0].includes("→ 全体："), true);

block = renderRecent(recs, { selfId: SELF, selfName: "小千", feedN: 10, coref: false });
ok("COREF 关掉后不标注", block.lines[1].includes("〔土豆〕"), false);

block = renderRecent([
  rec({ id: 1, uid: "100555", name: "土豆", text: "今晚开黑不" }),
  rec({ id: 2, uid: "100777", name: "阿哲", ts: at(14, 3), replyTo: { id: "1", uid: "100555" }, text: "你觉得呢" }),
], { selfId: SELF, selfName: "小千", feedN: 10, corefMaxAnnotated: 1 });
ok("只标最后 corefMaxAnnotated 条", block.lines.length === 2 && block.lines[0].includes("〔土豆〕") === false && block.lines[1].includes("〔土豆〕"), true);

console.log("\n— P1：他/她/它 归一化 + 软生命度 —");
a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "小美", text: "二" }),
  rec({ id: 3, uid: "100888", name: "土豆", text: "阿强说他明天来" }),
], { selfId: SELF, selfName: "小千" });
ok("名字邻近 → 他=阿强", a.annotations.get(2), "阿强说他〔阿强〕明天来");

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "小美", text: "二" }),
  rec({ id: 3, uid: "100888", name: "土豆", text: "阿强说她明天来" }),
], { selfId: SELF, selfName: "小千" });
ok("她 指男生也不按性别排除", a.annotations.get(2), "阿强说她〔阿强〕明天来");

a = analyzeRecent([
  rec({ id: 1, uid: "100555", name: "小美", text: "一" }),
  rec({ id: 2, uid: "100777", name: "阿强", text: "二" }),
  rec({ id: 3, uid: "100888", name: "土豆", text: "小美说他会来" }),
], { selfId: SELF, selfName: "小千" });
ok("他 指女生也不按性别排除", a.annotations.get(2), "小美说他〔小美〕会来");

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "小美", text: "二" }),
  rec({ id: 3, uid: "100888", name: "土豆", text: "阿强说他会来，小美说她不去" }),
], { selfId: SELF, selfName: "小千" });
ok("逐句解析不同指代", a.annotations.get(2), "阿强说他〔阿强〕会来，小美说她〔小美〕不去");

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "土豆", text: "它说它明天来" }),
], { selfId: SELF, selfName: "小千" });
ok("它 + 人味动词 → 只给 ? 候选", a.annotations.get(1), "它〔?阿强〕说它〔?阿强〕明天来");

a = analyzeRecent([rec({ id: 1, uid: "100555", name: "土豆", text: "它好像卡了" })], { selfId: SELF, selfName: "小千" });
ok("它 无人物线索不标", a.annotations.has(0), false);

a = analyzeRecent([rec({ id: 1, uid: "100555", name: "土豆", text: "其他人都到了" })], { selfId: SELF, selfName: "小千" });
ok("其他 不被当成他", a.annotations.has(0), false);

a = analyzeRecent([rec({ id: 1, uid: "100555", name: "土豆", text: "我弹吉他" })], { selfId: SELF, selfName: "小千" });
ok("吉他 不被当成他", a.annotations.has(0), false);

a = analyzeRecent([rec({ id: 1, uid: "100555", name: "土豆", text: "其它都行" })], { selfId: SELF, selfName: "小千" });
ok("其它 不被当成它", a.annotations.has(0), false);

a = analyzeRecent([rec({ id: 1, uid: "100555", name: "土豆", text: "别在意他人的看法" })], { selfId: SELF, selfName: "小千" });
ok("他人 不被当成他", a.annotations.has(0), false);

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "小美", text: "二" }),
  rec({ id: 3, uid: "100888", name: "土豆", text: "他们俩明天来" }),
], { selfId: SELF, selfName: "小千" });
ok("他们 给集合候选", a.annotations.get(2), "他们〔?小美/阿强〕俩明天来");

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "小美", text: "二" }),
  rec({ id: 3, uid: "100888", name: "土豆", text: "她们俩明天来" }),
], { selfId: SELF, selfName: "小千" });
ok("她们 同样给集合候选", a.annotations.get(2), "她们〔?小美/阿强〕俩明天来");

a = analyzeRecent([
  rec({ id: 1, uid: "100555", name: "小美", text: "她会来吗" }),
  rec({ id: 2, uid: "100777", name: "阿强", text: "不知道" }),
], { selfId: SELF, selfName: "小千" });
ok("后发言的人不参与前一句指代", a.annotations.has(0), false);

a = analyzeRecent([
  rec({ id: 1, uid: "100001", name: "主人", text: "我决定给你解决一下这个分不清你我他的技术问题" }),
], { selfId: SELF, selfName: "小千" });
const runAnn = a.annotations.get(0) ?? "";
ok("你我他 并列不标第三人称", runAnn.includes("他〔"), false);

a = analyzeRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "小美", text: "二" }),
  rec({ id: 3, uid: "100888", name: "土豆", text: "阿强你说他会来" }),
], { selfId: SELF, selfName: "小千" });
const mixedAnn = a.annotations.get(2) ?? "";
ok("同句有“你”时第三人称不抢听话人", mixedAnn.includes("他〔阿强〕"), false);
ok("同句有“你”时第三人称给其他候选", mixedAnn.includes("他〔?小美〕"), true);

block = renderRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "小美", text: "二" }),
  rec({ id: 3, uid: "100888", name: "土豆", text: "阿强说他明天来" }),
], { selfId: SELF, selfName: "小千", feedN: 10 });
ok("分类计数：第三人称", block.coref?.third, 1);
ok("分类计数：第三人称实名", block.coref?.thirdAmbiguous, 0);

block = renderRecent([
  rec({ id: 1, uid: "100777", name: "阿强", text: "一" }),
  rec({ id: 2, uid: "100555", name: "土豆", text: "你觉得呢" }),
], { selfId: SELF, selfName: "小千", feedN: 10 });
ok("分类计数：你不确定", block.coref?.youAmbiguous, 1);

console.log(fail === 0 ? "\n群聊指代 P0/P1 全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
