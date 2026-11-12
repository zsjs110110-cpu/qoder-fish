// WP1-C1 群聊旁路缓冲：白名单群里每一条消息都追加进 groups/<群key>/recent.jsonl，
// **不管她回不回**（被限流的、她回「跳过」的、启动 10 秒窗口丢弃的都在内）。
// 环形保留 50 条（2026-10-30 语境扩容）；写盘失败静默计数，绝不影响回话主流程。
// 文件 IO 全在这里，onebot 适配层只管调（C-1 的实现建议）。
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isInstructionText } from "./memory.mjs";
import { safeName } from "./prompt-layers/layers.mjs";
import { appendJsonl } from "./jsonl.mjs";
import { analyzeRecent } from "./coref.mjs";

const RECENT_FILE = "recent.jsonl";
const stats = { writes: 0, fails: 0 };

export function recentFilePath(dir) { return join(dir, RECENT_FILE); }

// 追加一条并截头保留最近 max 条。任何异常都吞掉（缓冲是锦上添花，不能带垮回话）。
// WP9a：正常只 append；超过 2×max 才压缩一次，不再每条消息读全量重写。
export function appendRecent(dir, rec, { max = 30 } = {}) {
  try {
    mkdirSync(dir, { recursive: true });
    if (appendJsonl(recentFilePath(dir), rec, { max })) stats.writes++;
    else stats.fails++;
  } catch {
    stats.fails++; // 静默计数
  }
}

// 读最近 n 条（旧→新）。坏了/不存在返回空数组，读失败同样不许炸主流程。
export function readRecent(dir, n = 30) {
  try {
    const p = recentFilePath(dir);
    if (!existsSync(p)) return [];
    const out = [];
    for (const line of readFileSync(p, "utf8").split("\n").filter(Boolean).slice(-n)) {
      try { out.push(JSON.parse(line)); } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export function recentStats() { return { ...stats }; }

// WP1-C3 渲染：每条一行，必须能表达谁对谁说。mine 用 uid==selfId 判定（群里可能有人也叫小千/千姐）。
// 正文命中指令词表的行整行省略（不转发令原文），单行 >80 字截断，总块超 maxBlock（默认 2000）丢最旧的。
// 2026-10-30 语境扩容（P0-3）：相邻同 uid、同对象、间隔 ≤10 分钟的连续发言**聚合为一行**（body 用 ／ 分隔，
// 行上限按组内条数放大）——一人连发多条不再挤占语境名额，feedN 条名额承载更多有效轮次。
// 编号 #N 仍指向该组最后一条在缓冲里的位次（indexOfId 同源），回复#N 指向不受影响。
export function renderRecent(recs, { selfId = null, selfName = "我", feedN = 10, maxLine = 80, maxBlock = 2000, coref = true, corefMaxAnnotated = 3, corefMaxPerMessage = 2, botAliases = [], replyUidOverride = null } = {}) {
  if (!Array.isArray(recs) || !recs.length) return { lines: [], omitted: 0 };
  // 目标的显示名从缓冲历史里找：只有他之前说过话才认得，认不出就只写号码（不猜）
  const nameByUid = new Map();
  for (const r of recs) if (r?.uid != null && r?.name) nameByUid.set(String(r.uid), String(r.name));
  const indexOfId = new Map();
  recs.forEach((r, i) => { if (r?.id != null && !indexOfId.has(String(r.id))) indexOfId.set(String(r.id), i + 1); });

  // 组装：相邻同 uid、同对象（to/replyTo 三元组一致）、间隔 0~600s → 同组（审查修复：
  // 下界 dt>=0 防补推乱序旧消息被并进"连续发言"；组上限 5 条防单个刷屏者独占整个 L4）
  const groups = [];
  recs.forEach((r, i) => {
    const to = (Array.isArray(r.to) ? r.to : []).map(String);
    const replyToId = r.replyTo?.id != null ? String(r.replyTo.id) : "";
    const replyToUid = r.replyTo?.uid != null ? String(r.replyTo.uid) : "";
    const g = groups[groups.length - 1];
    const dt = Number(r.ts ?? 0) - (g?.lastTs ?? NaN);
    if (g && g.recs.length < 5 && g.uid === String(r.uid ?? "") && g.toKey === to.join(",") && g.replyToId === replyToId && g.replyToUid === replyToUid && Number.isFinite(dt) && dt >= 0 && dt <= 600) {
      g.recs.push(r);
      g.lastTs = Number(r.ts ?? 0);
      g.lastIdx = i + 1;
    } else {
      groups.push({ uid: String(r.uid ?? ""), toKey: to.join(","), replyToId, replyToUid, firstIdx: i + 1, firstRecIndex: i, lastTs: Number(r.ts ?? 0), lastIdx: i + 1, recs: [r], to });
    }
  });
  // 审查修复：组内所有成员位次都映射到该组显示编号——回复指向组内第一条时，
  // 渲染出的 回复#N 仍指向可见行（否则 #N 悬空，模型丢失引用目标）
  const shownByIdx = new Map();
  const groupOfPos = new Map();
  groups.forEach((g, gi) => {
    for (let p = g.firstIdx; p <= g.lastIdx; p++) { shownByIdx.set(p, g.lastIdx); groupOfPos.set(p, gi); }
  });

  // D（2026-11-03）话题线标注：只在**可见窗口**内按 replyTo 连边，连成 ≥2 行的话题串标 [线A]。
  // 纯渲染启发式：连错了最多多一个字母，不会改变任何判定；目的只是让她看见"这几句是一条线"。
  const feed = Math.min(feedN, groups.length);
  const firstVisible = groups.length - feed;
  // 2026-11-04 指代 P0：只给最后几条加“你〔名字〕”标注；老行保留原文，避免 token 膨胀。
  // replyUidOverride：NapCat 的 reply 段通常只有 id，uid 是 onEvent 里 get_msg 回查出来的；
  // 只在内存副本里补这一条，不改 recent.jsonl，也不影响行首 回复#N 的渲染。
  const corefRecs = replyUidOverride?.id != null && replyUidOverride?.uid != null
    ? recs.map((r) => (r?.id != null && String(r.id) === String(replyUidOverride.id)
        ? { ...r, replyTo: { ...(r.replyTo ?? {}), uid: String(replyUidOverride.uid) } }
        : r))
    : recs;
  const corefInfo = coref && corefMaxAnnotated > 0
    ? analyzeRecent(corefRecs, { selfId, selfName, botAliases, maxPerMessage: corefMaxPerMessage })
    : null;
  const annotateFrom = Math.max(firstVisible, groups.length - Math.max(0, corefMaxAnnotated));
  const corefStats = corefInfo ? { annotated: 0, ambiguous: 0, you: 0, youAmbiguous: 0, third: 0, thirdAmbiguous: 0 } : null;
  const parent = groups.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  groups.forEach((g, gi) => {
    if (gi < firstVisible || !g.replyToId) return;
    const pos = indexOfId.get(g.replyToId);
    const ti = pos != null ? groupOfPos.get(pos) : null;
    if (ti != null && ti >= firstVisible && ti !== gi) union(gi, ti);
  });
  const compSize = new Map();
  for (let i = firstVisible; i < groups.length; i++) { const r = find(i); compSize.set(r, (compSize.get(r) ?? 0) + 1); }
  const rootLetter = new Map();
  const lineTag = new Map();
  for (let i = firstVisible; i < groups.length; i++) {
    const r = find(i);
    if ((compSize.get(r) ?? 0) < 2) continue;
    if (!rootLetter.has(r)) rootLetter.set(r, String.fromCharCode(65 + rootLetter.size));   // A、B、C…
    lineTag.set(i, ` [线${rootLetter.get(r)}]`);
  }

  let omitted = 0;
  const render = (g, gi) => {
    const last = g.recs[g.recs.length - 1];
    const mine = selfId != null && g.uid === String(selfId);
    const hhmm = new Date((Number(last.ts) > 0 ? Number(last.ts) : 0) * 1000)
      .toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
    const who = mine ? `我（${safeName(selfName)}）` : `${safeName(last.name) || "?"}(${g.uid})`;
    let target;
    if (selfId != null && g.to.includes(String(selfId))) target = "@我";
    else if (g.to.length) {
      // ②（2026-11-03）@全体：OneBot v11 规定 qq="all"（部分实现用 1010），渲染说破而不是裸 "all"
      target = g.to.map((u) => {
        if (/^(all|1010)$/i.test(u)) return "全体";
        const n = nameByUid.get(u);
        return n ? `${safeName(n)}(${u})` : u;
      }).join("、");
    } else if (g.replyToId && indexOfId.has(g.replyToId)) {
      const pos = indexOfId.get(g.replyToId);
      target = `回复#${shownByIdx.get(pos) ?? pos}`;
    } else if (g.replyToUid && nameByUid.has(g.replyToUid)) {
      target = `回复${safeName(nameByUid.get(g.replyToUid))}`;
    } else if (g.replyToId || g.replyToUid) {
      // ③（2026-11-03）确有回复关系，只是目标出了 50 条窗口/认不出人——如实标 #?，
      // 不再谎称"全体"（"在回复某人"本身是"这句有指向"的语境信号）。
      // 审查 S2：文案压到 8 字——行预算只有 80 码点，长说明会把正文挤没
      target = "回复#?（出窗）";
    } else target = "未指名";
    const cap = Math.min(maxLine * g.recs.length, maxBlock);   // 合并行按条数放大，但不超总块上限
    const useCoref = corefInfo && gi >= annotateFrom;
    const body = g.recs.map((r, k) => {
      if (isInstructionText(r.text)) { omitted++; return "<疑似指令文本，已省略>"; }
      // 审核 F-10：正文里的 uid= 一并洗掉——条目 uid 只允许从【发言者】行（平台真值）照抄
      const annotated = useCoref ? corefInfo.annotations.get(g.firstRecIndex + k) : null;
      if (annotated && corefStats) {
        const count = (re) => (annotated.match(re) ?? []).length;
        const you = count(/(?:你|您)〔/g);
        const third = count(/(?:他们|她们|它们|他|她|它)〔/g);
        const youA = count(/(?:你|您)〔\?/g);
        const thirdA = count(/(?:他们|她们|它们|他|她|它)〔\?/g);
        corefStats.you += you;
        corefStats.third += third;
        corefStats.youAmbiguous += youA;
        corefStats.thirdAmbiguous += thirdA;
        corefStats.annotated += you + third;
        corefStats.ambiguous += youA + thirdA;
      }
      return String(annotated ?? r.text ?? "").replace(/uid\s*[=＝]\s*[\w-]*/gi, "uid=〔见发言者行〕").replace(/\s+/g, " ").trim();
    }).filter(Boolean).join(" ／ ");
    let line = `#${g.lastIdx}${lineTag.get(gi) ?? ""} ${hhmm} ${who} → ${target}：${body}`;
    if ([...line].length > cap) line = [...line].slice(0, cap).join("") + "…";
    return line;
  };
  const lines = groups.slice(firstVisible).map((g, i) => render(g, firstVisible + i));
  while (lines.length > 1 && [...lines.join("\n")].length > maxBlock) lines.shift(); // 丢最旧的
  // 审查 S7：丢行后某条线的可见成员可能只剩一个，抹掉孤线标记（否则模型看到一条"线"却找不到同伴）
  const tagCount = new Map();
  for (const l of lines) { const m = /\[线([A-Z]+)\]/.exec(l); if (m) tagCount.set(m[1], (tagCount.get(m[1]) ?? 0) + 1); }
  const kept = lines.map((l) => {
    const m = /\[线([A-Z]+)\]/.exec(l);
    return m && (tagCount.get(m[1]) ?? 0) < 2 ? l.replace(`[线${m[1]}] `, "") : l;
  });
  return { lines: kept, omitted, ...(corefStats ? { coref: corefStats } : {}) };
}
