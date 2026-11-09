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

代码起点：`packages/iris-core`（已可运行，35 个测试）。

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
node --test test/*.test.ts                    # 35/35
node examples/demo-day.ts                     # 离线：一天的时间线
node examples/live-turn.ts "今天下班有点累"      # 真模型：走本机 Magpie
```

模型网关：`model.ts` 只描述 endpoint（本机 Magpie `http://127.0.0.1:3425/v1`，OpenAI 兼容、免 key），默认 `deepseek/deepseek-flash` + `reasoning_effort: none`，首字 0.9–1.8 s。会话循环由 `session.ts` 交给 pi-agent-core 的 `Agent`，不再自写 loop。理由见 ADR-0009 / ADR-0010 / ADR-0011。
