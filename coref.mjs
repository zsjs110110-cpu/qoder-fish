// 群聊指代 P0/P1（2026-11-04）：P0 用实体表 + 显式/近邻线索解析“你/您”；
// P1 把他/她/它归一成第三人称人/物（字符不参与硬过滤，输入法噪声不建模），按句读分别绑定；
// 只在渲染层加括号标注，不改原文、不调模型、不影响任何权限/发送判定。
// 纯函数、无 IO；由 recent.mjs 在 renderRecent 时调用。
import { safeName } from "./prompt-layers/layers.mjs";

const ALL_TARGET = /^(all|1010)$/i;
const YOU_RE = /(?:您|你(?!们))/g;
const ADJACENT_MS = 60_000;
const MAX_CANDIDATES = 3;

// P1：他/她/它 在中文聊天里常被输入法随手写错，只按“第三人称人/物”归一化，
// 字符本身不参与硬过滤；真正的线索是名字邻近、最近提及、同线、上一句主语。
const PERSON_RE = /(?<!其)(?<!吉)他(?!们|人|乡|日)|(?<!其)她(?!们)/;
const THING_RE = /(?<!其)它(?!们)/;
const PERSON_PL_RE = /(?<!其)(?:他们|她们)/;
const PRONOUN_RE = /(?<!其)(?:他们|她们|它们)|(?<!其)(?<!吉)他(?!们|人|乡|日)|(?<!其)她(?!们)|(?<!其)它(?!们)/g;
// “你我他”“他她它”这类并列是在讨论代词本身，不是指代某个人；整句跳过第三人称
const PRONOUN_RUN_RE = /[你您我他她它]{2,}/;
// “它说/它觉得/它笑”这类强人物动词才给人物候选；排除“它看起来”这种明显指物的搭配
const PERSON_CUE_RE = /说|想|觉得|认为|笑|问|答|喜欢|讨厌|生气|开心|难过|睡|吃|喝|玩|忙|累|哭|骂|夸/;

const isAll = (u) => ALL_TARGET.test(String(u ?? ""));
const uidOf = (v) => (v == null ? "" : String(v));
const hasYou = (text) => /(?:您|你(?!们))/.test(String(text ?? ""));

// 实体表：说话者 + 被 @/被回复的人 + 机器人。名字索引只收 >=2 个字，
// 单字昵称在正文里命中率太高，会到处误绑；机器人额外登记称呼别名。
export function buildEntityTable(recs, { selfId = null, selfName = "我", botAliases = [] } = {}) {
  const byUid = new Map();
  const put = (uid, name) => {
    const u = uidOf(uid);
    if (!u || isAll(u)) return;
    const cur = byUid.get(u) ?? { uid: u, name: "" };
    if (name && !cur.name) cur.name = String(name);
    byUid.set(u, cur);
  };
  for (const r of (Array.isArray(recs) ? recs : [])) {
    put(r?.uid, r?.name);
    for (const u of Array.isArray(r?.to) ? r.to : []) put(u, null);
    if (r?.replyTo?.uid) put(r.replyTo.uid, null);
  }
  if (selfId) put(selfId, selfName);
  const names = [];
  const seen = new Set();
  const pushName = (uid, name) => {
    const u = uidOf(uid);
    const n = String(name ?? "");
    const key = `${u}\u0000${n}`;
    if (!u || [...n].length < 2 || seen.has(key)) return;
    seen.add(key);
    names.push({ uid: u, name: n, len: [...n].length });
  };
  for (const e of byUid.values()) pushName(e.uid, e.name);
  if (selfId) for (const a of [selfName, ...(Array.isArray(botAliases) ? botAliases : [])]) pushName(selfId, a);
  names.sort((a, b) => b.len - a.len);
  return { byUid, names };
}

export function displayNameOf(uid, { table, selfId = null, selfName = "我" } = {}) {
  const u = uidOf(uid);
  if (selfId != null && u === String(selfId)) return safeName(selfName || "我") || "我";
  const raw = table?.byUid?.get(u)?.name;
  if (!raw) return u;
  return safeName(raw) || u;
}

// 称呼：句首或标点/空白后的名字，后面紧跟逗号/冒号，或空白后接“你/您”，才算在叫这个人。
// “今天阿哲说你……”不算；P0 刻意保守，宁可漏判也不乱绑。
export function findVocative(text, table, speakerUid = null) {
  const t = String(text ?? "");
  for (const { uid, name } of table?.names ?? []) {
    if (speakerUid != null && String(uid) === String(speakerUid)) continue;
    let from = 0;
    while (from <= t.length) {
      const idx = t.indexOf(name, from);
      if (idx < 0) break;
      const before = t.slice(0, idx);
      const after = t.slice(idx + name.length);
      const beforeOk = before.trim() === "" || /[，,。！？；;、\s]$/.test(before);
      const afterOk = /^\s*(?:[，,、:：]|[你您])/.test(after);
      if (beforeOk && afterOk) return uidOf(uid);
      from = idx + Math.max(1, name.length);
    }
  }
  return null;
}

// P1：按句读切块，让“阿强说他会来，小美说她不去”这种句子能分别绑定。
function splitClauses(text) {
  const t = String(text ?? "");
  if (!t) return [];
  return [...t.matchAll(/[^，,。！？；;、\n]+[，,。！？；;、\n]?/g)].map((m) => m[0]).filter(Boolean);
}

// 回复链并查集：同一串对话里的候选加权，跨线的人不抢指代。
function buildThreads(recs) {
  const n = recs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const byId = new Map();
  recs.forEach((r, i) => { if (r?.id != null) byId.set(String(r.id), i); });
  recs.forEach((r, i) => {
    if (r?.replyTo?.id == null) return;
    const j = byId.get(String(r.replyTo.id));
    if (j != null && j !== i) union(i, j);
  });
  return recs.map((_, i) => find(i));
}

// 正文里出现的已知成员名：长名优先，逐字推进，避免“阿哲哥”只命中“阿哲”。
function findMentions(text, table) {
  const t = String(text ?? "");
  const out = [];
  let i = 0;
  while (i < t.length) {
    let hit = null;
    for (const n of table?.names ?? []) {
      if (n.name && t.startsWith(n.name, i)) { hit = n; break; }
    }
    if (hit) {
      out.push({ uid: hit.uid, index: i });
      i += hit.name.length;
    } else {
      i++;
    }
  }
  return out;
}

// 第三人称候选打分：最近提及 + 同线 + 上一句发言人 + 名字邻近 + 上一条也提到；
// 不按“他/她/它”的字符做硬过滤，性别线索完全不参与（输入法噪声）。
function scoreCandidates(rec, addr, i, ctx, { clause, mentions, type, lastByType, usedUids, pronounIdx }) {
  const prevUid = i > 0 ? String(ctx.recs[i - 1]?.uid ?? "") : "";
  const prevMentions = ctx.prevMentions(i);
  const used = usedUids ?? new Set();
  const prevSame = lastByType?.get("person");
  const hasYouInClause = /(?:您|你(?!们))/.test(clause);
  const scores = [];
  for (const e of ctx.table.byUid.values()) {
    const uid = e.uid;
    if (uid === String(rec?.uid ?? "")) continue;
    let s = 0;
    // 只看 i 之前（含 i）的提及：不能让“下一句才发言的人”影响这一句的指代
    const last = Number(ctx.lastBefore(i).get(uid) ?? -1);
    const gap = last >= 0 ? Math.max(0, i - last) : 12;
    s += 0.45 * Math.max(0, 1 - gap / 8);
    if (last >= 0 && ctx.threadOf[last] === ctx.threadOf[i]) s += 0.2;
    if (uid === prevUid) s += 0.15;
    const mention = mentions.find((m) => m.uid === uid);
    if (mention) {
      s += 0.75;
      if (pronounIdx != null && Math.abs(mention.index - pronounIdx) <= 6) s += 0.15;
    }
    if (prevMentions.has(uid)) s += 0.2;
    // 只有强指向（@/回复/称呼/邻接）才把“被回复的人”降权；only-other 只是弱推断，不该影响第三人称。
    // 同句已经有“你”时，第三人称大概率不是听话人（“阿强你说他会来”），直接把听话人排除出候选。
    const strongAddr = ["at", "reply", "vocative", "adjacent"].includes(addr?.kind)
      && Array.isArray(addr?.uids) && addr.uids.includes(uid);
    if (strongAddr) {
      if (hasYouInClause && type === "person") continue;
      s -= 0.35;
    }
    if (prevSame?.uid === uid) s += 0.2;
    else if (used.has(uid)) s -= 0.1;
    if (type === "thing") {
      // 它 指人只软扣分；强人物动词在场时把扣分收窄，但仍不硬排除、不给实名
      s -= 0.3;
      if (PERSON_CUE_RE.test(clause)) s += 0.15;
    }
    scores.push({ uid, score: s });
  }
  scores.sort((a, b) => b.score - a.score);
  return scores;
}

function pickBinding(scores, { type, ctx }) {
  const top = scores[0];
  if (!top || top.score < 0.35) return null;
  const second = scores[1];
  const close = second && second.score >= 0.3 && top.score - second.score < 0.5;
  const confident = type === "person" && top.score >= 0.55 && (!second || top.score - second.score >= 0.3);
  const names = [top.uid, ...(close ? [second.uid] : [])].map((u) => ctx.displayName(u));
  return { uid: top.uid, conf: confident ? 0.8 : 0.25, label: confident ? names[0] : `?${names.join("/")}` };
}

// 他们/她们：优先用句子里明确点到的名字；不够两个就按分数补最近的人。
function resolvePlural(clause, rec, addr, i, ctx, mentions, pronounIdx) {
  const named = [];
  for (const m of mentions) {
    if (m.uid !== String(rec?.uid ?? "") && !named.includes(m.uid)) named.push(m.uid);
  }
  const uids = named.slice(0, 2);
  if (uids.length < 2) {
    const scores = scoreCandidates(rec, addr, i, ctx, { clause, mentions, type: "person", lastByType: new Map(), usedUids: new Set(), pronounIdx });
    for (const s of scores) {
      if (uids.length >= 2) break;
      if (s.score >= 0.3 && !uids.includes(s.uid)) uids.push(s.uid);
    }
  }
  if (!uids.length) return null;
  return { uid: uids[0], conf: 0.2, label: `?${uids.map((u) => ctx.displayName(u)).join("/")}` };
}

function clauseBindings(clause, rec, addr, i, ctx, lastByType, usedUids) {
  if (PRONOUN_RUN_RE.test(clause)) return null;
  const mentions = findMentions(clause, ctx.table);
  const personIdx = clause.search(PERSON_RE);
  const thingIdx = clause.search(THING_RE);
  const personPlIdx = clause.search(PERSON_PL_RE);
  if (personIdx < 0 && thingIdx < 0 && personPlIdx < 0) return null;
  const bindings = {};
  if (personIdx >= 0) {
    const scores = scoreCandidates(rec, addr, i, ctx, { clause, mentions, type: "person", lastByType, usedUids, pronounIdx: personIdx });
    const b = pickBinding(scores, { type: "person", ctx });
    if (b) bindings.person = b;
  }
  if (personPlIdx >= 0) {
    const b = resolvePlural(clause, rec, addr, i, ctx, mentions, personPlIdx);
    if (b) bindings.personPlural = b;
  }
  // 它：只有出现强人物动词时才给人物候选，并且永远只写 ?，不写实名
  if (thingIdx >= 0 && PERSON_CUE_RE.test(clause)) {
    const scores = scoreCandidates(rec, addr, i, ctx, { clause, mentions, type: "thing", lastByType, usedUids, pronounIdx: thingIdx });
    const b = pickBinding(scores, { type: "thing", ctx });
    if (b) bindings.thing = b;
  }
  return Object.keys(bindings).length ? bindings : null;
}

function annotateThirdPersonMessage(text, rec, addr, i, ctx) {
  const raw = String(text ?? "");
  const clauses = splitClauses(raw);
  if (!clauses.length) return raw;
  const max = Math.max(1, Number(ctx.maxPerMessage) || 2);
  const counts = { person: 0, thing: 0, personPlural: 0 };
  const lastByType = new Map();
  const usedUids = new Set();
  const out = [];
  for (const clause of clauses) {
    const bindings = clauseBindings(clause, rec, addr, i, ctx, lastByType, usedUids);
    if (!bindings) { out.push(clause); continue; }
    out.push(clause.replace(PRONOUN_RE, (m) => {
      let type;
      if (/^(?:他们|她们)/.test(m)) type = "personPlural";
      else if (/^它们/.test(m)) type = "thingPlural";
      else if (/^[他她]/.test(m)) type = "person";
      else type = "thing";
      const b = bindings[type];
      if (!b || (counts[type] != null && counts[type] >= max)) return m;
      counts[type] = (counts[type] ?? 0) + 1;
      return `${m}〔${b.label}〕`;
    }));
    if (bindings.person) {
      lastByType.set("person", { uid: bindings.person.uid, conf: bindings.person.conf });
      usedUids.add(bindings.person.uid);
    }
    if (bindings.personPlural) lastByType.set("personPlural", { uid: bindings.personPlural.uid, conf: bindings.personPlural.conf });
  }
  return out.join("");
}

// 逐条解析“这句在对谁说”。只认高精度线索：@ > 回复目标 > 句首称呼 > 邻接回话 > 窗口内唯一另一人。
export function resolveAddressees(recs, { table, selfId = null, selfName = "我" } = {}) {
  const list = Array.isArray(recs) ? recs : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] ?? {};
    const to = Array.isArray(r.to) ? r.to : [];
    const explicit = to.map(uidOf).filter((u) => u && !isAll(u));
    const hasAll = to.some(isAll);
    let addr = { uids: [], kind: "none", conf: 0 };
    if (explicit.length) {
      addr = { uids: explicit, kind: "at", conf: 1 };
    } else if (r.replyTo?.uid) {
      addr = { uids: [uidOf(r.replyTo.uid)], kind: "reply", conf: 0.95 };
    } else if (hasAll) {
      addr = { uids: [], kind: "all", conf: 0.4 };
    } else {
      const voc = findVocative(r.text, table, r.uid);
      if (voc) {
        addr = { uids: [voc], kind: "vocative", conf: 0.85 };
      } else {
        const prev = out[i - 1];
        const prevRec = list[i - 1];
        const dt = Number(r.ts) - Number(prevRec?.ts);
        if (
          prev?.uids?.length === 1 &&
          prevRec &&
          String(prevRec.uid ?? "") !== String(r.uid ?? "") &&
          String(prev.uids[0]) === String(r.uid ?? "") &&
          Number.isFinite(dt) && dt >= 0 && dt <= ADJACENT_MS
        ) {
          // 上一条 A→B，B 在 60 秒内接话：B 这句大概率是在回 A
          addr = { uids: [uidOf(prevRec.uid)], kind: "adjacent", conf: 0.7 };
        } else {
          const others = new Set();
          for (let j = Math.max(0, i - 6); j < i; j++) {
            const u = uidOf(list[j]?.uid);
            if (u && u !== String(r.uid ?? "")) others.add(u);
          }
          if (others.size === 1) addr = { uids: [...others], kind: "only-other", conf: 0.55 };
        }
      }
    }
    out.push(addr);
  }
  return out;
}

function candidatesFor(rec, i, { recs, resolved, selfId }) {
  const cands = [];
  const add = (uid, why) => {
    const u = uidOf(uid);
    if (!u || u === String(rec?.uid ?? "")) return;
    if (cands.some((c) => c.uid === u)) return;
    cands.push({ uid: u, why });
  };
  const prev = resolved[i - 1];
  // 只把“上一条的对象”带进来：至少要有 @/回复/称呼/邻接级别的证据；
  // only-other（窗口内只剩一个活人）太弱，不该污染下一条的候选。
  if (prev?.uids?.length === 1 && Number(prev.conf) >= 0.7) add(prev.uids[0], "上一条的对象");
  const prevRec = recs[i - 1];
  if (prevRec) add(prevRec.uid, "上一位发言人");
  if (selfId != null) add(selfId, "机器人");
  return cands.slice(0, MAX_CANDIDATES);
}

export function youBindingFor(rec, addr = { uids: [], kind: "none", conf: 0 }, i, ctx) {
  if (!rec || rec.mine || !hasYou(rec.text)) return null;
  // @全体 是“对大家说”，不在 P0 硬绑到某个人；行首的“全体”已经足够表达
  if (addr?.kind === "all") return null;
  const explicit = addr?.uids ?? [];
  if (explicit.length === 1) return { uids: [explicit[0]], kind: addr.kind, conf: addr.conf };
  if (explicit.length > 1) return { uids: explicit.slice(0, MAX_CANDIDATES), kind: "ambiguous", conf: 0.3 };
  const cands = candidatesFor(rec, i, ctx);
  if (cands.length === 1) {
    // 只剩默认的“机器人”候选、又没有上一位发言人时，标问号都不标，避免把普通“你”带偏
    if (cands[0].uid === String(ctx.selfId ?? "") && cands[0].why === "机器人") return null;
    const conf = cands[0].uid === String(ctx.selfId ?? "") ? 0.2 : 0.5;
    return { uids: [cands[0].uid], kind: conf >= 0.5 ? "weak" : "ambiguous", conf, candidates: cands };
  }
  if (cands.length > 1) return { uids: cands.map((c) => c.uid), kind: "ambiguous", conf: 0.2, candidates: cands };
  return null;
}

export function annotateYou(text, binding, { max = 2, table, selfId = null, selfName = "我" } = {}) {
  const raw = String(text ?? "");
  if (!binding?.uids?.length) return raw;
  const names = binding.uids.slice(0, MAX_CANDIDATES).map((u) => displayNameOf(u, { table, selfId, selfName }));
  // 只有 @/回复/称呼/邻接级别（>=0.65）才写实名；only-other、弱线索只给 ? 候选，避免自信地指错。
  const confident = binding.conf >= 0.65 && binding.uids.length === 1;
  const label = confident ? names[0] : `?${names.join("/")}`;
  let n = 0;
  return raw.replace(YOU_RE, (m) => (n++ < max ? `${m}〔${label}〕` : m));
}

// 一次扫描整段缓冲：所有记录共用同一张实体表和顺序解析结果。
// 返回 annotations: Map<recIndex, annotatedText>；renderRecent 只取最后几条用，避免 token 膨胀。
export function analyzeRecent(recs, { selfId = null, selfName = "我", botAliases = [], maxPerMessage = 2 } = {}) {
  const list = Array.isArray(recs) ? recs : [];
  const table = buildEntityTable(list, { selfId, selfName, botAliases });
  const resolved = resolveAddressees(list, { table, selfId, selfName });
  const threadOf = buildThreads(list);
  // 时间快照：解析第 i 条时，候选的“最近提及”只能取 i 之前的记录
  const lastBefore = [];
  {
    const last = new Map();
    for (let i = 0; i < list.length; i++) {
      lastBefore.push(new Map(last));
      const r = list[i] ?? {};
      const mark = (u) => { const x = uidOf(u); if (x && !isAll(x)) last.set(x, i); };
      mark(r.uid);
      for (const u of Array.isArray(r.to) ? r.to : []) mark(u);
      if (r.replyTo?.uid) mark(r.replyTo.uid);
    }
  }
  const prevCache = new Map();
  const ctx = {
    recs: list, resolved, selfId, selfName, table, threadOf, maxPerMessage,
    lastBefore: (i) => lastBefore[i] ?? new Map(),
    displayName: (uid) => displayNameOf(uid, { table, selfId, selfName }),
    prevMentions: (i) => {
      if (i <= 0) return new Set();
      if (prevCache.has(i)) return prevCache.get(i);
      const set = new Set(findMentions(list[i - 1]?.text, table).map((m) => m.uid));
      prevCache.set(i, set);
      return set;
    },
  };
  const annotations = new Map();
  list.forEach((r, i) => {
    if (!r || r.mine) return;
    const raw = String(r.text ?? "");
    if (!raw) return;
    const addr = resolved[i];
    let text = annotateThirdPersonMessage(raw, r, addr, i, ctx);
    if (hasYou(raw)) {
      const binding = youBindingFor(r, addr, i, ctx);
      if (binding) text = annotateYou(text, binding, { max: maxPerMessage, table, selfId, selfName });
    }
    if (text !== raw) annotations.set(i, text);
  });
  return { table, resolved, annotations };
}
