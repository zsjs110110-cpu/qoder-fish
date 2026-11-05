import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sanitize, isBroken, isEmptyResult, isSilence, splitMessages } from "./sanitize.mjs";
import { CFG } from "./config.mjs";

const SAN = { maxChars: CFG.replyMaxChars, maxSentences: CFG.replyMaxSentences, toolNames: CFG.tools };
const rows = readFileSync(fileURLToPath(new URL("./testdata/layers-regress.jsonl", import.meta.url)), "utf8")
  .trim().split("\n").map(JSON.parse);
const leaked = rows.filter((r) => r.leak);
let fail = 0;
const check = (name, got, want) => { const ok = String(got) === String(want); if (!ok) fail++; console.log(`${ok ? "ok  " : "FAIL"} ${name} → ${got}${ok ? "" : `（应为 ${want}）`}`); };

console.log(`— 真实泄漏样本（回归数据里 ${leaked.length} 条）—`);
for (const r of leaked) {
  const s = sanitize(r.reply, SAN);
  const bad = /[<>]/.test(s.text) || /tool_call|function=|parameter=/i.test(s.text) || s.outChars === 0 || s.outChars > 60;
  if (bad) fail++;
  console.log(`${bad ? "FAIL" : "ok  "} 入=${r.inChars ?? r.chars}字 出=${s.outChars}字 标记=${s.hadLeak} ｜ ${JSON.stringify(s.text.slice(0, 40))}`);
}

console.log("\n— 不许把正常文本啃坏 —");
const keep = [
  ["数学比较活着", "3<5 且 5>3，别急"],
  ["字母比较活着", "当 x<y 且 y<z 时，结论不一定"],
  ["单个尖括号活着", "a<b>c 这种写法你别学"],
  ["爱心符号活着", "给你比个心 <3"],
  ["credit 不许被当成 Edit 啃", "我的 credit 还剩点儿"],
  ["README 不许被当成 Read 啃", "你去看 README 里写了"],
  ["哈哈不被砍半", "哈哈哈哈哈哈哈哈哈哈哈哈"],
];
for (const [name, input] of keep) {
  const s = sanitize(input, SAN);
  check(name, !/那个内部工具/.test(s.text) && s.outChars > 0, true);
  if (/那个内部工具/.test(s.text)) console.log(`     被啃成：${JSON.stringify(s.text)}`);
}

console.log("\n— 内部名一律不许外发 —");
const leaks = [
  "我用 WebSearch 查了一下",
  "我 Read 了你的文件",
  "调 mcp__builtin__qoder_cron 定了个时",
  "PowerShell 里跑一下就好了",
  "TodoWrite 记了两条",
  "开了个子代理 SubAgent 去查",
  "我用 ImageGen 画了张图",
  "我用 ImageSearch 找的图",
];
for (const input of leaks) {
  const s = sanitize(input, SAN);
  const still = /WebSearch|WebFetch|Notebook|ImageGen|ImageSearch|VideoGen|TodoWrite|MultiEdit|PowerShell|Bash|Glob|Grep|SubAgent|TaskCreate|TaskUpdate|mcp__/i.test(s.text);
  check(`不外发：${input.slice(0, 18)}`, still, false);
}

console.log("\n— 记事本原文不回显（代码硬闸，不靠她自觉）—");
const frags = ["每周五晚九点是本群的放映时间", "群友土豆说群里每周三晚八点开黑"];
const s1 = sanitize("本子上写着：每周五晚九点是本群的放映时间，就是这么安排的。", { ...SAN, secretFragments: frags });
check("命中注入过的条目正文就抹掉", s1.text.includes("每周五晚九点是本群的放映时间"), false);
check("抹掉这件事有记录", s1.scrubbedNote, true);
const s2 = sanitize("周五晚上九点放映呀，是主人定的。", { ...SAN, secretFragments: frags });
check("她自己的话术不会被误抹", s2.text.includes("周五晚上九点"), true);

console.log("\n— markdown / 链接 / URL / 列表 —");
const md = [
  ["加粗被剥掉", "**今天**辛苦啦，早点睡。"],
  ["链接被剥掉", "详见 [新闻](https://example.com/a) 啦。"],
  ["裸 URL 被剥掉", "这条新闻在 https://qbitai.com/2026/xx 里"],
  ["裸域名被剥掉", "报道全文在 qbitai.com/2026/xx/article-index-html 里，你自己看"],
  ["列表符号被剥掉", "- 第一句。\n- 第二句。"],
  ["自我重复被截断", "我翻了一下没翻着，那页没肯让我看。我翻了一下没翻着，那页没肯让我看。"],
  ["超长压到 3 句 60 字", "今天最戳我的是 Anthropic 递交了 IPO 文件，准备上市啦。AI 圈又热闹起来了。你今天过得怎么样呀？我再补一句多余的废话给你。"],
];
for (const [name, input] of md) {
  const s = sanitize(input, SAN);
  check(name, !/[<>`*_]/.test(s.text) && !/https?:|qbitai/.test(s.text) && s.outChars <= 60, true);
}

console.log("\n— 半截话不往外发 —");
const long = "今天最戳我的是 Anthropic 递交了 IPO 文件准备上市啦。";
const s3 = sanitize(long, { maxChars: 20, maxSentences: 3 });
check("切不开也不留半串英文", /Anthropic$|IPO$|[A-Za-z]$/.test(s3.text), false);
check("硬切后仍有内容（不是整条丢掉）", s3.outChars > 0, true);
const s4 = sanitize("这是一句没有任何标点符号也没有空格已经连续超过二十个中文字符了所以会被硬切", { maxChars: 20, maxSentences: 3 });
check("无标点长句切到上限内", s4.outChars <= 20 && s4.outChars > 0, true);

console.log("\n— 坏输出判定要看提问语言（英文群不该一直吃兜底话）—");
check("中文问 + 英文回 = 坏", isBroken(sanitize("The answer is 42.", SAN), { inputText: "帮我查一下这个" }), true);
check("英文问 + 英文回 = 不算坏", isBroken(sanitize("The answer is forty-two.", SAN), { inputText: "what does the news say" }), false);
check("空输出 = 坏", isBroken(sanitize("   ", SAN), { inputText: "在吗" }), true);

console.log("\n— 长回复拆成几条短消息（单泡不许过长） —");
const sp = (t, opt) => splitMessages(t, { maxChars: 26, maxParts: 3, ...opt });
check("短句不拆", sp("在呀，怎么啦").length, 1);
check("空串不产出空气泡", sp("   ").length, 0);
const long3 = "今天最戳我的是 Anthropic 递交了 IPO 文件准备上市啦。AI 圈又热闹起来了。你今天过得怎么样呀？";
const p3 = sp(long3);
check("三句拆成三泡", p3.length, 3);
check("每泡都不超过 26 字", p3.every((x) => [...x].length <= 26), true);
check("内容没丢字", p3.join("").replace(/\s/g, "").length >= long3.replace(/\s/g, "").length - 2, true);
const p2 = sp("咸的呀，是卤汁泡进去的那种咸，不是表面撒盐，你要是想吃我陪你啃一个");
check("一句长话按逗号拆开", p2.length >= 2 && p2.every((x) => [...x].length <= 26), true);
const noPunct = "这是一句没有任何标点符号也没有逗号已经连续超过二十六个中文字符了所以必须被硬切开来看";
const pn = sp(noPunct);
check("无标点也能硬切不超长", pn.every((x) => [...x].length <= 26), true);
check("硬切不劈开半个英文词", sp("蛟龙号升级完最近连着在菲律宾海盆潜到七千米NapCat也顺便更新了版本你看这个英文单词", { maxChars: 20 }).every((x) => !/[A-Za-z]$/.test(x) || /^[A-Za-z]+$/.test(x)), true);
check("超过泡数上限就合并尾部", sp("一。二。三。四。五。六。", { maxChars: 3, maxParts: 3 }).length, 3);
check("尾部合并后内容仍在", sp("一。二。三。四。五。六。", { maxChars: 3, maxParts: 3 }).join("").includes("六"), true);

console.log("\n— 沉默暗号（不 @ 时她可以选择不接） —");
for (const t of ["跳过", "跳过。", "（跳过）", " 跳过 ", "跳过吧", "跳", "（跳）", "PASS", "pass", "skip", "SKIP", "不接", "不接了"]) check(`算沉默：${JSON.stringify(t)}`, isSilence(t), true);
for (const t of ["这条我帮你看看", "跳过这条的话…", "跳起来", "跳广场舞", "", "   ", "好呀，去看球"]) check(`不算沉默：${JSON.stringify(t)}`, isSilence(t), false);

console.log("\n— 空结果判定 —");
for (const [name, m] of [
  ["result 为空", { subtype: "success", result: "   " }],
  ["subtype 报错", { subtype: "error_max_turns", result: "算了" }],
  ["is_error", { subtype: "success", is_error: true, result: "算了" }],
  ["正常", { subtype: "success", result: "在呀" }],
]) console.log(`${name} => isEmptyResult=${isEmptyResult(m)}`);

console.log(fail === 0 ? "\n全部通过" : `\n失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
