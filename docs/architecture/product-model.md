# 产品模型

| 概念           | 含义                                                                                             | 表                                       | target                                |
| -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------- |
| 智能体（人格） | 全局的配置：名字、指令、persona 卡、模型与思考档。**不是容器**，不拥有会话和对话                 | `agent`                                  | `agents`                              |
| machine        | 会话跑在哪台电脑上：host 所在的 primary，以及跑 daemon 的其他机器                                | `machine`                                | `machines`                            |
| project        | 一台 machine 上的一个目录，带一个主理人（steward）                                               | `project`                                | `projects`                            |
| 对话           | 一条时间线，属于一个 project，成员是若干智能体                                                   | `conversation`、`participant`、`message` | `conversations`、`conversations.<id>` |
| session        | 上游 harness 的会话，每个（智能体 × 对话）一个，cwd 是 project 的目录，跑在 project 所在的机器上 | 上游文件（见[数据](data.md)）            | `sessions.<id>`                       |

## 智能体

- 字段：`name`、`instructions`（追加到该智能体每个会话系统提示的基底之后）、`persona`（persona 卡的名字；空串是 project 的默认卡，和"没有 persona"不同）、`model`（`provider:modelId`，空表示跟随设置）、`thinking_level`。
- 创建时在主 node 上得到自己的工作区 `<数据目录>/agents/<id>/`，它同时是一个 `agent_home` 类型的 project，主理人是它自己，并在一个事务里一起出现。改名会移动目录。
- **私聊**就是它工作区里只有它一个成员的 `direct` 对话（`agents.direct` 取得或恢复）。
- 删除智能体先停掉它正在写的回复；时间线上它写过的行保留。

## project 与主理人

project = machine + 目录（同一台机器上同一路径唯一）。`steward_id` 是主理人：没有 @ 任何人的消息交给它。对话可以有自己的主理人（`conversation.steward_id`），为空则沿用 project 的。有效主理人 = 对话的 ?? project 的（`effectiveSteward`）。

**文件列表**（`projects.files`，输入框的 `@` 菜单用）：在 project 所在的机器上用一段 shell 脚本列出（本机经进程自己的 shell，daemon 经链路的 `exec`，所以只有一套实现）：git 检出里取 git 认识的文件（已跟踪、未被忽略），否则是深度 ≤ 8 的 `find`；再滤掉 `node_modules`、`.git`、`.eta`、`dist`、`build` 等目录，按浅层优先排序，默认 2000、最多 5000 条，超出时 `truncated`。路径相对 project 目录，也就是智能体的工作目录。菜单里成员在前、文件在后。

**切换主理人**：旧智能体的会话保留，仍然可以被 @；新智能体的会话在第一次被唤醒时才创建，只被告知它没看过的部分（`participant.last_seq` 之后的行）；时间线上落一条 `system` 行（"X 现在是主理人，接替 Y"）。

## 对话与成员

- 对话 `kind` 是 `group` 或 `direct`。有 `goal`、`decided` 两段文字（讨论的目标与已定的结论）、`read_seq`（用户读到哪）、`archived`。
- `participant`：谁参加。`session_id` 是该智能体在这个对话里的会话（首次唤醒时创建，之后一直复用，重启后同样按这行找回），`last_seq` 是它被告知到哪一行。
- `message`（时间线）：`seq` 在对话内递增，是阅读顺序。`kind` 有 `message`、`mention`、`system`、`task_draft`、`task_card`；`status` 有 `queued`、`working`、`waiting_for_input`、`done`、`failed`、`stopping`、`stopped`。**回复行占着它的位置**：入队时就有 `seq`，文字陆续到达时 `revision` 增长而 `seq` 不变。
- 回复结束时，这次运行的工具活动存进行的 `data.activity`（`ToolActivity[]`：名称、裁短的输入、输出开头最多 2000 字符、状态，以及工具留给页面的 `details`，如 `publish_artifact` 的产物引用；`details` 超过 4000 字节丢弃，最多 200 条）。回复进行中页面从会话的 transcript 画工具卡，结束后从这里画同样的卡片和产物卡。远端会话由 daemon 的 `run` 随 `RunOutcome.activity` 带回，不需要迁移。

## 唤醒规则

**一次唤醒就是一条回复行。** 没有单独的唤醒表或队列：`queued` 的回复行是等着会话的唤醒，`working` 是正在跑的，进程重启时把遗留的在途行统一标为失败（"服务重启，这条回复没有完成"）。

谁被唤醒（`conversations/routing.ts`，纯规则）：

1. 用户消息里 @ 了的成员（只认成员）。
2. 没有 @ 且是私聊：唯一的那个智能体。
3. 没有 @ 且有有效主理人：主理人（还不是成员则先加入）。
4. 没有主理人且只有一个成员：这个成员。
5. 其他情况：没人被唤醒，并告知发送者，不猜。

智能体之间用 `mention` 工具互相交接工作（按名字或 id，找不到的名字会告诉智能体）：被点名者被唤醒，发起者不等待。**五次唤醒预算**：一条用户消息引发的 agent-to-agent mention 跨所有分支合计最多 5 次（`WAKE_BUDGET`），第 5 次仍唤醒并附提醒，之后只是上下文，直到用户再次发言重新计数。

**会话内串行，会话间并行**：一个会话一次只答一件事；一个智能体在三个对话里就有三个会话，三个成员的对话可以同时跑三个。队列的键是 participant（会话创建之前就存在）。发送有两种模式：`queue`（排队）与 `steer`（并入正在回答的那一轮）；带 `clientId` 重试是同一条消息。

**被唤醒的智能体看到什么**（`briefing.ts`）：自己的会话只听过对它说的话，所以每次唤醒带上 `last_seq` 之后的所有行（谁说的 + 内容，最多 100 条，每条截 2000 字），再加触发它的那条。还没写完的行不算看过，水位不会越过它。

对话里的工具（注册在每个（智能体 × 对话）会话上）：`mention`，以及`conversation_info`（看当前对话的目标与成员）；其他功能各自再加（任务、产物、记忆、定时任务）。

## 待处理与审批

会话里的提问（ask）被 `inbox` 聚合成 `interaction` 行：提出、回答、取消、过期各有状态。回答经 `inbox.answer` 交回给提问的会话，等待它的那一轮继续；引擎同时听到同样的事件，把回复在 `working` 与 `waiting_for_input` 之间切换。进程重启时未回答的提问一律过期。

**审批名单**（`inbox.setApprovals`，存在 `setting` 表）：名单里的工具在运行前先问用户，实现为工具中间件，本机会话与 daemon 上的会话一致。

## 用量

每次生成写一行 `usage`（智能体、对话、状态 ok/error/aborted），保留 30 天，启动时和之后每天清理一次；界面看到的所有合计都是对这张表的读取，没有计数器。
