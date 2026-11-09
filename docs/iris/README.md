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

> 记忆生命周期的**实现口径**看 [03-decisions.md](03-decisions.md) 的 ADR-0014（原文永久归档 + 三档 + 时间轴）、ADR-0015（先不建向量库，FTS5 单字+二元组 + 实体加权）、ADR-0016（不设人工确认，写入即生效）。

代码起点：`packages/iris-core`（已可运行，65 个测试）。模块：`types`（词汇表）/ `persona`（四层人格→prompt）/ `memory`（内存版 Episode 表）/ `archive`（SQLite 原文归档 + 三档生命周期 + 无向量检索）/ `distill`（模型分档 + 提炼成短事实）/ `attention`（三车道）/ `consent`（授权闸门）/ `initiative`（主动开口）/ `model`（Magpie）/ `session`（pi `Agent` 会话层）。

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
node --test test/*.test.ts                    # 65/65
node examples/demo-day.ts                     # 离线：一天的时间线
node examples/archive-day.ts                  # 离线：三档记忆 + 自动升级 + 无向量检索 + 过期
node examples/live-turn.ts "今天下班有点累"      # 真模型：走本机 Magpie
node examples/remember.ts "记住这个：我对花生过敏"  # 真模型：写入 ~/.iris/iris.db
node examples/remember.ts --probe              # 不联网：重开后 prompt 里还剩什么
node examples/llm-memory.ts                    # 真模型：规则版 vs 模型版提炼对比
```

记忆：`archive.ts` 把每轮原文 append-only 落进 SQLite（脱敏后、触发器禁改删），会话结束时按规则分三档——普通档 30 天 TTL、中等档直接 `active` 且永不过期、重要档 `locked`（AI 只读）；**没有人工确认环节**，写入即生效（ADR-0016），要改就用 `amend` / `promote` / `drop` 直接改；检索用 FTS5 单字+二元组 + bm25 + 分层/时间加权，实测 0.2–0.8 ms，没有向量库。库默认在 `~/.iris/iris.db`（`IRIS_ARCHIVE` 可覆盖）；会话开场用 `SqliteArchive.essential()` 把重要档与最近确认的记忆注入 system prompt。归档时的分档与提炼可以换成模型（`distill.ts` 的 `llmMemory()`，`temperature 0` + 20 s 超时，失败自动回落规则）：模型版写进库的是短事实 + 原文子串作证据，规则版是整段流水。

模型网关：`model.ts` 只描述 endpoint（本机 Magpie `http://127.0.0.1:3425/v1`，OpenAI 兼容、免 key），默认 `deepseek/deepseek-flash` + `reasoning_effort: none`，首字 0.9–1.8 s。会话循环由 `session.ts` 交给 pi-agent-core 的 `Agent`，不再自写 loop。理由见 ADR-0009 / ADR-0010 / ADR-0011。
