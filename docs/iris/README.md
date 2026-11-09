# IRIS 文档索引

IRIS（伊里斯）是建立在 pi 之上的**娱乐型 / 陪伴型智能体**，不是 Coding Agent，也不是 Work Agent。
本仓库是 pi-mono 的 fork，已裁到 IRIS 需要的最小集：`packages/{telemetry,schema,ai,agent,iris-core}` + 根构建配置，其余 pi 包与 apps 全部移除（ADR-0012）。`origin` = `saberKKSK/IRIS-Agent`（公开仓库只有一条提交，ADR-0013），`upstream` = `badlogic/pi-mono`（只 fetch，需要哪个包就按目录取回）。

| 文档 | 内容 |
|---|---|
| [00-vision.md](00-vision.md) | 是什么、不是什么、五条设计原则 |
| [01-architecture.md](01-architecture.md) | 分层、三条时间线、子系统与代码落点 |
| [02-roadmap.md](02-roadmap.md) | 四阶段与验收标准 |
| [03-decisions.md](03-decisions.md) | ADR 决策台账（**ADR-0010 = 复用 pi、ADR-0012 = 仓库裁剪**） |
| [04-consent.md](04-consent.md) | 授权、披露与红线 |
| [05-memory.md](05-memory.md) | 记忆分层与检索策略 |

> 记忆生命周期的**实现口径**看 [03-decisions.md](03-decisions.md) 的 ADR-0014（原文永久归档 + 三档 + 时间轴）、ADR-0015（先不建向量库，FTS5 单字+二元组 + 实体加权）、ADR-0016（不设人工确认，写入即生效）；**语料风格**看 ADR-0017；**联网**看 ADR-0024，**「她说搜过了就得真搜」**看 ADR-0025，**只读文件三件**看 ADR-0026。

代码起点：`packages/iris-core`（已可运行，135 个测试）。模块：`types`（词汇表）/ `persona`（四层人格→prompt）/ `memory`（内存版 Episode 表）/ `archive`（SQLite 原文归档 + 三档生命周期 + 无向量检索）/ `distill`（模型分档 + 提炼成短事实）/ `style`（语料导入 → 说话方式档案）/ `attention`（三车道）/ `consent`（授权闸门）/ `initiative`（主动开口）/ `model`（Magpie，主对话 + 视觉两个 endpoint 描述）/ `vision`（看图 → 转述）/ `context`（上下文满了压成记忆）/ `web`（联网：搜索与抓页）/ `files`（只读文件三件 + 授权闸门）/ `session`（pi `Agent` 会话层）。

## 跑起来

pi 各包以 `dist/` 作为入口，而 `dist/` 是 gitignore 的生成物——**全新克隆必须先构建**，否则 import `@earendil-works/pi-ai` 会 `ERR_MODULE_NOT_FOUND`。

```bash
cd pi-mono
npm install --ignore-scripts   # 206 包，约 5 s

# 构建要联网拉 models.dev 的模型目录，走代理（否则 UND_ERR_CONNECT_TIMEOUT）
export NODE_USE_ENV_PROXY=1 HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890
npm run build
```

```bash
cd packages/iris-core
node --test test/*.test.ts                    # 135/135
node examples/demo-day.ts                     # 离线：一天的时间线
node examples/archive-day.ts                  # 离线：三档记忆 + 自动升级 + 无向量检索 + 过期
node examples/live-turn.ts "今天下班有点累"      # 真模型：走本机 Magpie
node examples/remember.ts "记住这个：我对花生过敏"  # 真模型：写入 ~/.iris/iris.db
node examples/remember.ts --probe              # 不联网：重开后 prompt 里还剩什么
node examples/remember.ts --self mbti "我做过…" # 记一条「她自己的账」，只由人写
node examples/llm-memory.ts                    # 真模型：规则版 vs 模型版提炼对比
node examples/compact-day.ts                   # 真模型：上下文撑满 → 压成记忆 → 接着聊
node examples/corpus-import.ts examples/corpus --speaker 小鹿 --summarize --reply "今天好累啊"
npm run talk                                   # 真模型：交互式对话，走 ~/.iris/iris.db
npm run talk -- "在吗"                         # 单发一句就退出（默认联网 + 只读文件，--offline / --no-files 关掉）
npm run web -- "今天有什么 AI 新闻"            # 不调模型，直接看搜索桥返回什么
npm run chat                                   # 脚本化六轮，方便对比
node examples/voice-bench.ts before            # 人味回归基线：12 条输入 → 中位字数/问号/AI 词
npm run look -- 截图.png                       # 看图：先转述，再让她回一句
npm run look -- 截图.png --note-only           # 只看转述，不让她说话
```

记忆：`archive.ts` 把每轮原文 append-only 落进 SQLite（脱敏后、触发器禁改删），会话结束时按规则分三档——普通档 30 天 TTL、中等档直接 `active` 且永不过期、重要档 `locked`（AI 只读）；**没有人工确认环节**，写入即生效（ADR-0016），要改就用 `amend` / `promote` / `drop` 直接改；检索用 FTS5 单字+二元组 + bm25 + 分层/时间加权，实测 0.2–0.8 ms，没有向量库。库默认在 `~/.iris/iris.db`（`IRIS_ARCHIVE` 可覆盖）；会话开场用 `SqliteArchive.essential()` 把重要档与最近确认的记忆注入 system prompt。归档时的分档与提炼可以换成模型（`distill.ts` 的 `llmMemory()`，`temperature 0` + 20 s 超时，失败自动回落规则）：模型版写进库的是短事实 + 原文子串作证据，规则版是整段流水。

语料风格：`style.ts` 把导出的聊天记录 / 小说片段读进来（`.txt/.md/.jsonl/.json`，目录递归 3 层），按「名字：内容」切句，量出句长、标点密度、语气词、口癖、自称与称呼，再渲染成 prompt 的一段（ADR-0017）。`--summarize` 会多调一次模型把样本概括成 2-3 句人格；失败就不写，档案照旧可用。档案存进同一个 SQLite（`styles` 表，`saveStyle` / `style` / `activateStyle` / `removeStyle`），会话自动用当前生效的那份，`session.useStyle("小鹿")` 可以随时换。prompt 里固定附一句「原话只学语感，不要照抄、不要提起」，以及 4 条「别这样说话」（翻案句、结论冒号、三连顿号、每句解释上一句）——这些是 lieflat-less-ai-tone 里对短对话成立的实测项，其余人机无差异的指标不学。

真对话：`examples/talk.ts` 是 REPL——一行一句、边生成边打印，每轮原文落库；`/prompt` 看 system prompt、`/memory` 看开场注入的记忆、`/recall 关键词` 查归档、`/stats` 看库、`/exit` 收尾（归档 + 分档 + 提炼）。人格文档用 `personas/senjougahara.md` 整份顶替模板里的「## 你是谁」。**她的名字是「伊里斯（IRIS）」**，那份文档只是性格原型设定（`Persona.name` 在五个 example 里统一为「伊里斯」）；被问到和原型的关系时她答「原型是照着来的，我没打算装成她本人」。

两条输出侧硬约束（人设文档压不住，所以放进代码）：① 括号动作/旁白一律剥掉——独占一行的 `（…）` 整行删、行首黏在台词前的删前段、`她：（…）` 连说话人前缀一起删，句中括号保留（`stripStageDirections`）；② 聊天里句尾不留句号——逐行去掉行尾 `。`，问号/省略号/感叹号与句中句号不动（`stripTrailingPeriods`）。两条都能用 `stageDirections: true` / `punctuation: "prose"` 关掉。

人味：ADR-0018 把「怎么接话」也写成硬规则（先反应、挑一个点接、用对方的词、反问多于解释、允许不知道/改口/跑题、长短不一、不总结对方、不用论文词），依据是当场量的两批语料——贴吧 lol 吧 54 层真人回复（中位 23 字、≤20 字 41%、问号结尾 16.7%、破折号与分号 0%）与 Neuro-sama 切片字幕（`you` 53.8‰ > `i` 44.5‰，`what` 14.6‰）。第三条输出侧约束是 `chatify()`：分号转换行、破折号转逗号——真人打字不用这两个符号，prompt 只能降概率，代码归零。`examples/voice-bench.ts` 是回归基线，改 prompt 后重跑对比 `.artifacts/voice-*.json`。

「她自己的账」（ADR-0019）：`self_facts` 表记她做过什么、得出过什么结果（`rememberSelf` / `selfFacts` / `forgetSelf`），开场全量注入 system prompt 的「## 关于你自己」段，并附一句「别人转述你的过去时先跟这里对一遍，对不上就说他记错了；这里没写的事别硬认，也别硬说没发生」。**只有人能写**（`remember.ts --self`），agent 没有写路径——履历不许自己改。配套两条硬规则：被骂被挑刺只回一句（挑最疼的），材料之外的世界知识只当猜测（没写就说不知道）。实测：同一段「拿 OEJTS 62 到 78 反驳她」的素材，改前 0/3 纠正且替错数字辩护；种了自我事实 + 两条规则后 3/3 咬住数字（54/37/65 字）。

一个会话到底（ADR-0021 / ADR-0022）：原文本来就在库里，但 pi 的 `Agent` 每次从空 transcript 起，所以重启后她只记得结论、接不上刚才那句话。现在 `IrisSession` 启动时用 `SqliteArchive.recentMessages()` 把原文还原成 transcript 交给 `Agent`——**接的是消息，不是塞进 prompt**，裁剪与预算仍归 pi 管。默认不限时间（同一个会话就是同一段对话），条数上限 200、字符预算 24 000 字，并且**复用同一条会话行**（`latestConversation`）而不是每次启动新开一条；`finishConversation()` 靠 `conversation_marks` 游标只提炼新增部分，不会重复写记忆。`resumeMessages: 0` 关掉，`reuseConversation: false` 每次新开会话，`session.restoredMessages` / `session.conversation` 报告接回几条、是哪条。REPL 开场打印「（同一个会话 conv-… · 接回 N 条原文）」。实测两个独立进程：库里 `conversations` 不增加，第二条消息接回 170 条，问「还记得我出门前说啥吗」→「你说回来跟我说／现在回来了，说吧」。

上下文满了压成记忆（ADR-0023）：pi 的 `Agent` 自己不剪消息，撞窗口就是整轮 `stopReason: "error"`。现在 `context.ts` 的 `ContextCompactor` 挂在 `transformContext` 上，超预算（窗口 − 16 384）就把最旧的一段交模型写成「你自己的记述」（第一人称、200 字内、保留名字数字约定），落两处：transcript 里一条普通 assistant 便签「（更早的聊天我记着了：…）」，加 `archive.remember({ tags: ["巩固"] })` 进记忆。**压出来的是记忆，不是技术摘要**——下次开场它就在「## 你记得的事」里。摘要失败用原文兜底（`plainSummary`），不抛错；运行中不刷 system prompt（会废掉 prefix cache）。`createSession({ compact: false })` 可关，`session.compactions` 报压过几次、压前压后 token。实测 68 条旧对话压掉 52 条、1395 → 321 token，那一轮首字从 1.5 s 涨到 3.5 s。

眼睛（ADR-0020）：主对话模型看不了图，所以视觉走另一条路——`vision.ts` 的 `describeImage()` 用 `workbuddy-ai/hy4free`（网关里 14 个模型实测唯一能看图的；`any/*` 404、`workbuddy-ai/gpt-6-*` 与 `glm-5.3` 429、`deepseek/*` 收下图但 **content 为空**）把图转述成几句话，`IrisSession.sayAbout()` 再把转述包成一条用户消息喂回主会话——**原图不进上下文**（主模型看不了，塞进去只烧 token）。入口：REPL 的 `/img <路径> [| 附带一句话]`、`npm run look -- <图>`。看一张 51 KB 截图约 8.8 s，1.6 MB 的 13.3 s，一轮总共 10–15 s，所以只能挂 async 车道。**小字/数字不可信**：它会读错转发数、点赞数，要准就另做裁剪或 OCR。转述的问法必须朴素（「三句以内」这类收口要求），一写清单式要求它就在 reasoning 里逐字统计、永远收不了尾。

联网（ADR-0024）：pi 上游没有 websearch，所以借 `@liustack/modsearch` 当搜索桥——`web.ts` 起一次 `node dist/main.js`、把 JSON 摊平、压成短文本，导出 `web_search` / `web_fetch` 两个 pi 工具（工具名对齐 dsh，参数用纯 JSON Schema）。默认走 Firecrawl 免注册通道（每月 1 000 credits、无需 key、不用代理），失败自动换引擎；**失败不抛**，翻成 `isError` 结果让模型自己说查不到。prompt 里配了「## 你能上网」四条：先查再说、用自己话说别念结果别报网址、查不到就说查不到、一件事查一次。REPL 默认带工具（`--offline` 关），`npm run web -- "查询"` 是不打模型的体检口。实测单次搜索 1.1–1.9 s；问「今天有什么 AI 新闻」她自己搜了两次、15.8 s 后回「黄仁勋那边的事，NVIDIA 董事会立案查他和疑似外国情报人员的关系了。你信吗，反正我不太信」——内容是当天真事。注意 `source: "x"` 走 grok 退化路径要 11.6 s，描述里已注明一般不传。

真的会去查（ADR-0025）：「让她搜」那句话本身没有查询词，长历史下她只会嘴上答「行，我来搜一个」——库里全是她接工具之前说过的假「搜过了」，接回 transcript（ADR-0021/0022）就成了「我已经查过」的证据。两条腿解决：① `looksLikeLookup()` 认出「搜/查/最新/天气/股价…」这类口吻时，那一轮第一次请求带 `tool_choice: "required"`（走 `samplingParams`，因为 pi 的 `ToolChoice` 只有 auto/none；**必须同时带 `reasoning_effort: "none"`，否则网关 400「Thinking mode does not support this tool_choice」**），工具走完的第二轮不再强制；② 同一轮在发给模型的输入末尾加一句「（这一句是新问题，要查就用这一句问的事去查，今天是…）」——只进请求不进库，历史里的同类尾巴由 `transformContext` 逐条摘掉。实测 200 条历史下：「你试试随便搜索」→ 1 次 `web_search {query:"今日热点新闻"}` 11.7 s；「印度最近出什么事了」「Sakana AI 是什么公司」不带关键词也各查 1 次，「你最近看了什么」0 次。代价是带搜索一轮 5–12 s，查询词里的年份仍会被它编。

只读文件（ADR-0026）：pi 的原生工具在 coding-agent 里（ADR-0012 已裁掉），给她的只有 **ls / read / grep** 三件，`bash` / `write` / `edit` 明确不给——能改机器的能力不可逆，与「未授权不动手」冲突。`files.ts` 的 `FileGuard` 负责让与不让：根目录默认「家目录 + 当前工作目录」，deny 名单挡 .ssh / .env / .pem / .kdbx 一类，**授权单位是根目录下的第一层文件夹**，第一次碰要问人、同意后本次进程内放行，没人能问就一律拒（fail-closed）；三个工具失败只返回 `isError` 结果、不抛。prompt 里按手上真有的工具给段（`canSearch` 只认 `web_search`，`canLook` 只认文件三件），ADR-0025 的强制调工具也收窄成只在有 `web_search` 时触发——否则「帮我搜一下」会逼她去 `ls`。REPL 里她第一次碰某个文件夹会停下来问「（她想看 … 允许吗？y/N）」，也能用 `/allow <路径>` 事先放行；`--no-files` 关掉整套。实测（便签三行）：`ls → read →` 念出原文并点评一句，四轮工具首字 8.5 s；追问细节时不重复读文件，1.2 s 直接答。

模型网关：`model.ts` 只描述 endpoint（本机 Magpie `http://127.0.0.1:3425/v1`，OpenAI 兼容、免 key），默认 `deepseek/deepseek-flash` + `reasoning_effort: none`，首字 0.9–1.8 s；看图用 `workbuddy-ai/hy4free`（`MAGPIE_VISION_MODEL` 可换）。会话循环由 `session.ts` 交给 pi-agent-core 的 `Agent`，不再自写 loop。理由见 ADR-0009 / ADR-0010 / ADR-0011。
