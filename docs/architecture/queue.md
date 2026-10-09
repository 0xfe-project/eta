# 队列

本文说明 [#22](https://github.com/AkaraChen/axp/issues/22) 的实现：AXP 的队列是 NATS JetStream（2.14），承载聊天命令。[定时任务](routines.md)服务也把计划放在同一个 NATS 里，但用它自己的 stream `ROUTINES`，与本文的队列无关。

## 只有一个队列

一条等待执行的命令，就是它所属 Agent 的 subject `axp.agent.<agent>.commands` 上的一条消息。PostgreSQL 只记录发生过什么（消息、回复、命令的结果），从不决定谁等待、谁先执行。

- **入队**：`POST /chat/messages` 在同一个事务里写入消息和命令，并在会话锁内、提交前发布到队列，所以命令按发送顺序入队；发布失败时整个请求回滚（`503 QUEUE_UNAVAILABLE`）。每个 Agent 最多排 20 条，由 stream 的 `max_msgs_per_subject` 拒绝多出来的（`429 QUEUE_FULL`）。
- **出队**：runtime 空闲时通过 consumer `agent-<agent>` 取一条，立刻确认（ack），再执行。一次只取一条，所以同一个 Agent 一次只执行一条命令。取到即确认：runtime 之后崩溃，这条命令丢失而不会被执行两次。
- **撤回**：停止一条还没被取走的命令，就是从 stream 里删掉它（按发布时记下的 `queue_seq`）；删除成功即取消。已被取走的，改为通知 runtime 中断。

stream `AGENTS` 是 work-queue：消息被确认后即删除。

## 控制消息

运行中的 runtime 还订阅 `axp.agent.<agent>.control`（普通 NATS，不存储）：

| `type`      | 内容                      | 用途                                                                         |
| ----------- | ------------------------- | ---------------------------------------------------------------------------- |
| `interrupt` | `command_id`              | 停止正在执行的命令；仍在停止中时再次停止会再发一次                           |
| `decision`  | `approval_id`、`decision` | 用户对审批的回答；再次给出同样的回答会再发一次                               |
| `steer`     | `command_id`、`text` 等   | 请求-应答：正在运行的 turn 接受插话则 `{"accepted": true}`，否则插话照常入队 |

没有 runtime 在运行时，这些消息无人接收：此时既没有执行中的命令，也没有待回答的审批。

## controller

controller 只管容器：

- 某个 Agent 的 subject 上有消息（`stream_info` 的按 subject 计数），就为它启动 runtime；有消息或有执行中的命令时不算空闲。
- 实例结束时，它执行过的命令，以及已不在队列里却没有任何事件的命令（被它取走了），都以“执行中断”失败，绝不重放；队列里剩下的由下一个实例执行。
- runtime 报告失败或一直没有就绪（`START_TIMEOUT`）时，清空该 Agent 的队列，等待中的回复以相应原因失败。
- 删除 Agent 时删除它的队列和 consumer。

## 运行

NATS 不设鉴权，只在内部网络上可达。

|      | 开发                                                                                    | 生产                                                               |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 服务 | 容器 `axp-dev-nats`，`172.30.0.1:4222`（runtime 网络网关地址，宿主进程和 runtime 共用） | accessory `axp-nats`，runtime 网络别名 `axp-nats:4222`，不发布端口 |
| 数据 | 卷 `axp-dev-nats`                                                                       | 卷 `axp-nats`                                                      |
