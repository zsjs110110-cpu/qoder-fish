# qoder-fish

把 [Qoder Agent SDK](https://qoder.com) 当大脑的 QQ 群聊 bot：OneBot v11（NapCat）接入，分层提示词人设，带记事本长期记忆、群聊语境理解、定时任务、画图/找图、网页抓取与本机管理台。

默认人设是「小千」——一个承认自己是 AI 的温柔大小姐（通义 Qwen 打底）。人设可整体替换，参考 [`prompt-layers/`](prompt-layers/README.md)。

> 第三方 QQ 协议端（NapCat 等）是 QQ 明令禁止的，**存在封号风险**。请务必只用小号部署，并遵守下面的安全红线。

## 功能

- **会话池**：一个群/私聊 = 一条常驻 SDK 会话；同群串行队列（等待上限、过期丢弃）；单轮超时先 `interrupt()` 再同会话重试；LRU 与空闲回收；聊满 120 轮或上下文占用到 45% 即换会话（后台摘要旧转录），新会话首轮交接上一段最近 10 条对话；同群连续 2 次超时会暂停 5 分钟并只丢非直达闲聊
- **分层提示词**：L0 身份诚实/安全底线 → L1 表达规范 → L2 角色（可换）→ L3 能力层（由实际注册的工具表自动生成，"说出来的本事"与"真有的工具"不可能不一致）→ 记事本规矩 → 收尾提醒；L4 运行时上下文每轮贴到用户消息尾部（前缀可缓存）
- **记事本记忆**：每群一个目录（条目 schema `uid=… kind=事实|规矩 ok=0|1 :: 正文`）；门控——点名词只有主人说了才算数，未批准的规矩不进注入；来源核验防名片伪造；读写两侧清洗（敏感类目/祈使句/非中文拒收）；**两层记忆**：热层 `MEMORY.md` 每人 10/全群 100 常驻注入，冷层 `LONGTERM.md` 每人 20/全群 300 按需召回；`ok=1` 事实满 3 天晋升冷层，进层时做确定性合并 + 模型语义合并，失败保留确定性结果；热层满（全群 100/单人 10）时强制最早 5 条事实转冷（规矩不参与），清洗/摘要先无限暂存再由晋升统一取舍，冷层满时新晋条目回留热层、绝不两层同时删除；【待补记】明确要求"记一下"的话因超时/熔断/配额没处理时先落盘，下一条成功轮补记
- **长期记忆召回**：进程内 MCP 工具 `RecallMemory`，只读本群冷层、最多 5 条；owner/admin/member 可用，guest/blocked 拒绝
- **群聊语境**：环形缓冲旁路记录（含她没接的话）、回复链话题线标注、三层点名判定（@/回复=硬点名，称呼命中=弱提示；未点名时不预设立场，先按话题线/指代标注判断这句在对谁说——@别人、回复别人、@全体或未指名——再决定接不接）、指代解析（"你/他/她/它"结构标注，纯规则不调模型）；接话预判（独立小会话二分类，图片/卡片/转发/链接旁路直接走完整会话）
- **多模态**：入站图片、引用图、转发内图片喂视觉；WebFetch 失败或版面重要时本机 Edge 无头截图再看一眼；ImageGen 异步画图（只给 owner，后台生成完补发）；ImageSearch 搜图 + 模型按画面挑选
- **定时任务**：`daily`/`weekdays`/`weekly:0-6`/`once` 四种重复，到点现场生成一句经同一发送闸门投递；非主人每人每天限 1 个；投递预检（连接/白名单/禁言/小时上限）不烧额度；单实例锁 + 原子写
- **本群历史检索**：进程内 MCP 工具 `SearchHistory`，只读本群转录、自动洗 uid、过滤隐私类目
- **发送闸门**：条与条最小间隔、滚动小时上限、超限只丢不重试；被禁言时消息只留档不调模型；长回复自动拆成几条短消息（人手打气泡的观感）
- **外发净化**：标签/工具名/Markdown/链接剥离、回声去重、限长——防"念出内部词"和格式泄漏
- **鉴权与限额**：角色（owner/admin/member/guest/blocked）× 工具策略 × 记事本路径围栏 × URL 护栏（私网/回环/`file:` 对所有人硬拦）× 每人条数限额；硬否决清单纵深防御（Bash/Agent 等永远拒）
- **SDK 双轨 + BYOK 第三轨**：cn（本机 `qoderclicn` 登录态，免 PAT）/ global（PAT）互为备份，一端免费档日限额耗尽自动换轨（切轨后到本地零点前不再切，零点后可回启动轨）；可选第三方 API Key 作最后兜底（BYOK 走 CLI 的 custom provider，直连第三方端点，上下文窗口按配置声明）
- **本机管理台**：`http://127.0.0.1:6100/` 看轨道/冷却/会话状态、手动切轨、编辑 BYOK（Key 不回显）、按 Base URL + Key 拉取模型列表；只绑 loopback，写操作带一次性 token

## 文件结构

| 文件 | 作用 |
|---|---|
| `index.mjs` | 生产入口：白名单硬门槛、单实例锁、定时任务调度、管理台；没给 OneBot 地址时落进本地 REPL |
| `config.mjs` | 模型/思考档/工具面唯一定义处、硬否决清单、限额、发送节奏 |
| `prompt-layers/` | 分层提示词（参考示例）+ `layers.mjs` 拼装器；`LAYERS_DIR` 可指向自己的目录 |
| `brain.mjs` | 会话池、ask 主流程、超时中断重试、画图异步链、工具 hooks 与 canUseTool 判定 |
| `auth.mjs` | 角色 → 工具策略 → 路径围栏 → URL 检查 → 管理动作 → 条数限额 |
| `memory.mjs` | 记事本：schema、门控、热层/冷层配额、晋升与冷层召回、读写清洗、来源核验 |
| `sanitize.mjs` | 外发净化与拆泡 |
| `media.mjs` / `media-cache.mjs` | 图片读取护栏（本地缓存目录内 / 过 URL 检查的公网图）与按群 TTL 媒体缓存 |
| `recent.mjs` / `coref.mjs` | 群聊语境缓冲与指代解析 |
| `scheduler.mjs` | 定时任务：解析、配额、到点执行、失败保留、过期清理 |
| `history.mjs` | 本群转录检索（SearchHistory 背后） |
| `session-memory.mjs` / `summarize.mjs` | 会话轮换摘要（自动/手动） |
| `adapters/onebot.mjs` | OneBot v11 正向 WS 客户端：事件路由、白名单、禁言状态、引用/转发/卡片展开、发送闸门 |
| `sdk.mjs` | cn/global/byok 三轨运行时与限额换轨；BYOK 把配置同步进 CLI user settings 的 providers 段 |
| `backup.mjs` | 群目录快照（启动 + 定时，按天保留/份数上限） |
| `delivery.mjs` | 交付事件台账（拟回复 vs 已发送，只记状态不记正文） |
| `admin-web.mjs` / `admin-settings.mjs` / `byok-store.mjs` / `model-list.mjs` | 本机管理台 |
| `napcat-doctor.mjs` | 只读自检：连 NapCat 打印机器人号/状态/所在群号（拿白名单要填的群号），不回消息 |
| `model-check.mjs` | 配置体检：打印实际发给 SDK 的配置并向 SDK 实问模型/思考档/上下文档/BYOK（零模型轮次，不花额度） |
| `repl.mjs` | 本地 REPL 与 `--script` 批量模式（不打 QQ，直接调大脑） |
| `groups/<会话key>/` | 一群一目录 = 隔离边界：`session.json`、`memory/MEMORY.md`（热层）、`memory/LONGTERM.md`（冷层）、`chat.jsonl`、`recent.jsonl`、`schedule.json`（运行时生成，不进仓库） |

## 环境要求

- Node.js 22+（使用原生 WebSocket）
- QQ 侧：一个小号 + [NapCat Shell](https://github.com/NapNeko/NapCatQQ)（详见 [NAPCAT接入清单.md](NAPCAT接入清单.md)）
- 模型侧二选一起步：
  - **cn 轨（默认）**：本机安装并登录 `qoderclicn`，无需 PAT
  - **global 轨**：`QODER_EDITION=global` + `QODER_PERSONAL_ACCESS_TOKEN`（qoder.com/account/integrations 生成）

## 快速开始

```bash
npm install

# 1) 先跑配置体检（不花额度）
node model-check.mjs

# 2) 本地 REPL 试聊（不接 QQ）
node index.mjs          # 或 node repl.mjs --script e2e-script.json

# 3) 接 NapCat：先只读自检拿群号
ONEBOT_WS=ws://127.0.0.1:3001/ ONEBOT_TOKEN=你的token node napcat-doctor.mjs

# 4) 起 bot（必须给白名单，否则拒绝启动）
ONEBOT_WS=ws://127.0.0.1:3001/ ONEBOT_TOKEN=你的token \
OWNER_QQ=你的QQ号 ALLOW_GROUPS=群号 \
node index.mjs
```

## 主要环境变量

完整清单见 [运维手册.md](运维手册.md) 第 4 节。最关键的几个：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ONEBOT_WS` / `ONEBOT_TOKEN` | — | NapCat 的 WebSocket 服务器地址与 token |
| `OWNER_QQ` / `ADMIN_QQ` / `BLOCK_QQ` | 空 | 主人/管理员/黑名单 QQ 号，逗号分隔。**不设 OWNER_QQ 就没有人能管理** |
| `ALLOW_GROUPS` / `ALLOW_PRIVATE` | 空 | 群/私聊白名单；一个都不设且没 `ALLOW_ALL=1` 时**拒绝启动**（故意的） |
| `REQUIRE_AT` | 关 | `0`=先按话题线/指代标注判断这句在对谁说，再决定接不接（不想接回「跳过」）；`1`=只在被 @ 时回 |
| `QODER_EDITION` | `cn` | 初始轨道：`cn`/`global`/`byok` |
| `QODER_PERSONAL_ACCESS_TOKEN` | — | global 轨凭据 |
| `IMAGE_OUT_DIR` | `./media-out` | 外发图片暂存目录，建议指到**不含空格/中文**的绝对路径 |
| `LAYERS_DIR` | `./prompt-layers` | 提示词分层目录 |
| `RATE_PER_MIN` / `RATE_PER_DAY` | 15 / 500 | 每人每分钟/每天条数限额（owner 不计） |
| `SEND_MIN_GAP_MS` / `SEND_HOURLY_CAP` | 2000 / 90 | 发送节奏：条间最小间隔、每会话滚动小时上限 |
| `ROTATE_AFTER` | 180 | 聊满多少轮换会话 |
| `MEMORY` | on | `off` 关记事本 |
| `ADMIN_WEB` / `ADMIN_WEB_PORT` | 开 / 6100 | 本机管理台 |
| `BYOK_ENABLED` 等 `BYOK_*` | 关 | 第三方 API 兜底轨，Key 只走环境变量或管理台 |

## 跑测试

全部离线（不打模型、不花额度），失败以非零码退出：

```bash
for f in *.test.mjs; do node "$f" >/dev/null 2>&1; echo "$f exit=$?"; done
```

25 个套件、约 935 条断言，覆盖：净化、鉴权与 URL 护栏、记事本门控与两层记忆、OneBot 路由与传输（对本地 mock 服务端）、群聊语境与指代、队列、超时取消、运行时 hooks、轮换摘要与冷层语义合并、历史检索、长期记忆召回、定时任务、画图任务恢复、双轨与 BYOK、管理台 HTTP。

注：auth 套件的 `localtest.me`/`nip.io` 两条依赖真实 DNS，开着 Fake-IP 模式的代理时这两条 FAIL 属环境问题。

## 安全红线

- NapCat 的 WS 服务器只绑 `127.0.0.1`；不要开 HTTP 服务器、不要内网穿透；`3001`/`6099`/`6100` 加防火墙入站阻止
- `ONEBOT_TOKEN`、PAT、`BYOK_API_KEY`、机器人号、主人 QQ、群号不进任何提交/截图/日志（日志里 token 已打码）
- `byok-config.json`、`groups/`、`media-cache/` 已在 `.gitignore` 里——它们含密钥和真实聊天内容
- 只用小号；不要主动水群、不要大量发送
- 私网/回环/`file:` 对所有人（包括 owner）硬拦，不要为了"方便"放开
- 记事本的批准权只认主人号 + 本群真说过话的号，别改这块逻辑——它挡的是"群友一句话引导 bot 记住伪造群规"

## 已知边界

- 敏感拦截是词表 + 非中文拒收，不是语义理解，同义改写可能漏
- 后台记忆 agent 的写入不经过 `canUseTool`，靠 roots 指向本群目录 + 越界即删 + 事后清洗兜底
- `chat.jsonl` 明文无保留期；日志无轮转——上线前自己定清理策略
- 网页截图只截首屏；卡片解析只覆盖常见类型
- 成本观测弱（免费档 SDK 不回传真实 credits），所以只有条数限额、没有配额闸门

## License

ISC
