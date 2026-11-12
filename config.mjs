import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadByokStore } from "./byok-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// 管理台写入的 byok-config.json 优先于环境变量；文件不存在时才用启动脚本里的 BYOK_*。
const BYOK_STORE = loadByokStore(HERE);
const hasByok = (k) => Object.prototype.hasOwnProperty.call(BYOK_STORE, k);
const byokStr = (k, env, fallback = "") => hasByok(k) ? String(BYOK_STORE[k] ?? "") : (process.env[env] ?? fallback);
const byokBool = (k, env, fallback) => hasByok(k) ? Boolean(BYOK_STORE[k]) : (process.env[env] === "1" ? true : process.env[env] === "0" ? false : fallback);
const byokNum = (k, env, fallback = 0) => hasByok(k) ? Number(BYOK_STORE[k]) || 0 : Number(process.env[env] || fallback) || 0;

export const CFG = {
  // 2026-11-11 服务端模型目录变动：QoDuck 已从 cn/global 两轨目录下线（实测 error_during_execution）。
  // 旧 QoDuck 对应的就是 Qwen3.8-Flash（内部 id qfmodel，cn 侧仍 free=true，price=0.1）；
  // qfmodel / Qwen3.8-Flash 两种写法 2026-11-11 实测都可用，medium + 200K 仍在合法表里。
  model: "Qwen3.8-Flash",
  // 2026-10-29 实验 xhigh/high 后回滚：high 延迟持平（中位 5.5s）但免费 Chat 日限额消耗约 3-4 倍，
  // 活跃日 10:56 即耗尽；medium 可撑全天。配合 sdk.mjs 的双轨 failover 使用。
  reasoningEffort: "medium",
  // 上下文档位：这台 SDK 实测合法值只有模型表里的 [200000,400000,1000000]，
  // 写错不报错、静默退回默认 200K —— 改完必须用 model-check.mjs 看 ratio 反推的窗口确认
  // 2026-11-07 实验：长上下文延迟明显，先降到 200K 观察；推理档仍是 medium
  contextWindow: Number(process.env.CONTEXT_WINDOW || 200_000),
  // 温度：平台模型侧没有任何口子（CLI 无 --temperature、SDK options 无该字段、config 只认 vpc_endpoint）
  // 有温度的只有 BYOK 自建 provider 和子代理定义，都不作用于走 Qoder 服务端的 Qwen3.8-Flash
  // 记忆 agent 复用会话工具面，所以必须带上写文件能力；auth.fileGuard 把读写死锁在「本群记事本目录」内
  // WP2：Grep/Glob 是她翻自己记事本用的（owner-only + 路径围栏），同样不对外宣称
  tools: ["WebSearch", "WebFetch", "ImageGen", "ImageSearch", "Read", "Write", "Edit", "Grep", "Glob"],
  // 人设 L3 能力层描述这些对外本事；读写文件是她内部的本事，不对群友宣称
  // ImageGen 在代码层只对 owner 开；ImageSearch 按二期计划 owner+member
  // 2026-11-03：SearchHistory 本群转录检索、定时任务三件套（进程内 MCP，名字两种形态都认）
  chatTools: ["WebSearch", "WebFetch", "ImageGen", "ImageSearch", "SearchHistory", "RecallMemory", "ScheduleTask", "ListScheduledTasks", "CancelScheduledTask"],
  layersDir: process.env.LAYERS_DIR || join(HERE, "prompt-layers"),
  character: "L2-character-xiaoqian.md",

  maxTurnsPerMessage: 4,
  // 单轮模型超时：2026-10-28 从 60s 试到 120s；可用 REQUEST_TIMEOUT_MS 覆盖
  requestTimeoutMs: Math.max(10_000, Number(process.env.REQUEST_TIMEOUT_MS || 120_000) || 120_000),
  // 2026-11-07 速度实验：超时不重试。QoDuck 中位 ~110s，120s 超时后再重试会把单轮拖到 240s+，
  // 还会占住同群串行通道；默认放弃本轮，保留 RETRY_ON_TIMEOUT=1 开关回滚旧行为。
  retryOnTimeout: process.env.RETRY_ON_TIMEOUT === "1",
  // 2026-11-07 速度：后台记忆 flush 给聊天让路；队列有等待/在跑时最多延后 60s，空闲再落盘
  memoryYield: process.env.MEMORY_YIELD !== "0",
  // 积压到这个等待数时，低优先级（非@/非回复）消息直接降载，不再排新 turn
  queueDownshiftAt: process.env.QUEUE_DOWNSHIFT_AT != null
    ? Math.max(0, Number(process.env.QUEUE_DOWNSHIFT_AT) || 0)
    : 3,
  // 2026-11-07 速度：L4 只注入上一轮以来的新群聊行；新会话首轮仍注满 recentFeedN
  l4Incremental: process.env.L4_INCREMENTAL !== "0",
  // 群聊连续短句合并窗口：只合并纯文本、非 @/非回复、非 owner/admin；0=关闭
  inboundMergeMs: Math.max(0, Number(process.env.INBOUND_MERGE_MS ?? 500) || 0),
  // 同群串行：同时只跑一个 turn。等待上限与“等太久就丢掉”的阈值（毫秒）
  // 2026-10-29 低延迟方案：2→5、40s→60s；从入队起算（F-05 已核实），仍保留过期丢弃
  chatQueueMax: Math.max(0, Number(process.env.QUEUE_MAX || 5) || 5),
  chatQueueStaleMs: Math.max(1000, Number(process.env.QUEUE_STALE_MS || 60_000) || 60_000),
  sessionIdleCloseMs: 30 * 60_000,
  maxLiveSessions: 12,
  // 跨重启的会话记忆：一群一个目录（SDK 的会话按 cwd 分家），聊够这么多轮就开新会话
  groupsDir: "groups",
  // 2026-11-08：180→120。200K 实测 100 轮已到 83% 上下文，180 轮走不到；120 轮留出余量
  rotateAfterTurns: Number(process.env.ROTATE_AFTER || 120),
  // 2026-11-08 额度：上下文占用到阈值也提前换会话（120 轮仍是硬上限）。
  // 每条消息都要重发整个会话，长上下文是日额度消耗的大头；0.45 约 60–80 轮触发，实测可省 25–35% token。
  contextRotateAt: (() => {
    const raw = process.env.CONTEXT_ROTATE_AT;
    if (raw == null || raw === "") return 0.45;   // 默认 45%；显式 0 关闭
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return 0.45;
    return n >= 1 ? 0.45 : n;
  })(),
  // 连续回答超时熔断：同群连续 N 次 120s 超时后暂停 M 分钟，期间消息直接丢弃，不再烧额度/堆队列
  timeoutBreakerEnabled: process.env.TIMEOUT_BREAKER !== "0",
  timeoutBreakerCount: Math.max(1, Number(process.env.TIMEOUT_BREAKER_COUNT || 2) || 2),
  timeoutBreakerPauseMs: Math.max(60_000, Number(process.env.TIMEOUT_BREAKER_PAUSE_MIN || 5) * 60_000 || 300_000),
  // 2026-11-08 额度：群里没点名她的消息先跑一次轻量“接不接”预判（独立小会话，不背历史），
  // 判“不接”就整轮跳过，避免每条闲聊都重发整段会话上下文。JUDGE_GATE=0 关闭。
  judgeGate: process.env.JUDGE_GATE !== "0",
  judgeTimeoutMs: Math.max(5_000, Number(process.env.JUDGE_TIMEOUT_MS || 25_000) || 25_000),
  // 服务端提示词缓存有效期（实测 4.3min 命中 / 6.8min 失效，取 5 分钟）：
  // 间隔超过它的第一条消息要重新建缓存，credits 约为热命中的 8–10 倍，用来给高消耗轮打标记
  cacheTtlMs: Math.max(60_000, Number(process.env.CACHE_TTL_MS || 5 * 60_000) || 300_000),
  // 轮换时后台摘要旧会话的本地转录，只写结构化记事条目；摘要永远不会把规矩标成已批准
  rotationSummary: process.env.ROTATION_SUMMARY !== "0",
  rotationSummaryMaxChars: Math.max(2000, Number(process.env.ROTATION_SUMMARY_MAX_CHARS || 12000) || 12000),
  rotationSummaryMaxChunks: Math.max(1, Number(process.env.ROTATION_SUMMARY_MAX_CHUNKS || 4) || 4),
  // 2026-11-03：60s→180s。切到 cn 轨后单轮常 20–50s，轮换摘要在活跃时段会撞 60s 超时（游标不推进）
  rotationSummaryTimeoutMs: Math.max(5000, Number(process.env.ROTATION_SUMMARY_TIMEOUT_MS || 180_000) || 180_000),
  coldConsolidateTimeoutMs: Math.max(5000, Number(process.env.COLD_CONSOLIDATE_TIMEOUT_MS || 60_000) || 60_000),
  // BYOK 第三轨：第三方 API Key 只从环境变量读，绝不打印/落日志。
  // 需要显式 BYOK_ENABLED=1；provider/model 用服务端 BYOK 目录里的 key（或自建 provider id）。
  byokEnabled: byokBool("enabled", "BYOK_ENABLED", false),
  byokProvider: String(byokStr("provider", "BYOK_PROVIDER")).trim(),
  byokModel: String(byokStr("model", "BYOK_MODEL")).trim(),
  byokApiKey: byokStr("apiKey", "BYOK_API_KEY"),
  byokBaseUrl: String(byokStr("baseUrl", "BYOK_BASE_URL")).trim(),
  byokStyle: String(byokStr("style", "BYOK_STYLE")).trim(),
  byokIsVl: byokBool("isVl", "BYOK_VL", false),
  byokReasoningEffort: String(byokStr("reasoningEffort", "BYOK_REASONING_EFFORT")).trim(),
  byokContextWindow: Math.max(0, byokNum("contextWindow", "BYOK_CONTEXT_WINDOW", 0)),
  byokBaseEdition: String(byokStr("baseEdition", "BYOK_BASE_EDITION", "global")).trim().toLowerCase(),
  byokFallback: byokBool("fallback", "BYOK_FALLBACK", true),
  // 群记事本（SDK custom memory roots）：每群一个目录，作用域全关，不跨群共享
  memoryEnabled: process.env.MEMORY !== "off",
  memoryDir: "memory",
  transcriptFile: "chat.jsonl",
  transcriptMaxLines: 400,
  // A10：交付事件（拟回复 vs 已发送）；只记状态，不记正文
  deliveryFile: "delivery.jsonl",
  deliveryMaxLines: 600,   // 要比 transcriptMaxLines(400) 长，避免旧交付状态先被压掉、对应回复变回 unknown
  // 每轮脱敏指标：回复/跳过/丢弃/兜底都写；不写正文
  turnsFile: "turns.jsonl",
  turnsMaxLines: 400,
  turnsLog: process.env.TURNS_LOG !== "0",
  // 成功/跳过路径的记忆收尾在回复后执行；下一轮开始前 drain
  flushAfterSend: process.env.FLUSH_AFTER_SEND !== "0",
  // 截图返回前不再同步 taskkill/删 profile
  screenshotAsyncCleanup: process.env.SCREENSHOT_ASYNC_CLEANUP !== "0",
  // ImageSearch 候选在工具结果返回时预取，藏在模型首段回复期间
  searchPrefetch: process.env.SEARCH_PREFETCH !== "0",
  // 按群 TTL 媒体缓存（截图/引用图/搜索候选）
  mediaCache: process.env.MEDIA_CACHE !== "0",
  mediaCacheTtlMs: Math.max(0, Number(process.env.MEDIA_CACHE_TTL_MS || 15 * 60_000) || 0),
  quoteCacheTtlMs: Math.max(0, Number(process.env.QUOTE_CACHE_TTL_MS || 60 * 60_000) || 0),
  searchCacheTtlMs: Math.max(0, Number(process.env.SEARCH_CACHE_TTL_MS || 10 * 60_000) || 0),
  mediaCacheMaxBytes: Math.max(0, Number(process.env.MEDIA_CACHE_MAX_BYTES || 200 * 1024 * 1024) || 0),
  // get_msg/get_forward_msg 的进程内 LRU（不落盘）
  quoteForwardCache: process.env.QUOTE_FORWARD_CACHE !== "0",
  quoteForwardCacheTtlMs: Math.max(0, Number(process.env.QUOTE_FORWARD_CACHE_TTL_MS || 30 * 60_000) || 0),
  quoteForwardCacheMax: Math.max(1, Number(process.env.QUOTE_FORWARD_CACHE_MAX || 100) || 100),
  // 画图任务落盘恢复；重启后只补未发的图
  drawJobPersist: process.env.DRAW_JOB_PERSIST !== "0",
  drawJobMaxKeep: Math.max(1, Number(process.env.DRAW_JOB_MAX_KEEP || 50) || 50),
  // 双层判定去重（F-01/F-02 新增 hook 后）；实测只有一层触发则不产生作用
  dualCheckCache: process.env.DUAL_CHECK_CACHE !== "0",

  replyMaxChars: 60,
  replyMaxSentences: 3,
  // 一条长回复拆成几条短消息发（群里一大气泡不像人）；两条之间的间隔留一点手打感
  splitMaxChars: Number(process.env.SPLIT_CHARS || 26),
  splitMaxParts: Number(process.env.SPLIT_PARTS || 3),
  splitGapMs: Number(process.env.SPLIT_GAP || 700),
  // 发送节奏硬约束：同一群/私聊两条之间至少 2 秒，滚动 1 小时最多 90 条（拆泡和图片都算条）。
  // 小号被风控的代价远大于慢两秒；超限只丢不重试，由 onebot 适配层统一排队。
  // 90 是 2026-10-30 实验值：60 在热闹群一小时就打满（12:32/18:28 两轮），点名的回复也被丢。
  sendMinGapMs: Math.max(0, Number(process.env.SEND_MIN_GAP_MS ?? 2000) || 0),
  sendHourlyCap: Math.max(0, Number(process.env.SEND_HOURLY_CAP ?? 90) || 0),
  imageMaxBytes: 4 * 1024 * 1024,
  // 一条消息最多带几张图、总共多少字节：不限数量时几十张图能把上下文顶爆
  maxImagesPerMessage: Number(process.env.MAX_IMAGES || 4),
  imageTotalBytes: 8 * 1024 * 1024,
  imageMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  // 生图只给 owner：预算软限，进程重启会清零；真实硬门是 auth 的 owner-only
  imageGenPerUserPerDay: Math.max(0, Number(process.env.IMAGE_GEN_PER_USER_DAY || 3) || 3),
  imageGenPerChatPerDay: Math.max(0, Number(process.env.IMAGE_GEN_PER_CHAT_DAY || 20) || 20),
  imageGenMaxPerTurn: Math.max(1, Number(process.env.IMAGE_GEN_MAX_PER_TURN || 1) || 1),
  // 生成图先复制到无空格目录再发：CQ 码的 file= 对含空格的本地路径不稳
  imageOutDir: process.env.IMAGE_OUT_DIR || "D:/napcat/media",

  // 能力授权：只有 owner 拿到全部工具，其余人只给聊天用得上的那一样
  owners: (process.env.OWNER_QQ || "").split(",").map((s) => s.trim()).filter(Boolean),
  admins: (process.env.ADMIN_QQ || "").split(",").map((s) => s.trim()).filter(Boolean),
  blockedUsers: (process.env.BLOCK_QQ || "").split(",").map((s) => s.trim()).filter(Boolean),
  memberGroups: [],
  // 安全默认：空群名单不等于全群放行。index.mjs 会在显式 ALLOW_ALL=1 时把它打开；
  // 其它入口（doctor/REPL/测试）没显式打开就按拒绝处理（A09）。
  allowAllGroups: false,
  // 两条 Qoder 轨免费额度都标记用完后：默认静默等零点重置，不继续消耗积分。
  // 应急保活可设 ALLOW_CREDITS=1，允许继续用当前轨（会开始烧积分）。
  allowCredits: process.env.ALLOW_CREDITS === "1",
  toolPolicy: {
    owner: "*",
    // 抓取也留给群友：她要能读别人甩来的链接。风险由 auth.urlAllowed 拦（私网/本机/非 http(s) 一律拒）
    // SearchHistory 给群友：检索的是本群自己的转录，群里本来就看得见。
    // 定时任务全员可挂：真实隔离是"每会话目录闭包"，配额在 handler 里按创建者+当天跨会话合计
    // （非主人每人每天 1 个，主人不限）。角色闸门只是第二道。
    admin: ["WebSearch", "WebFetch", "ImageSearch", "SearchHistory", "RecallMemory", "ScheduleTask", "ListScheduledTasks", "CancelScheduledTask", "mcp__xqhistory__SearchHistory", "mcp__xqhistory__RecallMemory"],
    member: ["WebSearch", "WebFetch", "ImageSearch", "SearchHistory", "RecallMemory", "ScheduleTask", "ListScheduledTasks", "CancelScheduledTask", "mcp__xqhistory__SearchHistory", "mcp__xqhistory__RecallMemory"],
    guest: [],
    blocked: [],
  },
  // WebFetch 的 host 白名单，空=不限站，但私网/本机/非 http(s) 永远拦（auth.mjs 里硬编码）
  fetchHosts: (process.env.FETCH_HOSTS || "").split(",").map((s) => s.trim()).filter(Boolean),
  perUserPerMinute: Number(process.env.RATE_PER_MIN || 15),
  perUserDailyMessages: Number(process.env.RATE_PER_DAY || 500),
  // 注意：**没有配额闸门**。用的 Qwen3.8-Flash 是 priceFactor=0 的免费档，账号配额涨不涨与她能不能
  // 说话无关；管住刷屏和烧钱的是上面这两条条数限额。

  // 硬否决清单：这些工具即使出现在 schema 里也永远拒绝（纵深防御，不依赖 canUseTool 覆盖每个工具）
  hardDenied: ["Bash", "Agent", "Task", "Skill", "Monitor", "NotebookEdit",
    "VideoGen", "VideoGenRetrieve", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup",
    "EnterWorktree", "ExitWorktree", "CreateGoal", "UpdateGoal", "GetGoal", "TaskCreate", "TaskUpdate",
    "TaskGet", "TaskList", "TaskStop", "mcp__builtin__qoder_cron"],
  // WP1 能力C（群聊语境理解）已定参数 → 2026-10-30 语境扩容（P0）：缓冲 30→50、每轮喂 10→16 条。
  // 400k 窗口实测余量巨大，A/B 延迟无差异（4.0s vs 4.0s，见 语境理解增强调研-20261030.md）；免费档零额度成本。
  addressAliases: ["小千", "千姐"],
  recentBufferSize: 50,
  recentFeedN: 16,
  // 2026-11-04 指代 P0：结构解析“你”并加括号标注；COREF=0 可一键回滚。
  corefEnabled: process.env.COREF !== "0",
  corefMaxAnnotated: Math.max(0, Number(process.env.COREF_MAX_ANNOTATED || 3) || 3),
  corefMaxPerMessage: Math.max(1, Number(process.env.COREF_MAX_PER_MESSAGE || 2) || 2),
  // 转发消息递归展开上限：代码里每层会递增两次 depth，5 是当前保守值；有效层数以实测为准
  forwardDepth: Math.max(0, Number(process.env.FORWARD_DEPTH || 5) || 5),
  // 入站正文上限（2026-10-30）：单条消息正文喂模型前截断——转发/引用/卡片各有封顶，
  // 唯独正文原本不封，超长消息会拉大 prompt 拖延迟。超出部分她也接不住，一刀切即可。
  maxTextChars: Number(process.env.MAX_TEXT_CHARS || 4000),

  mediaCacheDir: "media-cache",
  // 生产安全默认：没有显式群白名单就拒绝起（ALLOW_ALL=1 才放开）；群里默认要 @
  requireWhitelist: process.env.ALLOW_ALL !== "1",

  rateLimitedLine: "哎哟，你一口气问太多啦，让我喘会儿再说。",
};
