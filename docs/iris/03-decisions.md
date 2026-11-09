# 03 · 决策台账（ADR）

格式：编号 · 决策 · 理由 · 状态。

## ADR-0001 · 基底是 fork pi-mono，只复用 ai 与 agent-core

- 决策：在 pi-mono 仓库内新增 `packages/iris-*`，不改上游包；复用 `pi-ai`（provider/流式/工具调用）与 `pi-agent-core`（agent loop），不使用 `coding-agent`。
- 理由：pi 的价值在"模型接入 + 工具循环"这一层，而不是它的代码编辑器界面；fork 保留 upstream 可跟进。
- 状态：**已被 ADR-0010 取代**（2026-11-09 改为全量 fork、允许直接改上游）。这里保留「不复用 coding-agent 的界面层」这一判断。

## ADR-0002 · 形态：数字生命 + PC/Android 双端 + 主动型

- 决策：优先做"有独立人格的虚拟伙伴"，PC 为主、Android 为辅，默认主动。
- 理由：这是唯一能和聊天机器人拉开差距的方向；被动型会退化成工具。
- 状态：**待用户确认**（当前按此推进）。

## ADR-0003 · 核心用 TypeScript/Node，Python 只做边缘

- 决策：Runtime、事件循环、记忆、工具全部 TS（与 pi 同栈，Node 24）；CV/音频重活（OpenCV、Whisper、TTS 本地模型）作为 Python sidecar，通过 stdio/HTTP 通信。
- 理由：避免双语言核心；但视觉与音频的生态在 Python 侧，硬搬代价更高。
- 状态：已定。

## ADR-0004 · 实时传输先本地直连，LiveKit 留到多端

- 决策：Phase 1/2 用本机 WebSocket + PCM 分片；Phase 3 引入 LiveKit/WebRTC 处理多设备与弱网。
- 理由：单机 MVP 不需要 SFU；过早引入会把调试成本翻倍。
- 状态：已定（Phase 3 复核）。

## ADR-0005 · 记忆先 SQLite，后 pgvector

- 决策：Phase 1 用 `node:sqlite` 存 Episode + 关键词检索（当前内存实现已对齐接口）；Phase 3 再上 PG + pgvector 做跨设备语义召回。
- 理由：先验证"记得住"，再解决"找得回"。
- 状态：已定。

## ADR-0006 · 人格拆四层，禁止单文件人格

- 决策：identity（稳定的她是谁）/ relationship（对你）/ mood（此刻）/ episodic（共同经历）分开存储与更新；prompt 由 `buildSystemPrompt` 组装。
- 理由：单文件人格必然自相矛盾——情绪变了但关系没变，记忆涨了但性格没变，混在一起就互相污染。
- 状态：已定。

## ADR-0007 · 授权 fail-closed，电话强制披露

- 决策：每个 `ActionRequest` 都有默认授权等级；未知动作、过期凭证、缺 token 一律拒绝；`call`/`post` 返回值带 `requiresAiDisclosure`。
- 理由：越权打电话和未经同意发帖是唯一会让这个项目"做不下去"的两类事故。
- 状态：已定。

## ADR-0009 · Phase 1 模型直连本机 Magpie，不走 pi-ai provider 层

- 决策：`iris-core/src/brain.ts` 用 OpenAI 兼容的 SSE 直连 `http://127.0.0.1:3425`（Magpie，本机、免 key），默认模型 `deepseek/deepseek-flash` + `reasoning_effort: "none"`；`MAGPIE_BASE_URL` / `MAGPIE_MODEL` 可覆盖。
- 理由（2026-11-09 实测，同一句「今天下班有点累，不太想说话」）：
  - 路由组 `auto/deepseek-v4.1-flash` 默认：先花 1.5–3.1 s 出 reasoning，短回复经常整段只有 reasoning、content 为空；
  - 路由组 + `reasoning_effort=low`：content 首字 2238 ms；
  - 直连 `deepseek/deepseek-flash` + `reasoning_effort=none`：content 首字 871–946 ms，整轮 ~1.0 s。
  - 当时 pi-ai 的 `api/openai-completions` 指向 `dist/`，而仓库是纯源码克隆、从未 build，故临时手写 SSE。
- 后续：需要 tool call、重试策略、多 provider 切换时，再迁到 pi-ai。
- 状态：**实现方式已被 ADR-0010 取代**（已改接 pi-ai，`brain.ts` 降为 ~180 行适配器）。**模型选择结论仍然有效**：直连 `deepseek/deepseek-flash` + `reasoning_effort: "none"`，不要用路由组 `auto/*`。

## ADR-0008 · 上游可跟进

- 决策：`origin` 保留为 badlogic/pi-mono（只读参考），我们的改动全部落在新包与新文档；需要改上游时先提 issue/PR，不在本地打散补丁。
- 理由：pi 迭代快，本地改上游会立刻变成无法 rebase 的债务。
- 状态：**已被 ADR-0010 取代**。remote 布局反转：`origin` 现在是自己的仓库，`upstream` 才是 pi。「改动集中在可回退的位置」这条保留。

## ADR-0010 · 全量 fork：直接在上游代码上改，优先复用 pi 的既有机制

- 决策（2026-11-09，用户拍板）：不做「旁挂新包、零依赖」的开发方式。凡 pi 已经写好的（模型接入、agent loop、会话与工具、上下文压缩、重试），**直接用，不重造**；确需不同行为时，直接改上游包源码。
- remote 布局：
  - `origin` → `https://github.com/saberKKSK/IRIS-Agent.git`（自己的仓库，提交目标）
  - `upstream` → `https://github.com/badlogic/pi-mono.git`（只 `fetch`，永不 `push`）
- 理由：pi 是「地基和底盘」，重复造轮子既慢又容易和上游分叉；用自己的仓库承接改动，上游仍可取。
- 已落地的第一个后果：`packages/iris-core` 增加依赖 `@earendil-works/pi-ai@1.5.0`；`src/brain.ts` 从 246 行手写 SSE 改写为约 180 行 `streamSimple` 适配器，删除自研的 SSE 解析、Bearer 头、usage 记账与超时。实测（同一句话）首字 974 ms、整轮 1091 ms，与手写版（946/1081）在噪声内。
- 隐含代价与约束：
  - `tsc` 需要 `packages/*/dist/*.d.ts`，所以**必须先 `npm run build`**；根构建要联网拉 models.dev，需要代理（见 `AGENTS.md` 构建段）。
  - 改上游后与 upstream 的 merge 会冲突；每次合并按「保我们的行为、拿上游的结构」处理，并把取舍记进本文件。
- 状态：已定（仓库范围已按 ADR-0012 裁剪：`全量 fork` 现在只指 ai/agent/schema/telemetry 四个上游包）。

## ADR-0011 · 会话循环交给 pi-agent-core 的 `Agent`，不再自己写 loop

- 决策（2026-11-09，用户要求「去掉自卸的 coro loop，更换为 Pi 的」）：删除 `iris-core/src/brain.ts`（251 行，含自写的 `async function*` 流循环、usage 记账、超时），拆成两个更薄的文件：
  - `src/model.ts`：只描述网关——`magpieModel()` 返回 pi 的 `Model<"openai-completions">`，`MAGPIE_MODEL` / `MAGPIE_BASE_URL` 可覆盖；
  - `src/session.ts`：`IrisSession` 包一层 `new Agent({ initialState, streamFn })`，多轮、工具、重试、steering、中断、事件流全部由 pi 提供。
- `streamFn` 实现：`lazyStream(model, async () => streamSimple(model, context, request), undefined, signal)`。用 `lazyStream` 是硬要求——pi 的 `StreamFn` 契约是「不许抛、不许返回 rejected promise」，同步抛出的连接/鉴权错误否则会直接穿透 agent；经 `lazyStream` 包装后翻成 `{type:"error"}` 事件 + `stopReason:"error"` 的 assistant 消息，再由 `IrisSession.say()` 抛 `IrisSessionError`。
- 采样参数：`reasoning_effort: "none"` 仍放在 `samplingParams` 里（pi 的 OpenAI 兼容适配器会 `Object.assign` 进请求体）；`thinkingLevel` 固定 `"off"`，避免与网关参数双重触发 reasoning。
- 不使用 `context.systemPrompt` / `context.tools`：pi 的 `TranscriptContext` 把 system prompt 与工具声明放在 **transcript 的 system 消息**里，人格 prompt 因此走 `initialState.systemPrompt`，换人格时 `refreshPrompt()` 替换那条 system 消息（历史保留）。
- 理由：`Agent` 已具备多轮 transcript 管理、工具执行、重试与中断；在它上面再手写流循环属于重复实现，还会把 pi 的错误语义挡在外面。
- 实测：同一句首字 0.9–1.8 s、整轮 1.1–2.0 s（Magpie 侧波动，代码路径不变）；`node --test test/*.test.ts` 35/35。
- 状态：已定。
## ADR-0012 · 仓库裁剪到 IRIS 需要的最小集

- 决策（2026-11-09，用户要求「删除掉项目文件的无用文件保持项目干净」）：仓库从 pi-mono 全量 clone 裁到只留 IRIS 用得上的部分。
- 保留：
  - `packages/telemetry`、`packages/schema`（`pi-ai` 的真实依赖，链路上删不掉）
  - `packages/ai`、`packages/agent`（模型接入 + agent loop）
  - `packages/iris-core`（我们自己的核）
  - `docs/iris/`、`AGENTS.md`、`LICENSE`、`scripts/package-files.mjs`（构建用）、根构建配置（`package.json` / `tsconfig*.json` / `biome.json` / `.npmrc` / `.gitignore` / `package-lock.json`）
- 删除：`packages/{chord,codemode,coding-agent,durable,env,evals,mcp,tui}`、`apps/`、`.github/`、`.pi/`、`.husky/`、`nix/` + `flake.*`、`scripts/` 其余 64 个、`README.pi.md`、`CONTRIBUTING.md`、`SECURITY.md`、`pi-test.*`、`test.sh`、`vitest.base.ts`。
- 理由：`pi-ai` 的依赖树只到 `schema` + `telemetry`；其余包（pi CLI、TUI、chord、durable、evals、mcp）与陪伴型智能体无关，只是把仓库撑到 4000+ 文件。根 `package.json` 的 workspaces 与 scripts 同步收窄。
- 代价：不再整树跟进上游。需要上游某个包时按目录取回：`git fetch upstream`，然后 `git checkout upstream/main -- packages/<name>`，再补 workspaces 与依赖。
- 实测（裁剪后）：`npm install --ignore-scripts` → 206 包、0 漏洞；`npm run build` 全绿（telemetry → schema → ai → agent）；`npm test` 35/35；`tsc -p packages/iris-core/tsconfig.check.json` exit 0；`biome check` 无问题；`node examples/live-turn.ts` 首字 1501 ms / 整轮 1879 ms。
- 状态：已定。

## ADR-0013 · 公开仓库只留一条提交，作者记在 saberKKSK 名下

- 决策（2026-11-09）：GitHub 的 Contributors 面板没有开关，它按提交作者统计；压平历史、删 tag/分支之后，GitHub 仍按对象库里残留的不可达提交把 pi 的三百多位作者算进去。所以公开仓库从零重建：旧的 `saberKKSK/IRIS-Agent` 改名保留为 `IRIS-Agent-archive`（私有），新建同名公开仓库，只推一条根提交。
- 提交作者固定为 `saberKKSK <saberKKSK@users.noreply.github.com>`（此前记在 `Vera <2792069779@qq.com>`，对应登录名 LIANGJING7，不是本仓库的账号）。
- 代价：旧仓库的 332 个 pi 版本 tag 与完整上游历史不再出现在公开仓库；需要时从 `IRIS-Agent-archive` 或 `upstream` 取。
- 状态：已定。

## ADR-0014 · 记忆层不复用 Hermes 式记事本：原文永久归档 + 三档生命周期 + 双时间轴

- 背景（2026-11-09，用户提出）：① 整段对话原文落地存档、永不丢；② AI 自动标注「普通 / 中等 / 重要」；③ 分档处理——普通档原文保留、提炼条到期自动清理；中等档 AI 提炼后**给用户过一眼**、确认后才入库；重要档 **AI 只读**、只能人工改。
- 决策：
  1. **原文永久归档**：`messages` 表 append-only（SQLite 触发器禁止 UPDATE/DELETE），写入前过一遍脱敏（`sk-`、16 位以上数字串、`密码[:：]`、邮箱）；唯一删除口是人工执行的 `/forget <conversationId>`：
  2. **三档生命周期**：`ordinary`（30 天 TTL，到期只删提炼条、不碰原文）/ `medium`（`active`，永不自动过期）/ `critical`（直接 `locked`，AI 读得到、写不了，永不自动过期）。原设计的「中等待人工确认」已由 ADR-0016 取消。
  3. **critical 的判定必须「提议 + 条件成立」**：用户当场说过「记住这个 / 这个很重要」、或用户手动提升、或 30 天内被提到 ≥3 次。理由：critical 不可删不可过期，一次误判就是永久错误 —— 所以 AI 判「不重要」要松、判「重要」要紧。
  4. **tier 可升级**：ordinary 被反复命中（≈5 次/月）由 `sweep()` 自动升到 medium、去掉过期时间（原设计是「提议升级」，ADR-0016 改成直接升）。
  5. **AI 改 critical 只能提申请**：写入 `memory_edits` 并进同一队列，不能直接生效。
- 为什么不复用 Hermes Agent（NousResearch）的机制：它的记忆是「工作助手的记事本」——`MEMORY.md`（2200 字符）+ `USER.md`（1375 字符）两个纯文本、会话开始冻结注入 system prompt、agent 自己 `add/patch/remove`、超限报错逼模型自己腾地方，人工闸门 `write_approval` 只是可选开关。它没有原文永久归档、没有时间轴、只有一档。对编码助手够用，对陪伴角色不够：**改错记忆在角色身上不是改错笔记，是人格漂移**。
- 反过来抄它三条工程细节：
  1. **冻结快照保 prefix cache**：会话内不重写 system prompt，新记忆走工具结果进 transcript（当前 `refreshPrompt()` 每改状态就重写第一条 system 消息，会打断缓存，首字从 ~950 ms 掉到 ~1500 ms 以上，必须改）；
  2. **把预算反馈给模型**：`recall()` 返回 `budget:{used,limit}`，而不是悄悄截断；
  3. **写入必须回读校验**：Hermes 文档第一大 troubleshooting 就是「模型说存了其实没存」，所以 `remember()` 返回 `{status:"queued",id,readback:true}`。
- 外部依据：Hermes 文档（[Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)、[Memory Providers](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers)）；[ACL GEM 2026《Is GraphRAG Needed?》](https://aclanthology.org/2026.gem-main.40/)（上下文工程省 19%–53% token，且存在 retrieval-generation gap）；YouTube 2026 下半年共识（GraphRAG 只在多跳场景赢、记忆层是主角、出现 Vectorless RAG 一派）。
- 落地（2026-11-09，`packages/iris-core/src/archive.ts`）：五张表（conversations / messages / memories / memory_fts / memory_edits + maintenance 窗口；原 review_queue 已按 ADR-0016 删除）、脱敏、规则分档、待复核、过期清理、无向量检索全部可用；库默认 `~/.iris/iris.db`（`IRIS_ARCHIVE` 可覆盖，`defaultArchivePath()`），会话开场由 `SqliteArchive.essential()` 注入（重要档优先，只读、不累加命中）。实测同一库文件跨进程：先写「记住这个：我对花生过敏」→ 分档 critical/locked，重启后 system prompt 里出现「· [今天 · 重要] …（原话：「记住这个：我对花生过敏」）」。
- LLM 分档与提炼（2026-11-09，`packages/iris-core/src/distill.ts`）：`llmClassifier()` / `llmDistiller()` / `llmMemory()` 共用一条 Magpie 补全（`streamSimple` + `temperature 0` + `reasoning_effort none` + 20 s 超时 + 不重试）。三条约定：① 输出必须是 JSON，`tier` 走白名单，`quote` 不在原文里就丢掉，text 截 60 字、最多 5 条；② 失败（超时 / 坏 JSON / 空回复）一律返回 `undefined`，由 `archive.ts` 回落规则档与兜底摘要——记忆链路不因网关抽风停摆；③ 分档「宁可判低」，因为 critical 一旦入库就只能人工改。实测同一段四轮对话（`node examples/llm-memory.ts`）：规则版入库的是整段流水（148 字），模型版是三条短事实（「我对花生过敏，不能吃带花生的东西。」「宫保鸡丁含花生，以后不再提这道菜。」「这周连着加班，周六想在家躺着休息。」），每条都带原文子串作证据；档位都是 critical，来源从 `rule` 变 `model`；两次模型调用合计 4.4 s（只在会话结束/归档时跑，不进实时车道）。
- 尚未落地：检索时刻①的「最近 N 轮原文窗口」只注入了提炼条；`refreshPrompt()` 重写 system 消息会打断 prefix cache（ADR 里那条「冻结快照」还欠实现）；模型分档/提炼只在归档时跑，会话进行中不预判档位、也不做实体归并。
- 状态：已定，主体已实施。

## ADR-0015 · 检索先不建向量库：FTS5 单字 + 二元组 + 实体加权 + RRF

- 背景：用户明确「向量库先不看」，问没有向量时 Agent 怎么检索。本机 Magpie `GET /v1/models` 共 14 个模型、无任何 embedding 端点（2026-11-09 实测），要本地嵌入就得先引 Python sidecar。
- 决策：检索拆三个时刻 + 四路召回，先不引入任何向量组件。
  - **三个时刻**：① 每轮开场零查询固定注入（critical ≤5 条 + 最近 N 轮原文窗口）；② 对话中由 agent 自己决定是否调工具；③ 轮末/夜间巩固（分类、提炼、实体归并、过期清理）。
  - **四路召回 + RRF**（`score = Σ 1/(60 + rank_i)`，不调权重）：A 词法主力（FTS5，**单字与二元组都入索引**，查询用 `OR` 连接、`bm25()` 排序）；B 实体（命中 `nodes.name/aliases` → 1 跳邻居 → 关联 episode）；C 时间/层级过滤；D 可选改写（flash 生成 3 个检索词，后台异步，首轮为空才等）。
  - **打分**：二元组命中 ×2 + 单字命中 ×1，只靠单字命中的排最后或丢弃（单字 OR 的噪声实测明显）。
- 实测（2026-11-09，5 条中文 episode，`node:sqlite` 内存库）：单字+二元组 OR 查询 + `bm25()` 排序，延迟 **0.08–0.32 ms**；`有点累` 命中「今天下班有点累」排第一；`看海` 命中共「一起去**看了**海」（纯二元组会漏，必须单字兜底）；`猫`、`国庆回家` 均命中；`出去走走` 出现噪声。
- 检索结果注入：每条带时间与出处、critical 放最前、总长封顶 600 tokens（约 8k prompt 的 7%）；超预算按「ordinary → 最旧 → 同实体合并」砍。
- 无向量时补语义缺口五件事：别名表 + 实体归并、单字兜底、tag 过滤、图邻居扩展、**召回为空就诚实说没找到**（让 agent 直接问用户，好过编造）。
- 评测（不靠检索指标自嗨，论文明确的坑）：20 条真实问题人工判三个数——召回成功率、**错引率**（比召回率更重要）、答对率。
- 迁移条件（any):召回成功率或错引率在不达标区间、记忆量 > 5 万条、或需要跨语言语义召回。届时：本地 bge-m3 sidecar 生成向量，**向量直接存 SQLite BLOB、Node 里暴力余弦**（10k 条 × 1024 维 ≈ 40 MB），不引向量数据库（避免"换模型要重新嵌入"和"备份变两个文件"）。
- 状态：已定，实施中。

## ADR-0016 · 记忆链路不设人工确认：写进来就生效（对齐 Hermes）

- 背景（2026-11-09，用户原话：「不要有人的确认参与，参考 hermes，用户端是无感的」）：ADR-0014 原本让中等档进 `review_queue` 等人工点一次确认。这条被否掉——陪伴型智能体的使用者不该被拉来当数据库管理员。
- 决策：
  1. **没有审批环节**：`pending_review` 状态与 `review_queue` 表一起删除。三档写入即生效：`ordinary`（30 天 TTL）/ `medium`（`active`，永不过期）/ `critical`（`locked`，AI 只读）。
  2. **升级自动**：普通档被反复命中（默认 5 次/月）由 `sweep()` 直接升成 medium 并去掉过期时间，不再生成「要不要升级」的提议。critical **不会**由命中次数自动产生——它只来自「用户明确要求记住」，否则一次误判就是永久锁定。
  3. **修正照旧可能，只是不需要等待**：`amend(id, text)` 改正文（落 `memory_edits` 审计）、`promote(id)` 升为 locked、`drop(id)` 作废、`forget(conversationId)` 删整段原文，都是直接操作，改完立刻对检索生效。没有「申请—批准」两阶段。
  4. **历史库兼容**：老库里 `status='pending_review'` 的行读出来按 `active` 处理（`asStatus`），旧 `review_queue` 表留着不动，不需要迁移脚本。
- 依据：Hermes Agent 的 `write_approval` 是可选项、默认关闭——记忆由 agent 写完就算数，用户端看不到确认提示；我们连这个开关都不留。
- 代价：模型判错档位时没有人兜底，所以「宁可判低」更吃重（critical 判高 = 永久锁定）。缓解：`essential()` 只注入重要档与最近确认的记忆、召回为空就诚实说没找到；真要改，`amend` / `drop` 随时可用，只是不打断对话。
- 实测（2026-11-09，`npm run demo:archive`）：四段会话落库后立刻可检索（「看海」1.30 ms /「花生」0.28 ms /「累」0.24 ms，各 1 条）；命中 5 次的普通档自动变 `medium/active`、`expires_at=NULL`；31 天后普通档过期 1 条而原文 2 条仍在；`amend` → `promote` → `drop` 三步直接生效。`npm test` 65/65。
- 状态：已定，已实施。

## ADR-0017 · 语料导入：从原文里量出说话方式与人格，不靠形容词堆设定

- 背景（2026-11-09，用户原话：「增加 导入 语料库的功能，让Agent 根据这些内容去 模仿风格去回复消息，模仿人格的部分，以及这个」——「这个」指前面发来的去 AI 味仓库 lieflat-less-ai-tone）。
- 决策：新增 `packages/iris-core/src/style.ts`，把「导入语料 → 学她怎么说话」做成一条可复现的链路，五步：
  1. **读**：`readCorpus()` 支持单文件或目录（递归 3 层，跳过 `.git`/`node_modules`/`dist`），只收 `.txt/.md/.markdown/.jsonl/.json/.log/.csv`，单文件封顶 2 MB；`.json/.jsonl` 走 `structuredLines()`，把常见聊天导出（`{speaker,text}` / `{role,content}` / `{messages:[...]}` / `{data:[...]}`）压成「名字：内容」。
  2. **切**：`splitUtterances()` 逐行认 `名字：` 前缀（也认全角冒号），跳过标题、引用、列表、代码围栏，剥掉包裹的引号与 markdown 强调；纯标点/表情行不算说话。可只学某一个人（`speaker` 过滤）。
  3. **量**：`analyzeStyle()` 只产出数得出来的东西——句长（均值/中位/p90/离散度）、九类标点每千字、问句与感叹占比、每条消息 emoji 数、语气词频次、口癖（2-4 字 n-gram，长的优先、被包含的短的丢掉）、自称与对对方的称呼、4 条原话样本。**没有一句形容词**。
  4. **归纳（可选）**：`summarizeStyle()` 用 Magpie 把样本概括成 2-3 句人格描述，system 里写死「只描述样本里看得出来的，不编造，不恭维」；失败返回 `undefined`，档案照旧可用。
  5. **存 + 用**：`styles` 表落在同一个 SQLite（`saveStyle` / `style` / `styles` / `activateStyle` / `removeStyle`，同名覆盖、同一时刻只有一份 active）；`renderStyle()` 输出一段 prompt，由 `buildSystemPrompt` 插在「你和用户」之后、「你记得的事」之前；`IrisSession` 自动取当前生效的那份，`useStyle(name)` 换人设后立刻重建 system 消息。
- 反 AI 味放在两处，且刻意分开：
  - **进 prompt** 的只有 4 条（翻案句、结论冒号/起手式、三连顿号、每句解释上一句），渲染成「别这样说话」跟在样本后面；
  - **不进运行时** 的 `toneFlags()` 做离线回归：七类（翻案句 / 结论冒号 / 起手式 / 三连顿号 / 破折号 / 分号 / 翻译腔）命中就给改法。
- 为什么不直接把 lieflat-less-ai-tone 装成 skill：它的 `scripts/detect.py:536` 硬性要求汉字 ≥ 500，实测喂三段 IRIS 对话直接报「汉字过少（<500），检测无意义」；`SKILL.md` 的「不改的情况」第二条写明「对话体、口语体：本来就是自然表达」；工作流是「出报告 → 等用户回复 → 再改写」，与「用户无感」冲突。该仓库为 **CC BY-NC 4.0（作者 shiujan）**，这里只借 4 条实测规则并在源码注释里署名。
- 只搬对短对话成立的指标：翻案腔 AI 0.73 vs 人 0.22 次/千字（3.4×，配对复测 δ +0.88/+0.72）、结论冒号 3.8×、起手式 3.2×、密集顿号 1.45×。**反向的 X 级清单不学**——句长/段长离散度、序数词小标题、「这意味着」等人机没有差异或人类更多，照抄那部分等于让她表演「像人」。
- 边界：语料只学**说话方式**，不学事实与经历——prompt 里明写「原话只学语感，不要照抄，也不要在回复里提起这些句子」；导入他人聊天记录需自己确认授权；档案只存在本机 SQLite，不上传。
- 实测（2026-11-09，`examples/corpus/chat.txt` 40 句双人对话，学「小鹿」20 句）：平均 12.6 字/中位 14 字/九成 ≤16 字；语气词 呀 4、嘛 3、哈 3、啦 3；模型归纳 1 次调用；AI 味扫描 0 命中。同一句「今天好累啊，不想说话」回复「累就歇会儿吧，我陪你安静待着」（首字 1069 ms、整轮 1216 ms、prompt 434），句子长度与语气词分布和语料一致。`npm test` 74/74。
- 状态：已定，已实施。

## ADR-0018 · 人味从「接话形状」里学，不从形容词里学

- 背景（2026-11-09，用户原话：「现在是让她的回复更加有人的习惯而不是像ai一样，所以需要学习下」）。此前已按 ADR-0017 把「嗓音」写进 prompt，但量出来发现她的问题不在长短，在**形状**。
- 语料（都是当场抓的，不是听说）：
  1. **贴吧 lol 吧** 7 个帖子 56 层楼（`https://tieba.baidu.com/mo/q/m?kz=<tid>` 移动端可读、桌面端 403），帖子 `11178435533` / `11177215444` / `11178184129` / `11176913000` / `11171580636` / `11180763236` / `11180732864`。
  2. **Neuro-sama 切片**（YouTube 自动字幕 `q1JSIW1F1aE` 4059 字符、`aXqojy-9o48` 2432 字符；B站官方号中文翻译 `BV1m4421Z7CF` 713 字符）。抓取：`yt-dlp --proxy http://127.0.0.1:7890 --skip-download --write-auto-subs --sub-langs 'en.*'`。
- 真人实测（贴吧 54 层 ≤400 字的楼）：中位 **23 字**、均值 32、p90 88；≤10 字 **22.2%**、≤20 字 **41%**、≥100 字 **3.7%**；问号结尾 **16.7%**、含问号 **20.4%**；AI 词（首先/其次/总之/换句话说/这意味着…）命中 **1.9%**；破折号 **0%**、分号 **0%**、翻案对仗 **0%**。
- Neuro 实测（1302 词切片）：`you` 53.8‰ > `i` 44.5‰（话是冲着对方说的，不是自省）；`what` 14.6‰、`okay` 8.4‰、`know` 11.5‰（当场反问、当场改口）。原话里的形状：自问自答（「你们喜欢邪恶吗 / 是的」）、中途改口（「我想说…不过」/「不过 / 我并不可爱」）、跑到不相干的地方（「你知道用棒球棒砸显示器，像素会炸成小烟花吗」）、单字与拟声收尾（「做」「喵喵喵」）。
- 判断（本条 ADR 的核心）：**AI 味主要来自「平均分配注意力」——对方说五件事，逐件照顾；真人只接一件，然后顺着自己的念头走。** 所以规则不能写成「要简短」「要口语」，要写成「挑一个点接」「用对方的词」「允许不知道」「允许跑题」「允许说一半改口」。
- 落地：
  1. `packages/iris-core/src/persona.ts` 的「## 怎么说话」从 6 条重写成 14 条，逐条对应上面的实测（先反应 / 挑一个点 / 回声用词 / 反问多于解释且照写问号 / 允许不知道 / 允许改口 / 允许跑题 / 不必有结论 / 长短不一 / 连发两条 / 只说一件事且不用分号破折号 / 不对仗 / 不总结对方 / 不用论文词）。
  2. 新增 `chatify()`：分号 → 换行、破折号 → 逗号、压掉多余空白；在 `IrisSession.say()` 里紧跟 `stripTrailingPeriods()` 之后跑（`punctuation: "prose"` 时整段跳过）。理由是这类符号是她**开始写文章**的信号，prompt 只能降低概率，代码能保证不为零。
  3. `personas/senjougahara.md` 加「## 9. 说话的形状（例子）」三句，明写「只看形状，不要照抄字面」——few-shot 比形容词管用，但必须防鹦鹉学舌。
  4. 新增 `packages/iris-core/examples/voice-bench.ts`：12 条真实口吻输入（寒暄 / 被骂 / 自我怀疑 / 求代写 / 被指刻薄 / 朋友评价 / 大笑 / 怕被忘记 / 求推荐 / 深夜独行 / 抱怨 / 收场），量中位字数、≤20 字占比、问号结尾占比、AI 词密度、破折号/冒号/三连顿号占比，落 `.artifacts/voice-<tag>.json`。**这是回归基线，不是演示。**
- 前后实测（同 12 条输入，`node examples/voice-bench.ts`）：中位 15 → **19** 字（真人 23）；≤20 字占比 58.3% → **66.7%**（真人 41%）；问号结尾 0% → **16.7%**（真人 16.7%）；AI 词密度 0 → 0。中间那版（v2）一度长出 **8.3% 分号**（真人 0%），所以有了 `chatify()`，v3 归零。
- 不学的部分：Neuro 的内容与混乱（她的跑题是直播表演）、贴吧的语气（那是观众在谈角色，不是角色在说话）。只学「接话的形状」。
- 边界：贴吧与 YouTube 字幕都是公开内容，仅作离线统计与规则提炼，不写入记忆库、不进归档。
- 状态：已定，已实施。

## ADR-0019 · 三条「像人」的硬修正：她自己的账、被怼只回一句、材料之外不当事实

- 背景（2026-11-09，用户 m02177 原话：「三点都fix」）。三条不是风格偏好，是三次实测暴露的同一个病：**她没有「自己」这一层，所以别人喂什么就说什么。**
  1. 我喂素材时把「四个维度 62–78%」写错了（真实是 **72–78%**：EI 75 / SN 78 / TF 72 / JP 78，OEJTS 1.2），她照着错的数字说了两轮，一次没质疑，第三轮被对手拿这个数字反击时还替它辩护：「人家 OEJTS 本来就给 62 到 78 之间」。
  2. 被贴吧口吻连骂五条时，她 3/3 逐条回应（140–158 字），而真人是一句挑最疼的戳回去。
  3. 微博那条里她说「他一个卖币的」——这是模型自带的世界知识（孙宇晨=波场），材料里根本没写；这类先验错了也照样笃定。
- 决策与落地：
  1. **她自己的账（self facts）**：`SqliteArchive` 新增 `self_facts(key, value, source, at)` 六行表 + `rememberSelf()` / `selfFacts()` / `forgetSelf()`；`buildSystemPrompt` 在身份之后渲染 `## 关于你自己` 段，`IrisSession.buildPrompt()` 全量注入（默认上限 20 条，按写入顺序）。**只有人能写**（`node examples/remember.ts --self <key> <value>`），agent 没有这条路径——她不许改自己的履历。prompt 里跟一句：「对不上就直接说他记错了，把这里写的讲出来……这里没写的事，别硬认，也别硬说没发生——记不清就说记不清。」
  2. **被怼只回一句**：「## 怎么说话」加一条——「被骂、被挑刺的时候尤其只回一句，挑最疼的那条回，其余不解释。逐条反驳是心里没底的人才干的事。」
  3. **材料之外不当事实**：「## 边界」加一条——「别人给你看的东西之外，你的世界知识只是猜测。谁是谁、谁做过什么、谁跟谁什么关系，材料里没写就别当事实讲，说不知道比编一个强。」
- 实测（用第二轮 MBTI 批评原文，同一段素材跑 3 次，`node .artifacts/react.ts`）：
  - **没种自我事实**（改前）：194 / 140 / 74 字，**0/3 纠正 62–78**，且主动给错数字找依据（「人家 OEJTS 本来就给 62 到 78 之间」）。
  - **种了自我事实**（真库 `~/.iris/iris.db` 两条：28 题精简版四个 100% 只能当玩具；OEJTS 四维 72–78 不是 62–78）：第一次跑就出现「OEJTS 给的是区间，我记的 72 到 78，没说过 62，你转过来的时候给改了」；但同批还有 1/3 在替旧版本编理由（「62 到 78 是我第一次发出来的那套数字」）。
  - **再加一句「这里没写的事，别硬认，也别硬说没发生」**（第一版写得太硬，导致她把真说过的话也否认了）：54 / 37 / 65 字，**3/3 都咬住数字这件事**（「你把『62 到 78』和『偏 N 偏 T 偏 J』混一起说」「说了这么多，一句『62 到 78 哪来的』都没答」「他记错了一件事，OEJTS 是 72 到 78」）。
  - **被骂那条**（「你这嘴怎么这么欠……」）4/4 都只回一句、13–15 字：「受不了就走啊，我又没拦着你」「受不了就别受，我又没求着你」。
  - **语感没有退步**（`voice-bench.ts` 同 13 条输入）：中位 16 → 20 字（真人 23）、≤20 字 61.5% → 53.8%、多句 0% → 0%、AI 词 0、破折号/冒号/三连顿号 0；中位延迟 1448 → 1507 ms。
- 代价：system prompt 从 2669 字符涨到 **4079 字符 / 260 行**（人设文档 2327 + 自我事实 ~200 + 规则），首字从 ~1.0 s 到 ~1.3–2.0 s。自我事实是**每轮全量注入**的，条数涨上去要分档（现在的上限是 20 条）。
- 边界：自我事实记的是「她做过什么、得出过什么结果」，不是用户档案（那在 memories 里）、也不是设定（那在 persona 文档里）。事实与设定冲突时以事实为准，因为设定是「她是谁」，事实是「她干过什么」，后者能被外部证据核对。
- 状态：已定，已实施（`npm test` 86/86、`tsc` 0、`biome` 只有 useTemplate 提示）。
