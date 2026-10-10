# 聊天与运行时架构

本文说明聊天智能体怎样运行：每个智能体一个常驻容器，由它的[环境包](bundles.md)构建，状态在它自己的 Docker 卷上；容器里的 runtime 直接驱动 Codex 的 app-server（JSON-RPC，类型由固定版本的 Codex 生成），控制面经 runtime 的控制接口把工作交给它，runtime 把发生的事发到 NATS。公开契约以 [RFC #1](https://github.com/akarachen/axp/issues/1) 第 3–4 节为准，本文只记录实现取舍和运维要点。

## 组件与进程

| 进程                   | 代码                                                | 职责                                                                                      |
| ---------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 公共 API（`api`）      | `api/chat.go`、`chat/chat.go`                       | 产品接口、SSE、幂等、产品投影与 `ui_event`；工作只写进 PostgreSQL                         |
| 内部 API（`internal`） | `api/internal.go`、`control/gate.go`                | runtime 网关的 forward auth（谁持有这把 key、有没有这个插件），以及 tasks、agenvo 插件    |
| controller             | `control/controller.go`、`dispatch.go`、`events.go` | 唯一持有 Docker socket、唯一能连到 runtime 的进程：构建镜像、运行容器、交付工作、导入事件 |
| NATS JetStream         | stream `AGENT_EVENTS`                               | runtime 发出的事件，按智能体一个 subject                                                  |
| agent runtime（容器）  | `apps/agent-runtime/src`                            | Node 24：驱动 Codex app-server，hono 提供控制接口，事件发到 NATS                          |

代码路径相对于 `apps/control-plane/internal`。公共 API 不在 runtime 网络上，所以它从不直接调用 runtime：它写入命令后 `NOTIFY axp_agent_work`（提交时才送达），controller 收到后立即交付。

## 一条消息的路径

1. `POST /chat/messages` 在一个事务里写入幂等记录、用户消息、助手回复占位和 `agent_command(queued)`，并通知 controller，返回 202。用户消息的 id 可以由客户端给出（见下文[发送](#发送)）。每个智能体最多 20 条在等（`429 QUEUE_FULL`）。
2. controller 的 `Dispatch`：智能体的容器是当前配置、它的 runtime 已经报告启动（`agent.boot_id`），且没有正在执行的命令时，取最早的一条，先在事务里记为已交付（`status = running`、`delivered_at`、`boot_id`），再 `POST /prompt {boot_id, command_id, text, kind}`。
3. runtime 用 `turn/start` 开始一个 turn（`clientUserMessageId` 就是命令 id），Codex 的通知被转换成事件：`turn.started`、`item.updated`（增量文本每 0.3 秒合并一次）、`approval.*`、`turn.steered`、`turn.completed`。
4. 事件发到 `axp.agent.<agent>.events`；controller 按顺序读 stream，每批在一个事务里导入 `agent_event` 并投影为消息块和 `ui_event`，同时记下读到的位置（`event_position`），SSE 推给浏览器。导入后唤醒该智能体：turn 结束了，下一条随即交付。

交付的结果：runtime 接受即成功；runtime 连不上、`busy`、`wrong_boot`（这条是给前一次启动的）或 Codex 正在重启时，命令退回等待，稍后再交付；Codex 拒绝时回复以“智能体执行失败”结束；超时（无法确定 turn 是否开始）时以“执行中断”结束并要求中断，绝不重放。

同一批里同一回复连续的 `item.updated` 先在内存里合并，这一段结束时才写一次消息、出一个 revision 和一条 `message.updated`；原始事件仍逐条存进 `agent_event`。重复送达的事件（同一 `(agent, boot, seq)`）只导入一次。字符串里的 NUL 字符在写入 jsonb 前去掉。

停止：命令还在等时直接取消。已交付的记录 `interrupt_requested_at`、回复置为 `stopping`，controller 向 runtime 发 `POST /abort {command_id}`（直到 turn 结束，每 5 秒最多一次）；turn 还没开始时，runtime 记下它，开始时立即中断。runtime 以 `turn.completed(interrupted)` 确认后回复才变为 `stopped`。

压缩：`POST /agents/{id}/compact` 像发消息一样建一条 `/compact` 用户消息和回复，但命令 `kind` 为 `compact`，同样排队、一次一个。runtime 调用 `thread/compact/start`，它在 turn 开始前就返回，turn id 从随后的 `turn/started` 得到，之后与普通 turn 一样流式处理，`contextCompaction` 显示为“压缩上下文”。

确认：Codex 以 `on-request` 审批运行（`/etc/codex/config.toml`）。runtime 接住 `commandExecution` / `fileChange` 的审批请求和 plugin 工具的确认请求（只有字段为空的 MCP elicitation，见[用户确认](user-attention.md)），发出 `approval.requested`；控制面建 `approval` 与 choice `interaction`，回复显示“等待确认”。用户回答后审批变为 `decided`，controller 把决定交给 runtime 的 `POST /decide`（每 5 秒一次，直到 runtime 发出 `approval.applied`），交互才显示 `resolved`。等待中被停止时请求以 `cancel` 应答：命令和文件审批的 `cancel` 本身就中断 turn；plugin 确认的 `cancel` 只表示“用户关掉了提示”，所以 runtime 另外调用 `turn/interrupt`。Codex 自己撤回的请求（`serverRequest/resolved`）同样以 `cancel` 结束。其他服务端请求（权限扩展、带表单字段的 elicitation 等）一律保守拒绝。

插话：`mode: "steer"` 的消息照常写入。有 turn 在运行时，controller 先把它交给 runtime 的 `POST /steer`（只试一次）：Codex 采纳后回显带同一 `clientId` 的 `userMessage`，runtime 发出 `turn.steered`，原命令记为成功，turn 的剩余输出和最终的 `turn.completed` 都归插话命令。turn 结束时仍未回显的已采纳插话同样转交，绝不重跑；还没有应答的，turn 结束时先等它的应答（最多 30 秒）。不被采纳的插话照常等待，轮到时作为普通 turn 执行。

## 发送

用户按下发送时消息就有了身份：Web 生成它的 id，消息立刻出现在对话里（“发送中…”），输入框清空。之后每一次尝试都带着同一个 id，既作为消息 id，也作为 `Idempotency-Key`，因此重试、响应丢失后再发、刷新页面后继续发送都是同一条消息。

- 待送达的消息和每个智能体的草稿保存在浏览器里（`apps/web/src/queries/outbox.ts`，localStorage 的 `axp.chat.v1`），刷新后未送达的会继续发送。同一个智能体的消息按发送顺序一条一条发。
- 没有响应（断网、超时 20 秒）或 5xx 时自动再试，共 4 次；仍不成功，或服务端明确拒绝（4xx），消息标为“未送达”并给出原因，可以“重试”“编辑”或“丢弃”。
- 消息经 SSE 先于响应到达时，按 id 认出它，不会显示两遍。

对话里每个智能体同一时刻只有一行在动：正在执行的回复（“工作中”“正在停止”），或者智能体启动时排在第一条的回复（“正在启动智能体”）；其余等待中的回复是静态的“等待中 · 前面还有 n 条”，可以撤回。因环境原因连续失败的回复只在最后一条写出原因。

## 智能体

所有智能体属于唯一的默认对话。智能体有名称、`description`（指令）、模型和 `bundles`（[环境包](bundles.md)，默认全部内置的）。它的插件是这些环境包的插件之和（`agent.plugins`），runtime 网关按它放行插件的路由。

智能体对外的状态是 `idle`、`starting`（有工作在等它的环境：镜像构建、容器启动）、`working`、`waiting_for_input` 和 `unavailable`（镜像构建失败、runtime 无法启动），由 `RefreshAgentStatus` 从内部状态（`agent.status`：`starting`、`ready`、`error`）和进行中的回复推出。

容器启动所用的一切（镜像、模型、指令）由 controller 每个 tick 算出一份配置摘要，写在容器的标签上：

- 名称、指令、模型或环境包变了（`config_version` 递增），或者某个环境包、插件、runtime 镜像变了（镜像摘要不同），controller 在该智能体没有执行中的工作时替换它的容器，新容器在同一个卷上恢复同一个 thread。替换前不再交付新的命令，所以配置不会在 turn 中途改变，也不会被排队的消息一直拖住。
- 重启（`POST /agents/{id}/restart`）递增 `config_version` 并停止该智能体进行中的回复，中断确认后容器被替换。
- 删除只隐藏智能体：排队的取消、进行中的中断，controller 移除它的容器；卷和历史消息保留。

## runtime

`apps/agent-runtime` 是 TypeScript，`bun build` 打成一个文件，在 `node:24-trixie-slim` 上运行。它自己实现 app-server 的 JSON-RPC 客户端（`src/appserver.ts`，一行一条消息走子进程的 stdio），协议类型由 `bun run generate`（`codex app-server generate-ts`）从 `package.json` 锁定的 `@openai/codex` 生成到 `src/protocol`，不入库；构建镜像时 `scripts/build/image.sh` 把同一个版本传给 Dockerfile 安装，所以镜像里的 Codex 就是生成类型的那一个。升级 Codex 只改 `package.json` 的版本。启动时：

1. 把镜像里编译好的插件装进 `CODEX_HOME`（卷上的 `/agent/codex`）：Codex 只加载装过的副本；上一个镜像装过、这个镜像没有的，卸掉。装好后在副本的 `.mcp.json` 里填入网关地址和工作区。
2. 开始定时刷新 GitHub 凭据（gh 的 `hosts.yml` 和 git 的提交身份，在 `/run/axp`，不在卷上）。
3. 启动 `codex app-server`，用 `thread/list` 找到智能体的 thread：工作区（`/agent/workspace`）里最近更新的根 thread（子智能体的 thread 有 `parentThreadId`，跳过）。有就 `thread/resume`，没有（第一个 turn 之前 Codex 不保存 thread）就 `thread/start`。resume 失败（不是“找不到”）时报告 `runtime.failed(RECOVERY_RESUME_FAILED)`，绝不另起 thread。
4. 在 `:8080` 提供控制接口，发出 `runtime.started {thread_id, resumed}`。

控制接口（hono）只认 controller 的令牌（`HMAC(AXP_SECRET_KEY, control:<agent>)`，`Authorization: Bearer`）：同一网络上的其他 runtime 连得到端口，拿不到令牌。Codex 和智能体执行的命令看不到这个令牌。

| 接口           | 内容                                    | 说明                                                                   |
| -------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| `POST /prompt` | `boot_id`、`command_id`、`text`、`kind` | 开始命令的 turn（`kind: compact` 时压缩）；有 turn 在运行时 `409 busy` |
| `POST /steer`  | `boot_id`、`command_id`、`text`         | 加入运行中的 turn；没有时 `409 no_active_turn`                         |
| `POST /abort`  | `command_id`                            | 中断这个命令的 turn，现在或它开始时                                    |
| `POST /decide` | `approval_id`、`decision`               | 用户对审批的决定（`accept`、`decline`）                                |
| `GET /status`  |                                         | `boot_id`、当前命令和 turn                                             |

`boot_id` 是 runtime 每次启动生成的。prompt 和 steer 必须带上 controller 记下的那一次（`409 wrong_boot`）：Docker 重启了 runtime 而它还没报告时，发给它的命令退回等待，不会在新的启动里被当成旧的。

启动参数（环境变量，`control.spec`）：`AXP_AGENT_ID`、`AXP_AGENT_KEY`（访问 AXP 服务的 key，`<agent>.<HMAC(agent:<agent>)>`）、`AXP_CONTROL_TOKEN`、`AXP_GATEWAY_URL`、`AXP_NATS_URL`、模型服务 `AXP_LLM_BASE_URL`（runtime 网关的 `/v1`，即 LLM 网关）、`AXP_LLM_API_KEY`（智能体的 key）、`AXP_MODEL`、`AXP_MODEL_CONTEXT_WINDOW`、`AXP_INSTRUCTIONS`（名称和指令，作为 Codex 的 developer instructions）、`AXP_CONFIG_VERSION`，以及 OpenTelemetry 的端点和资源属性。容器里没有任何模型服务商的凭据。

Codex 的静态配置是 `danger-full-access` 沙箱、`on-request` 审批：容器是隔离边界，命令和文件改动仍经产品请用户确认；akhook 的规则检查每条命令和每个文件修改（见[工具调用规则与用户确认](agent-hooks.md)）。

## 恢复与隔离

- runtime 不能继续时退出（Codex 退出、插件安装失败、无法恢复 thread），Docker 按重启策略（`unless-stopped`，越来越久的间隔）重新启动它。新的启动发出 `runtime.started` 时，交付给之前启动的命令以“执行中断，无法确认结果，未自动重试”失败，绝不重放；还在等的命令交给新的启动。
- `runtime.failed` 把智能体置为不可用，等待中的回复以中文原因失败（插件：“智能体扩展启动失败”；恢复：“智能体会话无法恢复”）。下一次启动报告成功后恢复可用。
- 镜像构建失败时，智能体不可用，`build_error` 是构建输出的末尾（智能体编辑器里显示），等待中和之后的消息以“智能体环境构建失败”失败；修改智能体、修改环境包或重启后再构建。
- runtime 没发出去的事件在它退出时丢失；它最后的状态以 controller 的处理为准。
- 一个智能体只能读写自己的卷：卷按智能体命名（`axp-agent-<id>`，开发 `axp-dev-agent-<id>`），只挂进它自己的容器；key 和控制令牌都是按智能体派生的。

## 状态

一个智能体的全部状态是它的卷 `/agent`：`workspace/`（工作区，Codex 的 cwd）和 `codex/`（`CODEX_HOME`，含 Codex 的 thread 记录和装好的插件）。没有快照、没有对象存储：容器重建时卷还在，runtime 从卷上恢复 thread。宿主机的卷就是数据，换机器需要自己迁移（`docker volume` 备份）。

## 已知限制

- Codex 在容器内使用 `danger-full-access` 沙箱、`on-request` 审批：容器本身是隔离边界。
- 插话没有进入正在运行的 turn 时，发送的响应不再说明（交付在发送之后才发生），回复照常排队等待。
- 每个智能体的容器常驻，空闲时也占内存（约几百 MB）。
- 幂等记录与 `ui_event` 暂不清理（RFC v1 约定）。
- SSE 每个连接一个 goroutine，每 500 毫秒轮询一次持久事件表。
