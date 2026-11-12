// 外发净化。原则：只删「明显是机器标记」的东西，别把正常文本啃掉。
// 上一版为了防未渲染标签，把任何 `<字母` 都吃掉，结果 "当 x<y 且 y<z" 被啃成错误命题——
// 所以这里只处理**成对的、名字长度 ≥2 的标签**，孤立尖括号一律保留。
const TAG = /<\/?[A-Za-z_!?｜|=][A-Za-z0-9_!?｜|.=－]{1,58}(?:\s[^<>\n]{0,60})?>/g;
// function= / parameter= 这类带等号的机器标签，TAG 的名字字符集不覆盖 '='
const MACHINE = /<\/?(?:tool_call|tool_result|function|parameter|antml|im_start|im_end|DSML)\b[^<>]*>/gi;
const WORDS = /\b(?:tool_call|tool_result|function=|function\s|parameter=|im_start|im_end|DSML|antml)\b/gi;
const BOLD = /\*\*([^*\n]+)\*\*/g;
const CODE = /`{1,3}([^`\n]{0,200})`{1,3}/g;
const LINK = /\[([^\]]{0,80})\](?:\([^)\s]{0,200}\))?/g;
const URL = /(?:https?:\/\/|www\.)\S+/gi;
const BARE_DOMAIN = /\b[\w-]+\.(?:com|cn|net|org|io|xyz|top|me|cc|tv|co)\b(?:\/\S{0,40})?/gi;
const BULLET = /^[ \t]*(?:[-*•]|\d+[.、)])[ \t]+/gm;
const SENT = /[。！？!?…]/;
// 不依赖 CFG.tools 的兜底：这套构建里的内置名 + MCP 命名形状
const INTERNAL_PATTERNS = [
  /\bmcp__[\w-]+__[\w-]+\b/gi,
  /\b(?:WebSearch|WebFetch|NotebookEdit|ImageGen|ImageSearch|VideoGenRetrieve|TodoWrite|MultiEdit|PowerShell|Bash|Glob|Grep|SubAgent|Agent|TaskCreate|TaskUpdate)\b/g,
];
const REPLACED = "那个内部工具";

function dedupeEcho(text) {
  if (text.length < 24) return text;
  const half = Math.floor(text.length / 2);
  if (text.slice(0, half) === text.slice(half, half * 2)) return text.slice(0, half).trim();
  const probe = text.slice(0, Math.min(16, half));
  if (!SENT.test(probe)) return text;            // 探针里必须带句末标点，否则「哈哈哈」这种会被误砍
  const at = text.indexOf(probe, probe.length);
  return at === -1 ? text : text.slice(0, at).trim();
}

function clamp(text, maxChars, maxSentences) {
  const parts = text.split(/(?<=[。！？!?…])/).filter(Boolean);
  let out = parts.slice(0, maxSentences).join("");
  if (!out) out = text;
  if ([...out].length > maxChars) {
    const hard = [...out].slice(0, maxChars).join("");
    const cut = Math.max(...["。", "！", "？", "，", "、", "；"].map((p) => hard.lastIndexOf(p)));
    if (cut > 6) return hard.slice(0, cut + 1);
    // 找不到标点就硬切：先去掉末尾被切一半的英文/数字串（不发出半串 URL 或半个单词），再补省略号
    const clean = hard.slice(0, maxChars - 1).trim().replace(/[A-Za-z0-9_\-./]+$/, "").trim();
    return clean ? `${clean}…` : "";
  }
  return out;
}

// 2026-11-06 健壮性：模型偶尔用斜杠把几个短句串成一条（全角“／”最常见）。
// 中文语境里的斜杠按分句逗号处理；纯数字 3／4、纯英文 A／B、URL 路径保持原样。
// ASCII “/”只在中文字符之间处理，避免碰 3/4、and/or 这类写法。
export function normalizeClauseSeparators(raw) {
  return String(raw ?? "")
    // 连续斜杠（含全角/ASCII 混排）先折成一个；纯 ASCII 的 // 不动，免得碰 URL
    .replace(/(?:[／/]\s*){2,}/g, (m) => (/／/.test(m) ? "／" : m))
    .replace(/\s*／\s*/g, (m, off, s) => {
      const before = s.slice(0, off).trimEnd();
      const after = s.slice(off + m.length).trimStart();
      const prev = before.slice(-1);
      const next = after.slice(0, 1);
      if (!prev || !next) return "";                                  // 首尾孤立斜杠
      if (/[0-9]/.test(prev) && /[0-9]/.test(next)) return m;         // 3／4 不碰
      if (/[：:／/]/.test(prev) && /[A-Za-z0-9/]/.test(next)) return m; // C：／Users 这类路径
      if (/[：:／/]/.test(next) && /[A-Za-z0-9]/.test(prev)) return m;
      if (/[，。！？、；：]/.test(prev) || /[，。！？、；：]/.test(next)) return ""; // 已有标点，别叠
      return /[一-鿿]/.test(prev) || /[一-鿿]/.test(next) ? "，" : m;
    })
    .replace(/(?<=[一-鿿])\s*\/\s*(?=[一-鿿])/g, "，")
    .replace(/，{2,}/g, "，")
    .replace(/、{2,}/g, "、");
}

export function sanitize(raw, { maxChars = 60, maxSentences = 3, toolNames = [], secretFragments = [] } = {}) {
  const text = String(raw ?? "");
  const hadLeak = /tool_call|tool_result|function=|parameter=|im_end|im_start|DSML|[<>｜]{2}/i.test(text);
  let t = text
    .replace(MACHINE, " ")
    .replace(TAG, " ")
    .replace(WORDS, " ");
  // 整条确实是机器标记形状时，把残破尖括号也啃掉；平时保留孤立 <>，
  // 否则 "当 x<y 且 y<z" 会被啃成错误命题（上一版就是无条件啃）
  if (hadLeak) t = t.replace(/<\/?[A-Za-z_｜|\/=][^<>\n]{0,60}/g, " ").replace(/[<>]/g, " ");
  t = t
    .replace(BOLD, "$1")
    .replace(CODE, "$1")
    .replace(LINK, "$1")
    .replace(URL, " ")
    .replace(BARE_DOMAIN, " ")
    .replace(BULLET, "");
  t = normalizeClauseSeparators(t);
  // 工具名：带词边界（上一版没边界，"credit" 被当成 "Edit" 啃成 "cr那个内部工具"）
  for (const name of toolNames) {
    if (!name) continue;
    t = t.replace(new RegExp(`\\b${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), REPLACED);
  }
  for (const re of INTERNAL_PATTERNS) t = t.replace(re, REPLACED);
  // 记事本原文不回显：命中注入过的条目正文（≥10 字）就抹掉，不靠她自觉
  let scrubbedNote = false;
  for (const frag of secretFragments) {
    // 本子原文可能带“／”，t 已归一过；片段也要用同一规则归一，否则 includes 失配、原文照发。
    // 长度门槛按原文算：原文 11 字、归一后 9 字也要擦，不能因为归一后的长度跳过。
    const rawF = String(frag ?? "").trim();
    const f = normalizeClauseSeparators(rawF);
    if ([...rawF].length >= 10 && t.includes(f)) {
      t = t.replace(f, "").replace(/\s{2,}/g, " ");
      scrubbedNote = true;
    }
  }
  const cleaned = dedupeEcho(t.replace(/\s+/g, " ").trim());
  const out = clamp(cleaned, maxChars, maxSentences);
  return {
    text: out,
    hadLeak,
    hasCJK: /[一-鿿]/.test(out),
    inChars: [...text].length,
    outChars: [...out].length,
    truncated: [...out].length < [...cleaned].length,
    scrubbedNote,
  };
}

// 判"坏输出"要看对方用什么语言问的：英文群不该因为回了英文就一直吃兜底话
export function isBroken(sanitized, { inputText = "" } = {}) {
  if (!sanitized || sanitized.outChars === 0) return true;
  const inputHasCJK = /[一-鿿]/.test(String(inputText ?? ""));
  return inputHasCJK && !sanitized.hasCJK;
}

// 她"选择不接这句"的暗号：群里没人 @ 她时，L4 会告诉她不想接就只回这个词。
// 命中就整条不发，也不要走"坏输出重试"（重试会白烧一次模型）
export function isSilence(raw) {
  const t = String(raw ?? "").trim().replace(/[（）()【】\s。.!！~～]/g, "");
  // “跳”是 2026-10-30 实测过的退化形态：模型把“跳过”截成单字后，旧规则不认识，
  // 于是把“跳”当正常回复发进群，群友跟着刷“跳”时她会继续复读。单字“跳”不作为正文。
  return /^(pass|skip|跳过|跳过吧|跳|不接|不接了)$/i.test(t);
}

// 长回复拆成几条短消息发出去（群里一大气泡读起来不像人）。
// 先按句末切，长句再按逗号/顿号切，还不够才硬切——硬切时不劈开半个英文或数字串。
export function splitMessages(text, { maxChars = 26, maxParts = 3 } = {}) {
  const t = normalizeClauseSeparators(String(text ?? "").trim());
  if (!t) return [];
  if ([...t].length <= maxChars) return [t];
  const parts = [];
  let cur = "";
  const flush = () => { if (cur.trim()) parts.push(cur.trim()); cur = ""; };
  const hardSplit = (s) => {
    let rest = s;
    while ([...rest].length > maxChars) {
      let cut = maxChars;
      while (cut > 1 && cut < rest.length && /[A-Za-z0-9]/.test(rest[cut - 1]) && /[A-Za-z0-9]/.test(rest[cut])) cut--;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    return rest;
  };
  for (const sentence of t.split(/(?<=[。！？!?…])/).map((s) => s.trim()).filter(Boolean)) {
    if ([...sentence].length > maxChars) {
      flush();
      let buf = "";
      for (const piece of sentence.split(/(?<=[，,、；;：: ])/).map((x) => x.trim()).filter(Boolean)) {
        if (buf && [...buf + piece].length > maxChars) { parts.push(buf.trim()); buf = ""; }
        buf += [...piece].length > maxChars ? hardSplit(piece) : piece;
        if ([...buf].length > maxChars) { parts.push(...hardSplit(buf)); buf = ""; }
      }
      if (buf.trim()) parts.push(buf.trim());
      continue;
    }
    if (cur && [...cur + sentence].length > maxChars) { flush(); cur = sentence; } else cur += sentence;
  }
  flush();
  if (!parts.length) return [t];
  if (parts.length <= maxParts) return parts;
  const head = parts.slice(0, maxParts - 1);
  let tail = parts.slice(maxParts - 1).join("");
  // 审核修复 F-04：尾段合并后可能超过 maxChars（例：两个 30 字长句 → 26/4/26/4 → 尾泡 30 字）。
  // 若全部内容装得进 maxParts×maxChars，就整体重切一遍（硬切、不劈英文词），既保住条数上限又保住单泡上限；
  // 装不下（数学上无解，如 12 字 × maxChars=3 × maxParts=3）才退回合并尾段——条数上限优先于单泡上限。
  if ([...tail].length > maxChars && [...t].length <= maxChars * maxParts) {
    const resplit = [];
    let rest = t.trim();
    while ([...rest].length > maxChars) {
      let cut = maxChars;
      while (cut > 1 && cut < rest.length && /[A-Za-z0-9]/.test(rest[cut - 1]) && /[A-Za-z0-9]/.test(rest[cut])) cut--;
      resplit.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    if (rest.trim()) resplit.push(rest.trim());
    if (resplit.length && resplit.length <= maxParts && resplit.every((x) => [...x].length <= maxChars)) return resplit;
  }
  head.push(tail);
  return head;
}

export function isEmptyResult(msg) {
  if (!msg) return true;
  if (msg.is_error === true) return true;
  if (msg.subtype && msg.subtype !== "success") return true;
  return String(msg.result ?? "").trim().length === 0;
}
