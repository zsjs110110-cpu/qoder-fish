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
  model: "Qwen3.8-Flash",
  // 思考档：实测 high/xhigh 延迟持平但免费 Chat 日限额消耗约 3-4 倍，medium 可撑全天。
  // 配合 sdk.mjs 的双轨 failover 使用。
  reasoningEffort: "medium",
  // 上下文档位：合法值只有模型表里的 [200000,400000,1000000]，
  // 写错不报错、静默退回默认 200K —— 改完用 model-check.mjs 看反推的窗口确认
  contextWindow: Number(process.env.CONTEXT_WINDOW || 400_000),
  // 温度：平台模型侧没有任何口子（CLI 无 --temperature、SDK options 无该字段、config 只认 vpc_endpoint）
  // 有温度的只有 BYOK 自建 provider 和子代理定义，都不作用于走 Qoder 服务端的 Qwen3.8-Flash
  // 记忆 agent 复用会话工具面，所以必须带上写文件能力；auth.fileGuard 把读写死锁在「本群记事本目录」内
  // Grep/Glob 是她翻自己记事本用的（owner-only + 路径围栏），不对外宣称
  tools: ["WebSearch", "WebFetch", "ImageGen", "ImageSearch", "Read", "Write", "Edit", "Grep", "Glob"],
  // 人设 L3 能力层描述这些对外本事；读写文件是她内部的本事，不对群友宣称
  // ImageGen 在代码层只对 owner 开；ImageSearch 给 owner+member
  // SearchHistory 本群转录检索、定时任务三件套（进程内 MCP，名字两种形态都认）
  chatTools: ["WebSearch", "WebFetch", "ImageGen", "ImageSearch", "SearchHistory", "RecallMemory", "ScheduleTask", "ListScheduledTasks", "CancelScheduledTask"],
  // 提示词分层目录：默认用仓库内自带的参考示例（prompt-layers/）；
  // 要换成自己的人设层，设 LAYERS_DIR 指向包含 layers.mjs 与 L0/L1/L2 的目录
  layersDir: process.env.LAYERS_DIR || join(HERE, "prompt-layers"),
  character: "L2-character-xiaoqian.md",

  maxTurnsPerMessage: 4,
  // 单轮模型超时；可用 REQUEST_TIMEOUT_MS 覆盖
  requestTimeoutMs: Math.max(10_000, Number(process.env.REQUEST_TIMEOUT_MS || 120_000) || 120_000),
  // 同群串行：同时只跑一个 turn。等待上限与“等太久就丢掉”的阈值（毫秒），
  // 从入队起算，仍保留过期丢弃
  chatQueueMax: Math.max(0, Number(process.env.QUEUE_MAX || 5) || 5),
  chatQueueStaleMs: Math.max(1000, Number(process.env.QUEUE_STALE_MS || 60_000) || 60_000),
  sessionIdleCloseMs: 30 * 60_000,
  maxLiveSessions: 12,
  // 跨重启的会话记忆：一群一个目录（SDK 的会话按 cwd 分家），聊够这么多轮就开新会话
  groupsDir: "groups",
  rotateAfterTurns: Number(process.env.ROTATE_AFTER || 180),
  // 轮换时后台摘要旧会话的本地转录，只写结构化记事条目；摘要永远不会把规矩标成已批准
  rotationSummary: process.env.ROTATION_SUMMARY !== "0",
  rotationSummaryMaxChars: Math.max(2000, Number(process.env.ROTATION_SUMMARY_MAX_CHARS || 12000) || 12000),
  rotationSummaryMaxChunks: Math.max(1, Number(process.env.ROTATION_SUMMARY_MAX_CHUNKS || 4) || 4),
  // 摘要单段超时：cn 轨单轮常 20–50s，设太短会在活跃时段撞超时导致摘要游标不推进
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
  // 60 在热闹群一小时就打满、点名的回复也被丢，故放宽到 90。
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
  // 生成图先复制到无空格目录再发：CQ 码的 file= 对含空格的本地路径不稳。
  // 部署时建议 IMAGE_OUT_DIR 指到不含空格/中文的绝对路径（如 NapCat 的媒体目录）
  imageOutDir: process.env.IMAGE_OUT_DIR || join(HERE, "media-out"),

  // 能力授权：只有 owner 拿到全部工具，其余人只给聊天用得上的那一样。
  // 主人号只从环境变量 OWNER_QQ 读，代码里不留真人号
  owners: (process.env.OWNER_QQ || "").split(",").map((s) => s.trim()).filter(Boolean),
  admins: (process.env.ADMIN_QQ || "").split(",").map((s) => s.trim()).filter(Boolean),
  blockedUsers: (process.env.BLOCK_QQ || "").split(",").map((s) => s.trim()).filter(Boolean),
  memberGroups: [],
  allowAllGroups: true,
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
  // 群聊语境理解：环形缓冲 50 条、每轮喂 16 条。
  // 400k 窗口实测余量巨大，A/B 延迟无差异；免费档零额度成本。
  addressAliases: ["小千", "千姐"],
  recentBufferSize: 50,
  recentFeedN: 16,
  // 指代解析：结构解析“你”并加括号标注；COREF=0 可一键回滚。
  corefEnabled: process.env.COREF !== "0",
  corefMaxAnnotated: Math.max(0, Number(process.env.COREF_MAX_ANNOTATED || 3) || 3),
  corefMaxPerMessage: Math.max(1, Number(process.env.COREF_MAX_PER_MESSAGE || 2) || 2),
  // 转发消息递归展开上限：代码里每层会递增两次 depth，5 是当前保守值；有效层数以实测为准
  forwardDepth: Math.max(0, Number(process.env.FORWARD_DEPTH || 5) || 5),
  // 入站正文上限：单条消息正文喂模型前截断——转发/引用/卡片各有封顶，
  // 唯独正文原本不封，超长消息会拉大 prompt 拖延迟。超出部分她也接不住，一刀切即可。
  maxTextChars: Number(process.env.MAX_TEXT_CHARS || 4000),

  mediaCacheDir: "media-cache",
  // 生产安全默认：没有显式群白名单就拒绝起（ALLOW_ALL=1 才放开）；群里默认要 @
  requireWhitelist: process.env.ALLOW_ALL !== "1",

  rateLimitedLine: "哎哟，你一口气问太多啦，让我喘会儿再说。",
};
