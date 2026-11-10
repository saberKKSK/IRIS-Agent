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

> 记忆生命周期的**实现口径**看 [03-decisions.md](03-decisions.md) 的 ADR-0014（原文永久归档 + 三档 + 时间轴）、ADR-0015（先不建向量库，FTS5 单字+二元组 + 实体加权）、ADR-0016（不设人工确认，写入即生效）；**语料风格**看 ADR-0017；**联网**看 ADR-0024，**「她说搜过了就得真搜」**看 ADR-0025，**只读文件三件**看 ADR-0026 / ADR-0027，**点赞与评论不设人工闸门**看 ADR-0028，**私信只回名单上的人**看 ADR-0029 / ADR-0030，**思考档位自动选**看 ADR-0031，**权限一次点头管到底（她可以自己开口要）**看 ADR-0033，**写权限与读权限分两本账**看 ADR-0034，**自己跑命令**看 ADR-0035，**看屏幕**看 ADR-0036，**一直看着屏幕并自己开口**看 ADR-0037，**接得下去与允许翻车**看 ADR-0038，**桌面壳（Electron + Live2D）**看 ADR-0039，**壳换成 MyGo 与整窗透明的坑**看 ADR-0040；**表情由她自己选（正文里的 `<脸红>` 是标记）**看 ADR-0041。

代码起点：`packages/iris-core`（已可运行，232 个测试）。模块：`types`（词汇表）/ `persona`（四层人格→prompt）/ `memory`（内存版 Episode 表）/ `archive`（SQLite 原文归档 + 三档生命周期 + 无向量检索）/ `distill`（模型分档 + 提炼成短事实）/ `style`（语料导入 → 说话方式档案）/ `model`（Magpie，主对话 + 视觉两个 endpoint 描述）/ `vision`（看图 → 转述）/ `context`（上下文满了压成记忆）/ `web`（联网：搜索与抓页）/ `files`（只读文件三件 + 要权限 + 授权闸门）/ `write`（写五件：写 / 追加 / 建目录 / 改名搬家 / 要写权限）/ `shell`（命令执行一件：只读的直接跑，其余问他，地方跟着写权限走）/ `screen`（看屏幕：抓一张缩略图交给视觉模型转述）/ `perception`（一直看着屏幕：20 秒瞥一眼，变了才重新描述，给他空闲时她自己开口）/ `lines`（输入队列）/ `douyin`（刷抖音：推荐流 / 评论 / 点爱心 / 发一条 / 私信只回名单上的人）/ `browser`（借插件那台无头 Chrome 在页面里发请求）/ `effort`（这一轮该想多深：规则优先，分类模型可选）/ `complete`（一次纯文本补全，几个模块共用）/ `session`（pi `Agent` 会话层）。

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
node --test test/*.test.ts                    # 232/232
node examples/archive-day.ts                  # 离线：三档记忆 + 自动升级 + 无向量检索 + 过期
node examples/live-turn.ts "今天下班有点累"      # 真模型：走本机 Magpie
node examples/remember.ts "记住这个：我对花生过敏"  # 真模型：写入 ~/.iris/iris.db
node examples/remember.ts --probe              # 不联网：重开后 prompt 里还剩什么
node examples/remember.ts --self mbti "我做过…" # 记一条「她自己的账」，只由人写
node examples/llm-memory.ts                    # 真模型：规则版 vs 模型版提炼对比
node examples/compact-day.ts                   # 真模型：上下文撑满 → 压成记忆 → 接着聊
node examples/corpus-import.ts examples/corpus --speaker 小鹿 --summarize --reply "今天好累啊"
npm run talk                                   # 真模型：交互式对话，走 ~/.iris/iris.db
npm run talk -- "在吗"                         # 单发一句就退出（默认联网 + 只读文件 + 写 + 命令 + 抖音 + 私信 + 看屏幕 + 一直看着屏幕，--offline / --no-files / --no-write / --no-shell / --no-douyin / --no-screen / --no-watch 关掉；--idle 秒数 改「他多久没说话算空下来」，默认 90；--confirm-douyin 让点赞、评论、私信重新问人）
npm run talk -- --think                        # 同上，再打开「这一轮该想多深」的规则版自动档位
npm run talk -- --think-llm                    # 再加分类模型兜底（规则拿不准的轮多花约 1.2 s）
npm run web -- "今天有什么 AI 新闻"            # 不调模型，直接看搜索桥返回什么
node examples/voice-bench.ts before            # 人味回归基线：12 条输入 → 中位字数/问号/AI 词
npm run look -- 截图.png                       # 看图：先转述，再让她回一句
npm run look -- 截图.png --note-only           # 只看转述，不让她说话
```

桌面壳（`apps/desktop`，ADR-0039 → 壳已换成 MyGo，见 ADR-0040）：皮套是《DeepSeek-chan（大肥鱼）》，**许可禁止再分发，模型不进 git**——放在 `C:\IRIS Agent\assets\live2d\大肥鱼\DeepSeek`，由 Go 侧注册的 `live2d://` 自定义协议直接喂给 WebView2（Windows 上是 `http://live2d.localhost/…`），找不到时退回 daemon 的 `/live2d`。窗口、穿透、拖窗、daemon 拉起都在 Go 里；页面还是那套 Pixi 8 + Live2D。

```bash
cd pi-mono/apps/desktop
npm install          # pixi 8 + @naari3/pixi-live2d-display 1.2.5 + mygo-cli / mygo-runtime
npm run daemon       # 脑子：http://127.0.0.1:5274（/health /events /say /speakup）；mygo dev 也会自己拉起来
npm run dev          # 透明置顶窗（mygo dev：Go 热重建 + vite），日志在 %TEMP%\iris-shell.log
npm run dev:web      # 只开页面：vite，http://127.0.0.1:5273（浏览器里也能开，会铺深色底）
npm run build        # mygo build：产出 iris-desktop.exe
npm run generate     # 改了 Shell 的 Go 方法后重新生成 src/mygo.ts
```

渲染上的硬约束（改之前先看 ADR-0039）：`model.setRenderer(app.renderer)` 不能省、`resolution` 必须是 1、`_useHighPrecisionMask = true` 才能把嘴裁对；`internalModel.draw` 外面那层还原 `clearColor` 也不能删，否则整块白底。窗口侧的硬约束在 ADR-0040：必须关掉 DWM 的亚克力背板（否则整窗磨砂提亮）、`#stage` 必须 `pointer-events: none`（否则按不到 grip）、拖窗由页面发增量给 `Shell.MoveBy`（MyGo 的 `StartDrag` 在 WebView2 上收不到位移）。表情链路在 ADR-0041：她在正文最前面写 `<脸红>` 这类标记，内核用 `ExpressionStream` 流式摘掉再广播 `expression` 事件，壳调 `stage.setExpression` 淡入，14 s 后自动收回；**别回头用 fork 的 `model.expression()`**（叠加语义，会把她眼睛盖成灰洞）。

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

只读文件（ADR-0026 / ADR-0033）：pi 的原生工具在 coding-agent 里（ADR-0012 已裁掉），给她的只有 **ls / read / grep** 三件 + 一个开口要权限的 `request_access`，`bash` / `write` / `edit` 明确不给——能改机器的能力不可逆，与「未授权不动手」冲突。`files.ts` 的 `FileGuard` 负责让与不让：根目录默认「家目录 + 当前工作目录」，deny 名单挡 .ssh / .env / .pem / .kdbx 一类，**授权单位是根目录下的第一层文件夹**（根目录只是一开始的起点，不是天花板：家目录外面的文件夹也能放开，`root === undefined` 时授权单位就是那条路径本身），第一次碰要问人、没人能问就一律拒（fail-closed）；三个工具失败只返回 `isError` 结果、不抛。prompt 里按手上真有的工具给段（`canSearch` 只认 `web_search`，`canLook` 只认文件三件），ADR-0025 的强制调工具也收窄成只在有 `web_search` 时触发——否则「帮我搜一下」会逼她去 `ls`。**权限一次点头管到底**（ADR-0033）：他放开的文件夹记在 `~/.iris/file-roots.json`（`IRIS_GRANTS` 可覆盖），重启也算数；问的时候是三档——`y` 就这次、`a` 以后整个根目录都放给她、`N` 不给。她要是有地方看不到，会自己调 `request_access` 说清哪个文件夹、为什么想看（理由原样给人看），点头之后同样落盘。启动时打印她已经能看哪些，`/grants` 列全部、`/forget <路径>` 收回。deny 名单（`.ssh` / `.env` / `.pem` / `.kdbx` 等）是硬线，放开家目录也挡着。输入侧同时修了一个真 bug：两个工具并行来问权限时，旧的单一唤醒槽会被顶掉 → 整轮卡死 → `Detected unsettled top-level await` 直接退出；现在输入走 `src/lines.ts` 的 `LineQueue`（等的人排队），要问人的事也串成一条线问。实测（真网关）：她 `ls 桌面` 被拒 → 立刻 `request_access {path:"桌面",reason:"你想让我看看桌面上有什么，我得先能看见那个文件夹"}` → 点头 → 列出 13 项，首字 5.6 s / 整轮 6.6 s。`--no-files` 关掉整套。实测（便签三行）：`ls → read →` 念出原文并点评一句，四轮工具首字 8.5 s；追问细节时不重复读文件，1.2 s 直接答。

能动手写（ADR-0034）：**写权限和读权限是两本账**——能看不等于能写。`write.ts` 的 `WriteGuard` 单独记一份放行名单（`~/.iris/write-roots.json`，`IRIS_WRITE_GRANTS` 可覆盖），默认空，所以一上来她哪儿都不能写；第一次碰某个文件夹照样问人，`y` 就这次、`a` 以后整个根目录都放给她写、`N` 不给，没人能问就一律拒。工具只有五件：`write_file` / `append_file` / `make_dir` / `move_path` / `request_write`（她开口要写权限，理由原样给人看）；**`bash` / `delete` / 批量替换仍然不给**。比只读多两道闸：① 覆盖已存在的文件前，她必须在本次进程里 `read` 过它，否则回 `kind: "unread"` 让她先读；② 写完立刻回读比对，不一致就报失败（Hermes 那条「模型说存了其实没存」的教训）。文件落盘是原子的（先写 `.iris-tmp-<pid>-<ts>` 再 rename），`move_path` 目标已存在直接拒、不覆盖。deny 名单在只读那份基础上加 `.git` / `node_modules` / `Windows` / `Program Files` / `System32`，扩展名加 `.exe .dll .sys .bat .cmd .ps1 .sh .vbs .lnk` 一类。REPL 里 `/writes` 列已放开的写目录、`/write <路径>` 事先放行（落盘）、`/unwrite <路径>` 收回，`--no-write` 整套关掉。实测三段：让她在临时目录建 `日记` 文件夹——她建了但**拒绝编日记**（「日记得写点真的才有意思…你随便丢一句给我，我照着写三行」）；让她改 `notes.md` 第二行——先 `read` 再 `write_file`，只动那一行，还顺口挤兑作息（「原来写的是睡到中午，现在是睡到下午」）；让她把 `80-艾拉` 改名 `80-伊里斯`——`move_path` 真改了，回「改完了…用我自己的名字，行吧，这个我认」。三段落盘后都没有 `.iris-tmp-*` 残留。

能跑命令（ADR-0035）：pi 的 `bash` / `powershell` 随 coding-agent 裁掉了，这里按她的授权模型重做一件 `run_command`——一条命令一次，没有交互式会话、没有后台、默认 30 s 超时（超时按进程树掐掉），输出头尾各留一半（上限 20 000 字符），非零退出算错但输出照样给她。**地方沿用写权限**（能写的文件夹就是能跑命令的地方，不新开一本账），**只读命令直接跑**（`DEFAULT_READ_ONLY_HEADS` 22 个：ls / dir / cat / type / head / tail / pwd / whoami / hostname / date / where / which / get-* / select-string / measure-object / resolve-path / test-path），其余逐条问人，`a` 就记住这个**命令头**（`~/.iris/exec-allow.json`，`/exec` 看、`/unexec` 取消）。危险命令（rm -rf、`git push`、`npm publish`、改注册表、关机、`Invoke-Expression` 等 28 条）永远逐条问、**记住也没用**；判断看命令头不看全文——想靠解析参数确认「这条只读」本身不可靠。**这不是沙箱**：命令以当前用户身份跑，能拦的只有「没被允许的那几条」，真要隔离得靠容器。`--no-shell` 关掉整套。实测：让她 `git status`——真跑，回「main 上没落后，但 12 个文件改了没提交…」68 字 4.0 s；让她删一个探针文件（approve 恒拒）——只跑只读的 `Get-ChildItem`，然后自己停住「现在要删吗？删了就没了」，再逼一句仍然没删，回「删除这一步要给他先看一眼才能执行」——三道闸都在，她也没绕。

能看你屏幕（ADR-0036）：用户给的 linux.do 那篇《腾讯首个游戏陪伴Agent：鹅次元》里，它「纯视觉读游戏画面」——不读内存。那个客户端闭源、只走 QQ/微信登录，没有 API，**接入不了**；能做的是同一件事的做法：抓一张缩略图，交给视觉模型说几句。`screen.ts` 用 **ffmpeg 的 gdigrab** 抓主屏（0.7–2.2 s，512 宽 JPEG 约 16–27 KB），再走 `vision.ts` 转述（8.7 s）——**不是** PowerShell + System.Drawing：那条脚本在本机被 Defender 的 AMSI 整段判成「This script contains malicious content」，`行:1 字符:1` 一行都执行不了，PowerShell 版只留作没装 ffmpeg 的退路。工具一件 `look_at_screen {question?}`（`--no-screen` 关掉，`/look [问题]` 你自己调一次，只打印转述、不进对话回合），不设授权闸门——他叫她看才看，prompt 里 `## 你能看屏幕` 五条写明「很慢、一轮看一次、小字和数字大概率看错、拿回来的是别人替你描述的几句话，没看清就说没看清」。返回正文固定附「（截的是缩略图，小字和数字可能看错）」。实测（真网关 + high）：问「你看看我屏幕上现在是什么」——她自己调工具，15.3 s 首字，答「一个混元的对话框，开着，里面一坨中文文字／你在跟谁聊天呢，还是自己在写东西」；`/look` 问「屏幕上这行字写的什么」——抓 2.2 s、看 9.7 s，老实交代「图中文字太小、太模糊，我无法辨认出任何一行具体写了什么」。**512 宽就是这个极限**：版面、窗口、「大概在干嘛」能看，聊天/代码/表格里的具体数字不可信。隐私提醒：抓的是主屏整屏，屏幕上的东西（包括别人的窗口）都会发给 Magpie 的视觉模型。

一直看着屏幕（ADR-0037）：`perception.ts` 的 `ScreenWatcher` 每 20 秒抓一张 32×20 灰度缩略图（`ffmpeg gdigrab`，0.21–0.25 s，640 字节），只比均值差——差 ≥8 才叫视觉模型（一次 9–13 秒）。**不能用文件哈希**：同一张静止的屏连抓两次是 2484 B 和 2378 B，md5 不同（桌面的亚克力模糊一直在动）。描述缓存成一行，每次请求现贴在对方那句话后面「（他屏幕上是：…（3 分钟前看的））」，不进 system prompt（保 prefix cache），超过 10 分钟标「可能已经变了」。主动开口不能用 `Agent.continue()`（最后一条是 assistant 时它直接抛 `Cannot continue from message role: assistant`），改成 `speakUp()` 造一条「（你自己开口：…）」的 user 消息走同一条 `runTurn`；那一轮不落归档、不写 episode。三个条件全中才开口：他超过 90 秒没说话（`--idle` 可调）+ 屏幕自他上次说话后真的变过 + 距上次主动开口 5 分钟。实测：静止屏连抓三次 10479 / 222 / 213 ms，只看了 1 次；真机首眼 12.9 s 拿到 373 字描述；她主动说的第一句是「你那代码窗口右边站的那个蓝白头发的，是来监工的吗」（24 字，首字 1.8 s）。`/watch` 看她的眼睛现在什么状态，`--no-watch` / `--no-screen` 关掉。
刷抖音（ADR-0027 / ADR-0028）：抖音的评论接口要 a_bogus 签名（jsdom + 七个 sdk）和水印 Cookie，这套东西本机插件 `dsh-douyin-scroll` 已经调通了，所以不重写——`douyin.ts` 把它的 `tools/mcp-server.mjs` 当**标准 stdio MCP 子进程**用（每次调用一个进程：握手 → `tools/call` → 收工），导出四个 pi 工具：`douyin_feed`（推荐流，默认 6 条、最多 30 条，链接只留 `https://www.douyin.com/video/<id>`）、`douyin_comments`（读评论，带楼中楼）、`douyin_like`（点爱心 / 取消）、`douyin_reply`（发一条或回某条）。

**点赞和评论都不再问人**（ADR-0028）：刷到喜欢的直接点，想说话直接发，`--confirm-douyin` 才退回「逐条问 y/N」。点赞走的是另一条路——digg 是写接口，Node 侧签名 POST 一律回 `用户未登录`（只读接口同一份 Cookie 却正常），说明它额外要 ticket-guard 的请求头，那套只有页面 SDK 算得出来；所以 `browser.ts` 连插件**本来就常驻**的那台无头 Chrome（`--headless=new`，端口 9334–9373），用 CDP 在页面上下文里发 fetch——**屏幕上不会出现任何窗口**。判据也不信接口自报：digg 回的 `is_digg` 是调用前的状态，工具会紧接着读 `aweme/detail` 的 `user_digged` 复核，对不上就报失败。实测 `likeVideo('7703585367337641577')` → `{ok:true, digged:true}`、取消 → `digged:false`，全程没有新开窗口。

同时把插件自己的自动轮次停了（`autoEnabled/autoComment/chatWatch = false`）——免得两个 agent 用同一个账号、两套人格各刷一遍。说什么由她自己的 prompt 决定（`## 你也能刷抖音` 八条：点爱心不用问谁、一轮顶多一两条、看两三条就够、发就用自己会说的那句、不写放谁身上都成立的空话、不提自己是 AI、发出去就收不回所以先想清楚、刷到真想让他看的就讲给他听）。实测：取一轮推荐流 11 s，评论 79 条列 8 条，一轮对话三次工具首字 14.0 / 17.9 / 2.6 s。

**思考档位**（ADR-0031）：**主对话默认 `high`**（`DEFAULT_SESSION_EFFORT`，2026-11-10 定）；`--effort none|low|high` 临时改基准档，`--think` 打开规则版逐轮改档（接话继承上一轮 / 核对类硬词与长材料升 `low` / 招呼短话压 `none`），`--think-llm` 再开分类模型兜底（本机一次 1.0–1.2 s，只在规则拿不准时问）。`high` 的代价是首字从约 1 s 涨到 3–9 s（实测 103/86/130 字、3.1/6.6/8.9 s；带工具那轮 10.9 s）；短句仍然短（挨骂 12/19 字）。**强制工具那一轮永远压成 `none`**（思考模式下 `tool_choice: "required"` 会 400），`turn.effort` 报的就是实际用的档。记忆分档/提炼、看图转述这类调用不在主对话链路上，仍是 `none`。

**私信只回名单上的人**（ADR-0029 / ADR-0030）：抖音的私信接口必须点名某个人，没有「列出所有会话」的入口，所以不接陌生人——名单写在 `~/.iris/contacts.json`（`IRIS_CONTACTS` 可覆盖）：

```json
{ "contacts": [{ "name": "Walk away", "id": "MS4wLjABAAAA…" }] }
```

名单外的人她读不到也回不了（空名单 = 谁都碰不了）。两个工具：`douyin_im` 看某人最近说了什么（摊成「我：…」「名字：…」，转发视频显示成「（发了个视频 <id>）」）、`douyin_dm` 回一条（≤300 字，带 `confirm: true` 走无头路径）。默认都不问人，`--confirm-douyin` 才逐条问。REPL 里 `/roster` 看当前名单。**注意：没有轮询**——只有你问她「看看私信」，她才会去读。


模型网关：`model.ts` 只描述 endpoint（本机 Magpie `http://127.0.0.1:3425/v1`，OpenAI 兼容、免 key），默认 `deepseek/deepseek-flash` + `reasoning_effort: none`，首字 0.9–1.8 s；看图用 `workbuddy-ai/hy4free`（`MAGPIE_VISION_MODEL` 可换）。会话循环由 `session.ts` 交给 pi-agent-core 的 `Agent`，不再自写 loop。理由见 ADR-0009 / ADR-0010 / ADR-0011。
