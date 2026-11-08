# 总览

eta 是一个人用来指挥多个智能体的工作台。服务端是**一个 Bun 进程**（`apps/eta`，下称主 node 或 host）：它承载 Web、产品数据、模型凭据和记忆边车的入口。别的机器上可以再跑一个精简的 daemon（`apps/daemon`），让会话在那里运行。

```
浏览器 (apps/web)
   │  一条 WebSocket：/ws（管道协议）          HTTP：静态页、/up、/version、/preview、/share
   ▼
主 node  apps/eta                              ← 唯一的进程；SQLite + 文件在一个数据目录里
   ├─ 上游地板  packages/eta-server：sessions、providers、settings、personas
   ├─ 产品插件  agents machines projects conversations inbox usage tasks artifacts routines [memory] [llm]
   ├─ LLM 网关  apps/eta/src/llm：CLIProxyAPI 子进程（@cpajs/cpa）与账号、目录、额度（订阅账号、Gemini key）
   ├─ 读网页    apps/eta/src/web：web_fetch / web_search，进程内调用 sex 库；托管的 SearXNG 是子进程（见 [读网页与搜索](web.md)）
   ├─ 本机会话  harness（packages/eta-core、eta-harness…）直接在进程里跑
   │
   ├──── /machines/connect（WSS，daemon 反向拨入）──▶ eta-daemon（别的机器：只跑会话）
   └──── HTTP（loopback）────────────────────────▶ 记忆边车 apps/memory（Python + PostgreSQL/pgvector，可选）
```

## 进程

| 进程           | 位置          | 作用                                                                                                                             |
| -------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| host           | `apps/eta`    | 唯一必需的进程。`bun apps/eta/src/main.ts`，开发时 `bun run dev`                                                                 |
| web 开发服务器 | `apps/web`    | 只在开发时需要（vite，把 `/ws` 代理给 host）。生产由 host 直接提供构建好的静态页（打包的 host 自带，`--web-dir` 可指定别的目录） |
| eta-daemon     | `apps/daemon` | 可选，每台额外的机器一个。`bun build --compile` 出的单文件，不含 Web、数据库、产品插件和模型配置                                 |
| 记忆边车       | `apps/memory` | 可选。Python（mem0 + fastembed），自己的 PostgreSQL（pgvector）。没有它，host 不挂载记忆，界面隐藏记忆页                         |
| eta（TUI）     | `apps/tui`    | 可选，终端界面。`bun build --compile` 出的单文件，经 `/ws` 连一个 host；也能自己起一个随它退出的临时 host，见 [TUI](tui.md)      |

没有别的服务：没有控制面、消息队列、容器编排或主库。LLM 网关不是独立服务：CLIProxyAPI 是 host 启动并看管的子进程，随 host 退出（见 [LLM 网关](llm-gateway.md)）。搜索用的 SearXNG 也一样：没给外部地址时，它是 host 在第一次搜索时启动的子进程，随 host 退出（见[读网页与搜索](web.md)）。

## 代码布局

```text
apps/
  eta/        host：入口 main.ts、host.ts（组装）、product.ts（产品插件）、access.ts（访问控制）、
              db.ts + migrations/（SQLite），以及 agents、machines、projects、conversations、inbox、usage、
              memory、tasks、artifacts、routines、plugins、web 各一个目录
  daemon/     eta-daemon：setup / run / install-service
  web/        React 界面，通过 WebSocket 读写
  tui/        终端界面（React + Ink），通过同一条 WebSocket 读写，见 [TUI](tui.md)
  memory/     Python 边车
packages/
  eta-core、eta-harness、eta-compaction、eta-execution(-node)、eta-storage-jsonl   内核与会话的运行
  eta-server、eta-plugin-sdk     上游服务端地板：WebSocket 管道、注册表、状态推送、sessions 等 bundled 插件
  eta-ssh、eta-plugin-ssh、eta-plugin-git   经 SSH 的执行环境与 git 插件
  eta-plugin-akhook   声明式规则（akhook 的配置）与流式规则，见 [akhook](akhook.md)
  eta-mcp             MCP 库：代理工具、懒连接、元数据缓存、直接工具、OAuth，见 [MCP](mcp.md)
  client-wire-proto、client-contracts   线上的帧，以及产品 target 的类型（Web 与 host 共用）
deploy/       Dockerfile、memory.Dockerfile、compose.yaml
```

`packages/eta-*` 来自上游 eta-old（subtree 迁入，已转成本仓库的格式与 lint）。host 直接以源码运行这些包，不需要先构建。

## 分层

1. **地板**（`@eta/server` 的 `assembleServer`）：WebSocket 管道、目标注册表、状态推送、会话管理器、模型与 provider 配置、persona。它不知道任何产品概念，见[线协议](wire-protocol.md)。
2. **产品**（`apps/eta`）：每个功能是一个 cordis 插件，向地板注册自己的 target 与 action，数据在 SQLite。启动顺序是先建产品（它的 hook 是地板的选项），再建地板，最后把插件挂上去（`product.ts` 的 `mount`），全部就位才开始服务。
3. **界面**（`apps/web`）：一条连接、一个按 target 存放 section 的 store，每个 target 一组 hooks。没有 REST。`hello.mounted` 里没有的插件，对应入口隐藏。

## 为什么是这样

- 会话（上游 harness 的 session）按文件存储，已经是成熟的持久化；产品只在其上加一层 SQLite 记账（谁、哪个对话、谁在等谁），不复制会话内容。
- 所有变化都是"表变了，通知 target"，section 的 revision 是读到内容的哈希，不会和数据不一致，也没有版本号要维护。
- 远端机器不是另一套系统，而是同一个会话机制在别处运行；host 把它的状态镜像到自己的 wire 上，浏览器无需知道会话在哪台机器。
