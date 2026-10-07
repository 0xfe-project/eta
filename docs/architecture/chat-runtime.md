# 聊天与运行时架构

本文说明 [RFC #1](https://github.com/akarachen/axp/issues/1) 的实现方式。公开契约以 RFC 第 3–4 节为准，本文只记录实现取舍和运维要点。

## 组件与进程

| 进程                   | 代码                              | 职责                                                                                       |
| ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| 公共 API（Django）     | `chat/api.py`、`chat/services.py` | 7 个产品接口、SSE、幂等、产品投影与 `ui_event`                                             |
| 内部运行协议（Django） | `chat/control/internal_api.py`    | runtime → 控制面：心跳、会话注册、事件批次、快照上传地址、runtime 身份。独立进程与 URLconf |
| controller             | `chat/control/controller.py`      | 唯一持有 Docker socket：启动/隔离容器、派发命令、中断、审批送达                            |
| agent runtime（容器）  | `apps/agent-runtime/axp_runtime`  | 一个 Agent 一个容器；官方 Codex Python SDK 驱动一个持久 thread                             |

公共服务的 URLconf（`config.urls`）不包含任何 `/internal` 路由；内部服务以 `AXP_URLCONF=config.internal_urls` 启动，runtime 只能经 [runtime 网关](gateway.md) 访问它，有单独的 OpenAPI。公共响应、SSE 与前端类型只来自 `chat/schemas.py` 的手写允许列表，测试会检查其中不出现 command、thread、runtime、generation 等内部字段。

## 一条消息的路径

1. `POST /chat/messages` 在一个事务里写入幂等记录、用户消息、助手回复占位、`agent_command(queued)` 和产品事件，返回 202。
2. controller 发现有排队命令而 Agent 没有存活实例：`generation + 1`，写 `runtime_instance`，生成 MCP 配置快照，再在事务外启动容器；Agent 有快照时附上它的下载地址。token 由 `HMAC(SECRET_KEY, instance_id:generation)` 派生，换代即失效。
3. runtime 启动：下载并解开 Agent 的快照（有的话）→ 启动 Codex app-server → 用控制面记录的 thread id 恢复（只有首次才 `thread/start`；无法恢复时报告 `recovery_failed`，绝不另起 thread）→ 等待必需的 MCP 模块就绪 → 心跳报告 ready。
4. controller 认领该 Agent 最早的排队命令（每个 Agent 同时只有一个活动执行，由部分唯一索引兜底），`PUT /internal/v1/commands/{id}`。PUT 幂等，未见响应时会重发。
5. runtime 先记账再调用 `turn/start`；Codex 通知被转换成有序 outbox 事件（`turn.started`、`item.updated`、`approval.*`、`turn.completed` 等），增量文本每 0.3 秒合并一次。turn 结束后先上传快照（见下文），再发出 `turn.completed`。
6. 内部事件接口按 `source_seq` 连续导入 `agent_event`（缺口返回 `409 EVENT_GAP` 与下一期望序号，重复事件幂等，内容不同则冲突），同事务内投影为消息块、交互和 `ui_event`，SSE 推给浏览器。

停止：公共接口只记录 `interrupt_requested_at` 并把回复置为 `stopping`；controller 发 `POST …/interrupt`；runtime 以 `turn.completed(interrupted)` 确认后回复才变为 `stopped`。命令仍在队列中时直接取消。

压缩：`POST /agents/{id}/compact` 像发消息一样建一条 `/compact` 用户消息和回复，但命令 `kind` 为 `compact`，同样排队、一次一个。runtime 调用 `thread/compact/start`，它在 turn 开始前就返回，turn id 从随后的 `turn/started` 得到，之后与普通 turn 一样流式处理，`contextCompaction` 显示为“压缩上下文”。

插话：`POST /chat/messages` 带 `mode: "steer"` 时，命令照常排队，但输入带 `steer` 标记。controller 发现该 Agent 有正在运行的 turn 时 `POST /internal/v1/commands/{运行中命令}/steer`（3 秒内不重发），runtime 以插话命令 id 作为 `clientUserMessageId` 调用 `turn/steer`。Codex 采纳后回显带同一 `clientId` 的 `userMessage`，runtime 此时发出 `turn.steered`：原命令记为成功，turn 的剩余输出和最终的 `turn.completed` 都归插话命令，因此插话后的回答显示在插话消息之下。turn 结束时仍未回显的已采纳插话同样转交，绝不重跑。没有运行中的 turn（或 Codex 拒绝）时插话留在队列里，轮到时作为普通 turn 执行。停止已送达的插话不会直接取消，而是等它接手 turn 后中断。

确认：runtime 用 SDK 的审批回调接住 `commandExecution` / `fileChange` 审批请求，生成 `approval.requested`；控制面建 `approval` 与 choice `interaction`。用户回答后审批变为 `decided`，controller 送达，runtime 回调返回后发出 `approval.applied`，交互才显示 `resolved`。等待中被停止时回调以 `cancel` 结束，同时中断该 turn。其他服务端请求（权限扩展、MCP elicitation 等）一律保守拒绝。

## 智能体

AXP 是单用户服务，所有智能体属于唯一的默认对话（`conversation.is_default`），首次创建智能体时建立。

智能体目前有名称和 `description`（指令）。指令原样作为 Codex 的 `developerInstructions` 在 `thread/start` 和 `thread/resume` 时注入。运行时启动所用的一切配置（指令、MCP 绑定）都由 `agent.config_version` 版本化：修改后版本递增；controller 在该智能体没有进行中的执行时停止旧实例（`CONFIG_CHANGED`），下一个实例用新配置恢复同一 thread，因此配置不会在 turn 中途改变。以后给智能体增加的、影响运行时的设置应走同一条路径。

除 RFC 第 3 节的接口外，公开 API 提供 `POST /agents`（`name`、`description`）、`PATCH /agents/{id}`（部分更新）和 `DELETE /agents/{id}`。删除不抹掉数据：智能体被标记为已删除并从列表中隐藏，排队消息取消、进行中的回复被中断，历史消息保留；controller 等执行停下后停止并移除其容器，之后不再启动。快照保留。删除通过 `agent.deleted` 事件（`{agent_id}`）通知前端。

## 消息历史

历史按智能体分页：`GET /agents/{id}/messages?before=&limit=` 从最新一页往回翻（默认 50 条，最多 100），每页按发送顺序排列，`next_cursor` 是指向更早消息的签名游标，走 `(agent_id, seq)` 索引。`GET /chat` 快照不再带消息，只带智能体、进行中的回复、待处理交互和事件游标。

前端分两层合成一个智能体的时间线：快照之后经 SSE 和写接口到达的消息叠在 `["chat"]` 缓存里（起点是进行中的回复），历史页在 `["chat", "messages", agentId]` 无限查询里；渲染时按 id 去重、取较高 revision。历史页总是在快照之后读取，与叠加层之间不会有缺口；SSE 断开后重拉快照时，同一前缀下的历史查询一起失效重拉。

## 恢复与隔离

- 心跳续租（默认 30 秒）。租约过期时 controller 先停止并移除旧容器，再结束实例；之后旧实例的任何请求都得到 `409 STALE_GENERATION`，runtime 收到后立即退出。
- 实例结束时，容器连同上次快照之后的改动一起消失；其上的执行中命令以“执行中断，无法确认结果，未自动重试”失败，绝不重放。排队中的命令不受影响，由下一个实例执行。
- Codex 进程在 turn 中途退出时，该命令同样以执行中断失败，实例报告 `error`。
- 必需 MCP 失败、快照无法下载或解开等使 runtime 停在未就绪状态；排队与派发中的回复以中文原因失败，Agent 显示为“不可用”。之后的新消息会让 controller 换一代实例重试；从未就绪过的实例有 30 秒的退避。
- 排队超过 120 秒仍没有就绪实例的消息以“准备超时”失败。
- 空闲超过 10 分钟的实例会被停止；下一条消息会重新拉起，从快照恢复同一 thread。

## 快照

一个 Agent 的全部状态是容器里的 `/agent`：`workspace/`（工作区，Codex 的 cwd）和 `codex/`（`CODEX_HOME`）。它的快照是 S3 桶 `axp-agents` 里的一个对象 `agents/<id>/snapshot.tar.zst`，即这个目录的 tar 包，用多线程 zstd 压缩（Codex 的锁文件和 `tmp` 除外）。

- 每个 turn（包括压缩、被停止和失败的 turn）结束后，runtime 打包并上传快照，然后才发出 `turn.completed`。因此控制面看到命令结束时快照已经写完，空闲停机、换配置停机都不会打断上传，也不会丢掉已完成 turn 的改动。
- 上传地址由 `POST /internal/v1/runtime-instances/{id}/snapshot` 签发，只指向该实例所属 Agent 的对象，已失效的实例拿不到地址。runtime 不持有任何存储凭据，容器不挂载任何卷，也不需要额外权限。
- 上传失败或超过 2 GiB 时 runtime 发出 `snapshot.failed`，控制面把原因记在 `agent_session.last_error`，直到下一次 `snapshot.saved`；turn 照常完成，下一次快照会带上全部改动。
- controller 启动实例前检查对象是否存在，存在就把预签名下载地址交给 runtime；下载或解包失败时实例以 `RECOVERY_*` 报告 `recovery_failed`。
- 账本（命令、审批、outbox）只在实例内存里，不进快照。
- 两个 turn 之间后台进程写入的文件，在下一次快照时才会保存；宿主机崩溃会丢掉正在执行的那个 turn 的改动。

## MCP

`mcp_module_revision` 由部署方注册（`manage.py mcp_register spec.json`，内置 `tasks` 模块由迁移注册），只接受 `command`/`args`/`env`，修订不可变。`agent_mcp_binding` 的配置按模块的 JSON Schema 校验，密钥只存 `env:NAME` 引用（`manage.py mcp_bind`）。新 Agent 默认绑定内置的 `tasks` 模块。绑定变更同样递增 `config_version`，按上文规则在空闲时换新实例并生成不可变快照，不会在 turn 中途改变工具。runtime 把快照转换为 Codex 的 `mcp_servers.*` 配置，并依据 `mcpServer/startupStatus/updated` 判断必需模块是否就绪。

## 存储与隔离

- 开发与生产各有一套 SeaweedFS 和 runtime 网络（`axp-dev-s3` / `axp-runtime` 与 `axp-s3` / `axp-prod-runtime`），开发新建的容器以 `axp-dev-` 开头，互不可见。
- 一个 Agent 只能读写自己的快照：容器里没有挂载，没有共享文件系统，也没有存储凭据。

## 已知限制

- Codex 在容器内使用 `danger-full-access` 沙箱、`on-request` 审批：容器本身是隔离边界。
- Agent 能读到自己快照的上传地址，因此可以改写自己的快照，但碰不到其他 Agent 的。
- 中断请求到达时 runtime 若尚未记录该命令（返回 404），controller 在本地取消；极端情况下更早一次超时的 PUT 仍可能随后送达。
- 幂等记录与 `ui_event` 暂不清理（RFC v1 约定）。
- 开发用 `runserver` 以线程处理 SSE，每个连接占一个线程；生产应使用 ASGI 服务与 PostgreSQL `LISTEN/NOTIFY` 唤醒（当前为轮询持久事件表）。
- 自动化测试使用脚本化的 app-server（`axp_runtime.testing.fake_app_server`）；与真实模型的联调需要在“模型服务”中绑定账号。
