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

> 记忆生命周期的**实现口径**看 [03-decisions.md](03-decisions.md) 的 ADR-0014（原文永久归档 + 三档 + 时间轴）、ADR-0015（先不建向量库，FTS5 单字+二元组 + 实体加权）、ADR-0016（不设人工确认，写入即生效）；**语料风格**看 ADR-0017。

代码起点：`packages/iris-core`（已可运行，86 个测试）。模块：`types`（词汇表）/ `persona`（四层人格→prompt）/ `memory`（内存版 Episode 表）/ `archive`（SQLite 原文归档 + 三档生命周期 + 无向量检索）/ `distill`（模型分档 + 提炼成短事实）/ `style`（语料导入 → 说话方式档案）/ `attention`（三车道）/ `consent`（授权闸门）/ `initiative`（主动开口）/ `model`（Magpie）/ `session`（pi `Agent` 会话层）。

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
node --test test/*.test.ts                    # 86/86
node examples/demo-day.ts                     # 离线：一天的时间线
node examples/archive-day.ts                  # 离线：三档记忆 + 自动升级 + 无向量检索 + 过期
node examples/live-turn.ts "今天下班有点累"      # 真模型：走本机 Magpie
node examples/remember.ts "记住这个：我对花生过敏"  # 真模型：写入 ~/.iris/iris.db
node examples/remember.ts --probe              # 不联网：重开后 prompt 里还剩什么
node examples/remember.ts --self mbti "我做过…" # 记一条「她自己的账」，只由人写
node examples/llm-memory.ts                    # 真模型：规则版 vs 模型版提炼对比
node examples/corpus-import.ts examples/corpus --speaker 小鹿 --summarize --reply "今天好累啊"
npm run talk                                   # 真模型：交互式对话，走 ~/.iris/iris.db
npm run talk -- "在吗"                         # 单发一句就退出
npm run chat                                   # 脚本化六轮，方便对比
node examples/voice-bench.ts before            # 人味回归基线：12 条输入 → 中位字数/问号/AI 词
```

记忆：`archive.ts` 把每轮原文 append-only 落进 SQLite（脱敏后、触发器禁改删），会话结束时按规则分三档——普通档 30 天 TTL、中等档直接 `active` 且永不过期、重要档 `locked`（AI 只读）；**没有人工确认环节**，写入即生效（ADR-0016），要改就用 `amend` / `promote` / `drop` 直接改；检索用 FTS5 单字+二元组 + bm25 + 分层/时间加权，实测 0.2–0.8 ms，没有向量库。库默认在 `~/.iris/iris.db`（`IRIS_ARCHIVE` 可覆盖）；会话开场用 `SqliteArchive.essential()` 把重要档与最近确认的记忆注入 system prompt。归档时的分档与提炼可以换成模型（`distill.ts` 的 `llmMemory()`，`temperature 0` + 20 s 超时，失败自动回落规则）：模型版写进库的是短事实 + 原文子串作证据，规则版是整段流水。

语料风格：`style.ts` 把导出的聊天记录 / 小说片段读进来（`.txt/.md/.jsonl/.json`，目录递归 3 层），按「名字：内容」切句，量出句长、标点密度、语气词、口癖、自称与称呼，再渲染成 prompt 的一段（ADR-0017）。`--summarize` 会多调一次模型把样本概括成 2-3 句人格；失败就不写，档案照旧可用。档案存进同一个 SQLite（`styles` 表，`saveStyle` / `style` / `activateStyle` / `removeStyle`），会话自动用当前生效的那份，`session.useStyle("小鹿")` 可以随时换。prompt 里固定附一句「原话只学语感，不要照抄、不要提起」，以及 4 条「别这样说话」（翻案句、结论冒号、三连顿号、每句解释上一句）——这些是 lieflat-less-ai-tone 里对短对话成立的实测项，其余人机无差异的指标不学。

真对话：`examples/talk.ts` 是 REPL——一行一句、边生成边打印，每轮原文落库；`/prompt` 看 system prompt、`/memory` 看开场注入的记忆、`/recall 关键词` 查归档、`/stats` 看库、`/exit` 收尾（归档 + 分档 + 提炼）。人格文档用 `personas/senjougahara.md` 整份顶替模板里的「## 你是谁」。

两条输出侧硬约束（人设文档压不住，所以放进代码）：① 括号动作/旁白一律剥掉——独占一行的 `（…）` 整行删、行首黏在台词前的删前段、`她：（…）` 连说话人前缀一起删，句中括号保留（`stripStageDirections`）；② 聊天里句尾不留句号——逐行去掉行尾 `。`，问号/省略号/感叹号与句中句号不动（`stripTrailingPeriods`）。两条都能用 `stageDirections: true` / `punctuation: "prose"` 关掉。

人味：ADR-0018 把「怎么接话」也写成硬规则（先反应、挑一个点接、用对方的词、反问多于解释、允许不知道/改口/跑题、长短不一、不总结对方、不用论文词），依据是当场量的两批语料——贴吧 lol 吧 54 层真人回复（中位 23 字、≤20 字 41%、问号结尾 16.7%、破折号与分号 0%）与 Neuro-sama 切片字幕（`you` 53.8‰ > `i` 44.5‰，`what` 14.6‰）。第三条输出侧约束是 `chatify()`：分号转换行、破折号转逗号——真人打字不用这两个符号，prompt 只能降概率，代码归零。`examples/voice-bench.ts` 是回归基线，改 prompt 后重跑对比 `.artifacts/voice-*.json`。

「她自己的账」（ADR-0019）：`self_facts` 表记她做过什么、得出过什么结果（`rememberSelf` / `selfFacts` / `forgetSelf`），开场全量注入 system prompt 的「## 关于你自己」段，并附一句「别人转述你的过去时先跟这里对一遍，对不上就说他记错了；这里没写的事别硬认，也别硬说没发生」。**只有人能写**（`remember.ts --self`），agent 没有写路径——履历不许自己改。配套两条硬规则：被骂被挑刺只回一句（挑最疼的），材料之外的世界知识只当猜测（没写就说不知道）。实测：同一段「拿 OEJTS 62 到 78 反驳她」的素材，改前 0/3 纠正且替错数字辩护；种了自我事实 + 两条规则后 3/3 咬住数字（54/37/65 字）。

模型网关：`model.ts` 只描述 endpoint（本机 Magpie `http://127.0.0.1:3425/v1`，OpenAI 兼容、免 key），默认 `deepseek/deepseek-flash` + `reasoning_effort: none`，首字 0.9–1.8 s。会话循环由 `session.ts` 交给 pi-agent-core 的 `Agent`，不再自写 loop。理由见 ADR-0009 / ADR-0010 / ADR-0011。
