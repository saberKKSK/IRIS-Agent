# 01 · 架构

## 三层

```
                 用户 / 环境
                      │
      ┌───────────────┴───────────────┐
      │                               │
   语音输入                        视觉输入
 Microphone                     Camera / Screen / Game
      │                               │
      └───────────────┬───────────────┘
                      │
              ┌───────▼────────┐
              │  感知层         │  VAD·ASR·抽帧·CV 事件·游戏状态
              │  iris-perception│
              └───────┬────────┘
                      │  PerceptionEvent
              ┌───────▼────────┐
              │  Agent Core    │  persona · memory · attention · planning · mood
              │  iris-core     │
              └───────┬────────┘
                      │  ActionRequest
              ┌───────▼────────┐
              │  授权闸门       │  consent（fail-closed）
              └───────┬────────┘
                      │
              ┌───────▼────────┐
              │  Action Router │
              └───┬────┬───┬───┘
                  │    │   │
               Gaming 娱乐  生活
                  │    │   │
              游戏操作 直播 电话
              游戏理解 唱歌 地图
              陪玩    内容  ADB/手机
                  └────┴───┘
                      │ 结果回灌
                Agent Core（更新情绪与记忆）
```

## 三条时间线（最重要的设计约束）

| 车道 | 预算 | 跑什么 | 失败代价 |
|---|---|---|---|
| realtime | ≤ 300 ms 首字 | 语音识别增量、插话判断、情绪反馈、短句应答、打断 | 卡顿即"她死了" |
| async | 1–10 s | VLM 画面理解、游戏策略、行程查询、长回复 | 答得慢，但可接受 |
| background | 分钟级 | 主动互动决策、记忆整理、账号运营、定时观察 | 无感，可延后 |

代码落点：`packages/iris-core/src/attention.ts`。`laneFor()` 决定每个事件的归属，`AttentionScheduler` 保证实时车道饿死异步车道、后台只在安静时运行。

**不要做的事**：把每一帧画面丢给多模态大模型。视觉流必须先抽帧、再做 CV 事件检测（运动、场景切换、人脸、物体），只有"值得说一句"的帧才升级为 VLM 理解，并带上时间戳。

## 六个子系统的代码落点

| 子系统 | 现在 | 下一步 |
|---|---|---|
| 人格与陪伴 | `iris-core/src/persona.ts`（prompt 组装）、`types.ts`（Persona/Relationship/Mood） | 关系事件写入、情绪衰减 |
| 记忆 | `iris-core/src/memory.ts`（Episode + 检索） | SQLite 持久化、向量召回、遗忘曲线 |
| 实时语音 | — | `iris-voice`：流式 ASR、TTS、barge-in 状态机 |
| 视觉感知 | `user.look` 事件已定义 | `iris-perception`：抽帧、CV 事件、VLM 描述 |
| 游戏/环境 | `game.state` 事件已定义 | `iris-actions`：键盘鼠标/手柄注入、游戏状态读取适配器 |
| 外部行动 | `consent.ts` 已定义策略 | SIP 电话、ADB 手机、直播推流 |
| 会话 | `session.ts`（pi `Agent` 承载） | 工具注册、steering、跨会话持久化 |

## 与 pi 的复用边界（2026-11-09 起：全量 fork，见 ADR-0010）

这个仓库就是我们的仓库：`origin` = `saberKKSK/IRIS-Agent`，`upstream` = `badlogic/pi-mono`（只 fetch）。
**能有既有实现就直接用；需要不同行为就直接改上游源码。** 不追求"零依赖"。

直接复用（已接）：

- `@earendil-works/pi-ai` → `model.ts` + `session.ts` 走 `streamSimple`，SSE 解析、usage 归一化、key 校验、超时全交给它。
- `@earendil-works/pi-agent-core` → `session.ts` 用 `Agent` 承载会话：多轮 transcript、工具执行、重试、steering、中断、事件流都不自己实现（见 ADR-0011）。
- `@earendil-works/pi-schema` / `pi-mcp`：工具参数校验与 MCP 工具接入。

仍需注意、不要整包照搬：

- `pi-coding-agent` 的 TUI 与交互模型（为写代码设计，不是为陪人）。
- 它的权限模型（面向文件读写，不是面向"给真人打电话"），授权仍走 `iris-core/src/consent.ts`。

改动纪律：改上游文件时，把"改了哪个文件、为什么"记进 `03-decisions.md`；合并 upstream 时按「保我们的行为、拿上游的结构」处理。

## 数据契约

`PerceptionEvent`（进）：

```ts
{ kind: "user.speech"; text; confidence; partial }      // 语音增量
{ kind: "user.look"; subject; summary; frameRef }        // 视觉事件（已由 CV 过滤）
{ kind: "game.state"; game; phase; objective; health }   // 游戏适配器读取
{ kind: "device.presence"; device; online }               // 设备在场
{ kind: "clock.tick"; localHour; localMinute }            // 时间
{ kind: "user.idle"; idleMinutes }                        // 沉默
```

`ActionRequest`（出）：`speak` / `initiate` / `game.input` / `call` / `post` / `remember`。

新增能力只允许通过扩展这两个联合类型实现，禁止旁路（否则授权闸门会被绕过）。

## 会话层（2026-11-09 换芯）

`packages/iris-core/src/session.ts`：`IrisSession` 只做四件事——拼人格 prompt、`agent.prompt()`、把 `AgentEvent` 翻译成 `IrisSessionEvent`、把这一轮写回记忆。其余全归 pi。

| 关注点 | 归谁 |
|---|---|
| 多轮上下文、消息类型、transcript 归一化 | `pi-agent-core` 的 `Agent` |
| 工具调用、重试、steering / followUp / abort | `Agent` |
| 流式增量、reasoning 增量 | `Agent` 的 `message_update` 事件 |
| 人格 prompt 组装 | `iris-core/src/persona.ts` |
| 关系推进、记忆写入 | `iris-core/src/session.ts`（`say()` 收尾） |
| 错误语义 | `stopReason: "error" | "aborted"` → 抛 `IrisSessionError`，不吞 |

`streamFn` 必须走 `lazyStream(...)` 包装：pi 的 `StreamFn` 契约是「不许抛、不许返回 rejected promise」，`lazyStream` 会把同步抛出的连接错误翻成 `{type:"error"}` 事件 + `stopReason:"error"` 的 assistant 消息。

## 模型网关（2026-11-09 已接）

`packages/iris-core/src/model.ts`：只描述 endpoint 与参数，`magpieModel()` 按 pi 的 `Model<"openai-completions">` 造模型对象，指向本机 Magpie（OpenAI 兼容，`http://127.0.0.1:3425/v1`，免 key，但 pi 要求非空 key，故填占位 `magpie`）。

| 项 | 值 |
|---|---|
| 默认模型 | `deepseek/deepseek-flash`（直连 DeepSeek） |
| reasoning | `reasoning_effort: "none"`（放在 `samplingParams`），否则首字被 reasoning 吃掉 1.5–3 s |
| 实测 | 首字 0.9–1.8 s，整轮 1.1–2.0 s（同句短回复，网关侧有波动） |
| 覆盖 | `MAGPIE_BASE_URL` / `MAGPIE_MODEL` 环境变量，或 `createSession({ model, baseUrl })` |
| 依赖 | `@earendil-works/pi-ai@1.5.0` + `@earendil-works/pi-agent-core@1.5.0`；两个包的 exports 都指向 `dist/`，**没 build 过就 import 不到** |

注意：路由组 `auto/deepseek-v4.1-flash` 对短回复经常只吐 reasoning、content 为空，**实时车道不要用它**。1 s 仍超 300 ms 预算，所以实时车道的前 300 ms 必须由「语气回执 + 早已生成的下一句」撑住，不能用等模型的方式实现（见 02-roadmap Phase 1 语音环）。

## 语音的插话模型

全双工不等于"一直开着麦克风"：需要 VAD 分段 + 回声消除 + TTS 播放期间的关键词门（听到自己的名字或"等一下"就半句停下）。目标是"可以打断"，而不是"永远在听"。
