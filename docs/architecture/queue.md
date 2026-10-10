# 命令与事件

聊天智能体的工作和结果走两条路：等待执行的命令在 PostgreSQL 里，由 controller 交给 runtime 的控制接口；runtime 发生的事经 NATS JetStream 回到控制面。[定时任务](routines.md)服务把计划放在同一个 NATS 里，用它自己的 stream `ROUTINES`，与本文无关。

## 命令只在一个地方

一条等待执行的命令，就是 `agent_command` 里 `status = 'queued'`、`delivered_at` 为空的一行，按 `agent_sequence` 排队。

- **入队**：`POST /chat/messages` 在同一个事务里写入消息和命令，并 `NOTIFY axp_agent_work`，事务提交时 controller 收到通知。每个智能体最多 20 条在等（`429 QUEUE_FULL`）。
- **交付**：controller 一次只交付一条：先在事务里把它记为已交付（`running`、`delivered_at`、`boot_id`），再调用 runtime 的 `POST /prompt`。没有送到（runtime 不在、不是这次启动、正忙）就退回等待；送到但结果不明的以“执行中断”结束，绝不交付两次。
- **撤回**：停止一条还在等的命令，就是把它记为取消；已交付的，controller 请 runtime 中断。
- 插话（`steer`）在有 turn 运行时交给 `POST /steer`：被采纳的记下 `delivered_at`，等 runtime 报告接手（`turn.steered`）。

controller 每秒还会检查一遍所有有工作的智能体，通知丢了（controller 重启、数据库重连）也不会让命令一直等下去。

## 事件

runtime 把事件发到 stream `AGENT_EVENTS` 的 subject `axp.agent.<agent>.events`。每个事件是：

```json
{
  "boot_id": "<这次启动>",
  "seq": 1,
  "type": "turn.started",
  "payload": { "command_id": "...", "turn_id": "..." }
}
```

| 类型              | 载荷                                                       | 含义                                                 |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| `runtime.started` | `thread_id`、`resumed`                                     | 这次启动就绪；之前启动手里的命令以“执行中断”结束     |
| `runtime.failed`  | `code`                                                     | 无法启动（`PLUGIN_INSTALL_FAILED`、`RECOVERY_*` 等） |
| `turn.started`    | `command_id`、`turn_id`                                    | 命令的 turn 开始                                     |
| `item.updated`    | `command_id`、`item`（`id`、`kind`、`status`、文本或活动） | 回复的一段文本或一个工具调用                         |
| `turn.steered`    | `command_id`、`steer_command_id`、`turn_id`                | turn 接手了插话                                      |
| `turn.completed`  | `command_id`、`turn_id`、`status`                          | `completed`、`interrupted` 或 `failed`               |

- runtime 按顺序逐条发布，消息 id 是 `<boot_id>:<seq>`，重试的发布在两分钟内只存一次；没发出去的在内存里排队，runtime 退出时丢失。
- controller 用 ordered consumer 按顺序读，每批在一个事务里导入并记下读到的 stream 序号（`event_position`），重启后从那里继续，每个事件只导入一次。`agent_event` 的 `(agent_id, boot_id, source_seq)` 唯一，同一事件再来也只算一次。
- stream 保留 7 天。

## 运行

NATS 不设鉴权，只在内部网络上可达。

|      | 开发                                                                                    | 生产                                                               |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 服务 | 容器 `axp-dev-nats`，`172.30.0.1:4222`（runtime 网络网关地址，宿主进程和 runtime 共用） | accessory `axp-nats`，runtime 网络别名 `axp-nats:4222`，不发布端口 |
| 数据 | 卷 `axp-dev-nats`                                                                       | 卷 `axp-nats`                                                      |
