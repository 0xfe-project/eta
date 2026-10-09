# 聊天与运行时架构

本文说明 [RFC #1](https://github.com/akarachen/axp/issues/1) 的实现方式。公开契约以 RFC 第 3–4 节为准，本文只记录实现取舍和运维要点。

## 组件与进程

控制面（`apps/control-plane`，Go，见[控制面](control-plane.md)）是一个二进制、三个进程；代码路径相对于 `apps/control-plane/internal`。

| 进程                       | 代码                                                           | 职责                                                                         |
| -------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 公共 API（`api`）          | `api/chat.go`、`chat/chat.go`                                  | 产品接口、SSE、幂等、产品投影与 `ui_event`                                   |
| 内部运行协议（`internal`） | `api/internal.go`、`control/protocol.go`、`chat/projection.go` | runtime → 控制面：心跳、会话注册、事件批次、快照上传地址、runtime 身份       |
| controller                 | `control/controller.go`、`container`                           | 唯一持有 Docker socket：为有工作的 Agent 启动、换代、停止容器                |
| 队列（NATS JetStream）     | `queue`                                                        | 把命令、中断、审批结果送到 Agent 的 runtime，见[队列](queue.md)              |
| agent runtime（容器）      | `apps/agent-runtime/axp_runtime`                               | 一个 Agent 一个容器；从队列取工作，官方 Codex Python SDK 驱动一个持久 thread |

公共 API 与内部运行协议是两个独立的 HTTP 服务（`/api` 与 `/internal`），各有自己的 OpenAPI；公共服务不路由任何 `/internal` 路径，runtime 只能经 [runtime 网关](gateway.md) 访问内部服务。公共响应与 SSE 只来自 `chat/public.go` 里的允许列表（前端类型由它生成），测试会检查其中不出现 command、thread、runtime、generation 等内部字段。

## 一条消息的路径

1. `POST /chat/messages` 在一个事务里写入幂等记录、用户消息、助手回复占位、`agent_command(queued)` 和产品事件，并把命令发布到该 Agent 的[队列](queue.md)，返回 202。用户消息的 id 可以由客户端给出（`id`，每条消息一个新的 UUID），Web 同时用它作为 `Idempotency-Key`（见下文[发送](#发送)）。插话时响应的 `steered` 说明它是否进了正在运行的 turn。
2. controller 发现 Agent 的队列里有命令而它没有存活实例：`generation + 1`，写 `runtime_instance`，再在事务外启动容器；Agent 有快照时附上它的下载地址。token 由 `HMAC(SECRET_KEY, instance_id:generation)` 派生，换代即失效。
3. runtime 启动：下载并解开 Agent 的快照（有的话）→ 安装镜像里的 Codex plugin（见下文）→ 启动 Codex app-server → 用控制面记录的 thread id 恢复（只有首次才 `thread/start`；无法恢复时报告 `recovery_failed`，绝不另起 thread）→ 心跳报告 ready → 开始读队列。
4. runtime 空闲时从队列取一条命令，确认后执行；一次一条（部分唯一索引兜底）。
5. runtime 先记账再调用 `turn/start`；Codex 通知被转换成有序 outbox 事件（`turn.started`、`item.updated`、`approval.*`、`turn.completed` 等），增量文本每 0.3 秒合并一次。turn 结束后先上传快照（见下文），再发出 `turn.completed`。
6. 内部事件接口按 `source_seq` 连续导入 `agent_event`（缺口返回 `409 EVENT_GAP` 与下一期望序号，重复事件幂等，内容不同则冲突），同事务内投影为消息块、交互和 `ui_event`，SSE 推给浏览器。

停止：命令还在队列里时从队列删除，直接取消。已被 runtime 取走的记录 `interrupt_requested_at`、回复置为 `stopping`，并发给 runtime 一条中断；runtime 以 `turn.completed(interrupted)` 确认后回复才变为 `stopped`。仍在 `stopping` 时再点停止会再发一次。

压缩：`POST /agents/{id}/compact` 像发消息一样建一条 `/compact` 用户消息和回复，但命令 `kind` 为 `compact`，同样排队、一次一个。runtime 调用 `thread/compact/start`，它在 turn 开始前就返回，turn id 从随后的 `turn/started` 得到，之后与普通 turn 一样流式处理，`contextCompaction` 显示为“压缩上下文”。

插话：`POST /chat/messages` 带 `mode: "steer"` 时，命令照常排队，但输入带 `steer` 标记。控制面先问 runtime 正在运行的 turn 是否接受；runtime 以插话命令 id 作为 `clientUserMessageId` 调用 `turn/steer`。Codex 采纳后回显带同一 `clientId` 的 `userMessage`，runtime 此时发出 `turn.steered`：原命令记为成功，turn 的剩余输出和最终的 `turn.completed` 都归插话命令，因此插话后的回答显示在插话消息之下。turn 结束时仍未回显的已采纳插话同样转交，绝不重跑。没有运行中的 turn（或 Codex 拒绝）时插话照常入队，轮到时作为普通 turn 执行。停止已送达的插话不会直接取消，而是等它接手 turn 后中断。

确认：runtime 用 SDK 的审批回调接住 `commandExecution` / `fileChange` 审批请求和 plugin 工具的确认请求（MCP elicitation，见[用户确认](user-attention.md)），生成 `approval.requested`；控制面建 `approval` 与 choice `interaction`。用户回答后审批变为 `decided`，决定作为控制消息发给 runtime（再次给出同样的回答会重发），runtime 回调返回后发出 `approval.applied`，交互才显示 `resolved`。等待中被停止时回调以 `cancel` 结束，同时中断该 turn。其他服务端请求（权限扩展、带表单字段的 elicitation 等）一律保守拒绝。

## 发送

用户按下发送时消息就有了身份：Web 生成它的 id，消息立刻出现在对话里（“发送中…”），输入框清空。之后每一次尝试都带着同一个 id，既作为消息 id，也作为 `Idempotency-Key`，因此重试、响应丢失后再发、刷新页面后继续发送都是同一条消息，服务端返回第一次的结果，不会多出一条。

- 待送达的消息和每个智能体的草稿保存在浏览器里（`apps/web/src/queries/outbox.ts`，localStorage 的 `axp.chat.v1`），刷新后未送达的会继续发送。同一个智能体的消息按发送顺序一条一条发。
- 没有响应（断网、超时 20 秒）或 5xx 时自动再试，共 4 次；仍不成功，或服务端明确拒绝（4xx），消息标为“未送达”并给出原因，可以“重试”（同一条）、“编辑”（回到输入框，作为新消息发送）或“丢弃”。
- 消息经 SSE 先于响应到达时，按 id 认出它，不会显示两遍。
- 插话没有进入正在运行的 turn 时，提示它已改为排队。

对话里每个智能体同一时刻只有一行在动：正在执行的回复（“工作中”“正在停止”），或者智能体启动时排在第一条的回复（“正在启动智能体”）；其余等待中的回复是静态的“等待中 · 前面还有 n 条”，可以撤回。因环境原因（`AGENT_*`、`START_TIMEOUT`）连续失败的回复只在最后一条写出原因；失败的回复都可以“重新发送”，发的是一条新消息。SSE 断开、正在重连时，对话顶部提示状态可能不是最新的。

## 智能体

AXP 是单用户服务，所有智能体属于唯一的默认对话（`conversation.is_default`），首次创建智能体时建立。

智能体对外的状态是 `idle`（空闲）、`starting`（有工作在等它的环境：容器启动、快照下载、恢复会话）、`working`、`waiting_for_input` 和 `unavailable`，由 `RefreshAgentStatus` 从内部状态和进行中的回复推出。

智能体有名称、`description`（指令）、模型和 `plugins`（启用的 plugin 名，见下文 [Plugin](#plugin)）。指令原样作为 Codex 的 `developerInstructions` 在 `thread/start` 和 `thread/resume` 时注入。运行时启动所用的一切配置（模型、指令、plugin）都由 `agent.config_version` 版本化：修改后版本递增；controller 在该智能体没有进行中的执行时停止旧实例（`CONFIG_CHANGED`），下一个实例用新配置恢复同一 thread，因此配置不会在 turn 中途改变。以后给智能体增加的、影响运行时的设置应走同一条路径。重启（`POST /agents/{id}/restart`，设置里的“重启”）也走这条路径：递增 `config_version` 并停止该智能体所有进行中的回复，中断确认后旧实例即被替换。

除 RFC 第 3 节的接口外，公开 API 提供 `GET /plugins`（镜像的 plugin 目录，控制面从生产镜像里一同复制的 `apps/agent-runtime/plugins` 读出）、`POST /agents`（`name`、`description`、`model`、`plugins`，省略 `plugins` 即全部）、`PATCH /agents/{id}`（部分更新）和 `DELETE /agents/{id}`。删除不抹掉数据：智能体被标记为已删除并从列表中隐藏，排队消息取消、进行中的回复被中断，历史消息保留；controller 等执行停下后停止并移除其容器，之后不再启动。快照保留。删除通过 `agent.deleted` 事件（`{agent_id}`）通知前端。

## 消息历史

历史按智能体分页：`GET /agents/{id}/messages?before=&limit=` 从最新一页往回翻（默认 50 条，最多 100），每页按发送顺序排列，`next_cursor` 是指向更早消息的签名游标，走 `(agent_id, seq)` 索引。`GET /chat` 快照不再带消息，只带智能体、进行中的回复、待处理交互和事件游标。

前端分两层合成一个智能体的时间线：快照之后经 SSE 和写接口到达的消息叠在 `["chat"]` 缓存里（起点是进行中的回复），历史页在 `["chat", "messages", agentId]` 无限查询里；渲染时按 id 去重、取较高 revision。历史页总是在快照之后读取，与叠加层之间不会有缺口；SSE 断开后重拉快照时，同一前缀下的历史查询一起失效重拉。

## 恢复与隔离

- 心跳续租（默认 30 秒）。租约过期时 controller 先停止并移除旧容器，再结束实例；之后旧实例的任何请求都得到 `409 STALE_GENERATION`，runtime 收到后立即退出。
- 实例结束时，容器连同上次快照之后的改动一起消失；它从队列取走的命令以“执行中断，无法确认结果，未自动重试”失败，绝不重放。仍在队列里的命令由下一个实例执行。
- Codex 进程在 turn 中途退出时，该命令同样以执行中断失败，实例报告 `error`。
- plugin 安装失败（`PLUGIN_INSTALL_FAILED`，回复显示“智能体扩展启动失败”）、快照无法下载或解开等使 runtime 停在未就绪状态；排队与派发中的回复以中文原因失败，Agent 显示为“不可用”。之后的新消息会让 controller 换一代实例重试；从未就绪过的实例有 30 秒的退避。
- 实例 120 秒内没有就绪时，该 Agent 的队列被清空，等待中的消息以“准备超时”失败。
- 空闲超过 10 分钟的实例会被停止；下一条消息会重新拉起，从快照恢复同一 thread。

## 快照

一个 Agent 的全部状态是容器里的 `/agent`：`workspace/`（工作区，Codex 的 cwd）和 `codex/`（`CODEX_HOME`）。它的快照是 S3 桶 `axp-agents` 里的一个对象 `agents/<id>/snapshot.tar.zst`，即这个目录的 tar 包，用多线程 zstd 压缩（Codex 的锁文件、`tmp` 和已安装的 plugin `codex/plugins/cache` 除外）。

- 每个 turn（包括压缩、被停止和失败的 turn）结束后，runtime 打包并上传快照，然后才发出 `turn.completed`。因此控制面看到命令结束时快照已经写完，空闲停机、换配置停机都不会打断上传，也不会丢掉已完成 turn 的改动。
- 上传地址由 `POST /internal/v1/runtime-instances/{id}/snapshot` 签发，只指向该实例所属 Agent 的对象，已失效的实例拿不到地址。runtime 不持有任何存储凭据，容器不挂载任何卷，也不需要额外权限。
- 上传失败或超过 2 GiB 时 runtime 发出 `snapshot.failed`，控制面把原因记在 `agent_session.last_error`，直到下一次 `snapshot.saved`；turn 照常完成，下一次快照会带上全部改动。
- controller 启动实例前检查对象是否存在，存在就把预签名下载地址交给 runtime；下载或解包失败时实例以 `RECOVERY_*` 报告 `recovery_failed`。
- 账本（命令、审批、outbox）只在实例内存里，不进快照。
- 两个 turn 之间后台进程写入的文件，在下一次快照时才会保存；宿主机崩溃会丢掉正在执行的那个 turn 的改动。

## Plugin

智能体的扩展（MCP、skill、hook）一律是[插件](plugins.md)：一个与 harness 无关的目录，标了 `chat` 目标的插件在构建镜像时编译成 Codex plugin（`axp-plugins chat`，见[插件](plugins.md#chat-目标编译成-codex-plugin)）。每个智能体从镜像里的同一套中选择要装哪些（`agent.plugins`，默认全部）。

静态的 `config.toml` 另外规定：容器是隔离边界，Codex 不再用沙盒（`danger-full-access`）；命令和文件改动仍经产品请用户确认（`on-request`）。

### 启动

runtime 每次启动、在 Codex 之前对选中的每个 plugin 执行 `codex plugin add <name>@axp`（marketplace 用 `--config marketplaces.axp.*` 指向镜像目录）。Codex 只加载装进 `CODEX_HOME/plugins/cache` 的副本，仅在配置里启用不生效；已安装的副本不进快照，每次都以镜像为准；但快照里的 Codex 配置仍记着上次启用的 plugin，没选中却仍启用的会用 `codex plugin remove` 卸掉。安装后在副本的 `.mcp.json` 里填入本实例的 `${AXP_GATEWAY_URL}` 和 `${AXP_WORKSPACE_DIR}`：Codex 不展开其中的变量，而网关地址在开发和生产中不同。plugin 的 stdio MCP 只拿到 `.mcp.json` 里写明的环境变量（`env`，或用 `env_vars` 从 Codex 的环境透传，实例 key 只能这样传，不能写进会进快照的文件），`cwd: "."` 指 plugin 目录。MCP 启动失败只记日志，不影响 runtime 就绪。

现有插件见[插件](plugins.md#现有插件)。`grok` 的细节：[grok-api](https://github.com/AkaraChen/grok-api) 的 stdio MCP（`setup` 装固定版本的 release），Grok Imagine 生成图像和视频、网页和 X 搜索。`--base-url` 指向 runtime 网关的 `/v1`，以实例 key 作为 `XAI_API_KEY`；CPA 自己转发 xAI 的 `/v1/images/*`、`/v1/videos/*` 和带 `web_search` / `x_search` 的 `/v1/responses`，用的是模型服务里绑定的 Grok 账号，容器里没有 xAI 凭据。没有绑定 Grok 账号时工具调用失败。

## 存储与隔离

- 开发与生产各有一套 SeaweedFS 和 runtime 网络（`axp-dev-s3` / `axp-runtime` 与 `axp-s3` / `axp-prod-runtime`），开发新建的容器以 `axp-dev-` 开头，互不可见。
- 一个 Agent 只能读写自己的快照：容器里没有挂载，没有共享文件系统，也没有存储凭据。
- runtime 网络上只有 SeaweedFS 的 S3 端口可达（生产经 `s3-proxy`，开发只发布 8333），它的 filer、master、volume 等不鉴权的接口连不到，绕不开预签名地址（见[网关](gateway.md)）。

## 已知限制

- Codex 在容器内使用 `danger-full-access` 沙箱、`on-request` 审批：容器本身是隔离边界。
- Agent 能读到自己快照的上传地址，因此可以改写自己的快照，但碰不到其他 Agent 的。
- 幂等记录与 `ui_event` 暂不清理（RFC v1 约定）。
- 开发用 `runserver` 以线程处理 SSE，每个连接占一个线程；生产应使用 ASGI 服务与 PostgreSQL `LISTEN/NOTIFY` 唤醒（当前为轮询持久事件表）。
- 自动化测试使用脚本化的 app-server（`axp_runtime.testing.fake_app_server`）；与真实模型的联调需要在“模型服务”中绑定账号。
