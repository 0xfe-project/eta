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

NATS 只在内部网络上可达，并且按智能体隔离（#98）：runtime 和服务都在 runtime 网络上能连到它，而“智能体之间互不访问”不能只靠网络。配置是 `deploy/nats.conf`，开发和生产相同：

- **服务**（控制面三个角色、定时任务服务）以用户 `services` 连接（密码 `AXP_NATS_PASSWORD`），有全部权限。
- **runtime** 只带自己的 runtime key（`<实例 ID>.<令牌>`，就是它访问 runtime 网关用的那个）作 token 连接，没有别的凭据。NATS 用 auth callout 去问控制面：`internal` 进程订阅 `$SYS.REQ.USER.AUTH`（队列组，多个进程分担），按 runtime-auth 同样的规则认证（令牌、代际、实例未结束），回一个只属于这个智能体的用户，用 `AXP_NATS_CALLOUT_SEED` 签名（NATS 认它的公钥 `AXP_NATS_CALLOUT_ISSUER`）。它只能：
  - 发布 `$JS.API.CONSUMER.MSG.NEXT.AGENTS.agent-<id>`、`$JS.API.CONSUMER.INFO.AGENTS.agent-<id>` 和 `$JS.ACK.AGENTS.agent-<id>.>`，即取、确认自己的命令；
  - 订阅自己的 `axp.agent.<id>.control` 和自己的回复前缀 `_INBOX_<id>.>`（runtime 以此为 inbox 前缀）；
  - 回应收到的请求（每个请求一条回复，1 分钟内）。

  所以一个被提示注入的智能体不能给别的智能体插话、停止或替它审批，读不到也清不掉别人的队列，删不了流，也触发不了定时任务。认证失败直接拒绝连接。

- `axp-control-plane nats-callout-key` 生成一对新的签名密钥；`deploy.sh` 第一次部署时自动生成两者并写进 `production.env`。在这之前启动的 NATS 不认识 runtime 的 key：`deploy.sh` 在新角色启动前把它重启到这份配置，然后用 `axp-control-plane expire-runtimes` 让 controller 换掉之前启动的 runtime（它们连接时不带 key）。

|      | 开发                                                                                    | 生产                                                               |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 服务 | 容器 `axp-dev-nats`，`172.30.0.1:4222`（runtime 网络网关地址，宿主进程和 runtime 共用） | accessory `axp-nats`，runtime 网络别名 `axp-nats:4222`，不发布端口 |
| 数据 | 卷 `axp-dev-nats`                                                                       | 卷 `axp-nats`                                                      |
