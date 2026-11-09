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
