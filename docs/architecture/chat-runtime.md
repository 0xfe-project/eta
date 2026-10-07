# 聊天与运行时架构

本文说明 [RFC #1](https://github.com/akarachen/axp/issues/1) 的实现方式。公开契约以 RFC 第 3–4 节为准，本文只记录实现取舍和运维要点。

## 组件与进程

| 进程                   | 代码                              | 职责                                                                          |
| ---------------------- | --------------------------------- | ----------------------------------------------------------------------------- |
| 公共 API（Django）     | `chat/api.py`、`chat/services.py` | 7 个产品接口、SSE、幂等、产品投影与 `ui_event`                                |
| 内部运行协议（Django） | `chat/control/internal_api.py`    | runtime → 控制面：心跳、会话注册、事件批次、检查点对象。独立进程与 URLconf    |
| controller             | `chat/control/controller.py`      | 唯一持有 Docker socket：启动/隔离容器、派发命令、中断、审批送达、对账、检查点 |
| agent runtime（容器）  | `apps/agent-runtime/axp_runtime`  | 一个 Agent 一个容器；官方 Codex Python SDK 驱动一个持久 thread                |
| 模拟 worker（开发）    | `chat/fake_runtime.py`            | 无 Docker/凭据时代替 controller + runtime                                     |

公共服务的 URLconf（`config.urls`）不包含任何 `/internal` 路由；内部服务以 `AXP_URLCONF=config.internal_urls` 启动，只监听 runtime 网络的网关地址（默认 `172.30.0.1:8001`），有单独的 OpenAPI。公共响应、SSE 与前端类型只来自 `chat/schemas.py` 的手写允许列表，测试会检查其中不出现 command、thread、runtime、generation 等内部字段。

## 一条消息的路径

1. `POST /chat/messages` 在一个事务里写入幂等记录、用户消息、助手回复占位、`agent_command(queued)` 和产品事件，返回 202。
2. controller 发现有排队命令而 Agent 没有存活实例：`generation + 1`，写 `runtime_instance`，生成 MCP 快照，确保状态卷与工作区，再在事务外启动容器。token 由 `HMAC(SECRET_KEY, instance_id:generation)` 派生，换代即失效。
3. runtime 启动：校验挂载 → 必要时从检查点恢复 → 启动 Codex app-server → 用账本或控制面记录的 thread id 恢复（只有首次才 `thread/start`；无法恢复时报告 `recovery_failed`，绝不另起 thread）→ 等待必需的 MCP 模块就绪 → 对账未完成的命令与审批 → 心跳报告 ready。
4. controller 认领该 Agent 最早的排队命令（每个 Agent 同时只有一个活动执行，由部分唯一索引兜底），`PUT /internal/v1/commands/{id}`。PUT 幂等，未见响应时会重发。
5. runtime 先记账再调用 `turn/start`；Codex 通知被转换成有序 outbox 事件（`turn.started`、`item.updated`、`approval.*`、`turn.completed` 等），增量文本每 0.3 秒合并一次。
6. 内部事件接口按 `source_seq` 连续导入 `agent_event`（缺口返回 `409 EVENT_GAP` 与下一期望序号，重复事件幂等，内容不同则冲突），同事务内投影为消息块、交互和 `ui_event`，SSE 推给浏览器。

停止：公共接口只记录 `interrupt_requested_at` 并把回复置为 `stopping`；controller 发 `POST …/interrupt`；runtime 以 `turn.completed(interrupted)` 确认后回复才变为 `stopped`。命令仍在队列中时直接取消。

确认：runtime 用 SDK 的审批回调接住 `commandExecution` / `fileChange` 审批请求，生成 `approval.requested`；控制面建 `approval` 与 choice `interaction`。用户回答后审批变为 `decided`，controller 送达，runtime 回调返回后发出 `approval.applied`，交互才显示 `resolved`。等待中被停止时回调以 `cancel` 结束，同时中断该 turn。其他服务端请求（权限扩展、MCP elicitation 等）一律保守拒绝。

## 智能体

AXP 是单用户服务，所有智能体属于唯一的默认对话（`conversation.is_default`），首次创建智能体时建立。

智能体目前有名称和 `description`（指令）。指令原样作为 Codex 的 `developerInstructions` 在 `thread/start` 和 `thread/resume` 时注入。运行时启动所用的一切配置（指令、MCP 绑定）都由 `agent.config_version` 版本化：修改后版本递增；controller 在该智能体没有进行中的执行时停止旧实例（`CONFIG_CHANGED`），下一个实例用新配置恢复同一 thread，因此配置不会在 turn 中途改变。以后给智能体增加的、影响运行时的设置应走同一条路径。

除 RFC 第 3 节的接口外，公开 API 提供 `POST /agents`（`name`、`description`）、`PATCH /agents/{id}`（部分更新）和 `DELETE /agents/{id}`。删除不抹掉数据：智能体被标记为已删除并从列表中隐藏，排队消息取消、进行中的回复被中断，历史消息保留；controller 等执行停下后停止并移除其容器，之后不再启动。工作区（JuiceFS 目录）与状态卷保留。删除通过 `agent.deleted` 事件（`{agent_id}`）通知前端。

## 恢复与隔离

- 心跳续租（默认 30 秒）。租约过期时 controller 先停止并移除旧容器，再结束实例；之后旧实例的任何请求都得到 `409 STALE_GENERATION`，runtime 收到后立即退出。
- 实例结束时，其上的执行中命令变为 `outcome_unknown` 并继续占用执行位。新实例就绪后，controller 向它查询共享状态卷里的账本：已有终态则采用，仍被接收则由新实例继续，账本里没有则重新排队（仅限状态卷未丢失时），其余一律以“执行中断，无法确认结果，未自动重试”失败。
- runtime 在“已记录、未拿到 turn id”的窗口崩溃，重启后标记为 `outcome_unknown`，不自动重放。
- 必需 MCP 失败、挂载失败等使 runtime 停在未就绪状态；排队与派发中的回复以中文原因失败，Agent 显示为“不可用”。之后的新消息会让 controller 换一代实例重试；从未就绪过的实例有 30 秒的退避。
- 排队超过 120 秒仍没有就绪实例的消息以“准备超时”失败。
- 空闲超过 10 分钟的实例会先做检查点（若有新的成功 turn），再被停止；下一条消息会重新拉起并恢复同一 thread。

## 检查点

检查点命令与普通 turn 共用执行门禁，排在它之后的 turn 会等待。runtime 先等待 outbox 全部确认，停止 Codex 以冻结状态，把 `CODEX_HOME`、账本备份和 manifest 打包，上传到控制面给出的 S3 预签名 URL（runtime 不持有存储凭据），再恢复 Codex。每 5 个成功 turn 做一次检查点。控制面重新计算校验和一致后才把检查点标为 `available`。manifest 只记录工作区引用，不把 Codex 状态快照称为工作区快照。

状态卷丢失且有可用检查点时，新实例带着下载地址与校验和启动，校验通过才解包；检查点之后完成的命令记入 `agent_session.recovery_gap`，不重新执行。没有可用检查点时恢复失败，如实显示。RPO 是最后一个成功检查点。

## MCP

`mcp_module_revision` 由部署方注册（`manage.py mcp_register spec.json`，内置 `tasks` 模块由迁移注册），只接受 `command`/`args`/`env`，修订不可变。`agent_mcp_binding` 的配置按模块的 JSON Schema 校验，密钥只存 `env:NAME` 引用（`manage.py mcp_bind`）。新 Agent 默认绑定内置的 `tasks` 模块。绑定变更同样递增 `config_version`，按上文规则在空闲时换新实例并生成不可变快照，不会在 turn 中途改变工具。runtime 把快照转换为 Codex 的 `mcp_servers.*` 配置，并依据 `mcpServer/startupStatus/updated` 判断必需模块是否就绪。

## 工作区存储

所有 Agent 的工作区在同一个 JuiceFS 文件系统 `axp` 中：数据存在 SeaweedFS 的 S3 桶 `axp-workspaces`，元数据存在 runtime 网络上的 Redis。controller 启动时用 runtime 镜像执行一次 `juicefs format`（已格式化则不改动），S3 凭据随之存入元数据，因此 runtime 只拿到元数据地址。

- 容器入口用 `juicefs mount --subdir agents/<id>/workspace` 挂载该 Agent 的目录（不存在时自动创建），之后从环境中删除元数据地址，再启动 runtime；挂载失败时容器直接退出，实例不会就绪。
- 挂载点在 `/mnt/workspace`，因为 Ubuntu 的 `fusermount3` AppArmor 配置只允许在 `/mnt` 等目录挂载 FUSE；容器需要 `/dev/fuse` 与 `SYS_ADMIN`。读缓存在状态卷的 `juicefs-cache`。
- 状态（`CODEX_HOME`、账本）仍是每个 Agent 一个 Docker 卷，丢失时从检查点恢复。
- 开发与生产各有一套 SeaweedFS、Redis 和 runtime 网络（`axp-dev-*` / `axp-runtime` 与 `axp-s3`、`axp-juicefs-meta` / `axp-prod-runtime`），开发新建的状态卷和容器也以 `axp-dev-` 开头，互不可见。

## 已知限制

- Codex 在容器内使用 `danger-full-access` 沙箱、`on-request` 审批：容器本身是隔离边界。
- 挂载期间 JuiceFS 客户端在容器内持有文件系统的访问能力：能完全控制容器的代码理论上可以读到其他 Agent 的工作区。
- 中断请求到达时 runtime 若尚未记录该命令（返回 404），controller 在本地取消；极端情况下更早一次超时的 PUT 仍可能随后送达。
- 幂等记录与 `ui_event` 暂不清理（RFC v1 约定）。
- 开发用 `runserver` 以线程处理 SSE，每个连接占一个线程；生产应使用 ASGI 服务与 PostgreSQL `LISTEN/NOTIFY` 唤醒（当前为轮询持久事件表）。
- 自动化测试使用脚本化的 app-server（`axp_runtime.testing.fake_app_server`）；与真实模型的联调需要在“模型服务”中绑定账号。
