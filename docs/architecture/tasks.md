# 任务

任务是看板上的一件事，也是**一次可以执行的工作**：提出它的智能体就是执行者，在一个全新的会话里去做，做完交回待验收。代码在 `apps/eta/src/tasks`，契约在 `packages/client-contracts/src/tasks.ts`。

## 谁建任务，谁执行

- **用户不能新建任务。** 线上没有 `tasks.create`，界面没有"新建"。任务只来自智能体的工具：`draft_task`（提议，由用户确认）和 `create_task`（用户明确要求时直接建）。
- **执行者永远是创建它的智能体**（`task.created_by_agent`），没有指派，也没有换执行者。早先用户建的任务没有执行者，是看板上不能运行的笔记。
- 任务有编号（`#12`，`AUTOINCREMENT`，删掉最新的也不复用）、标题、描述、状态 `backlog | todo | in_progress | in_review | done | blocked | cancelled`、所属项目、工作区、来源对话（`origin_conversation_id`，永远是提出它的那个，执行结果发回那里；`conversation_id` 是现在关联的对话，可以改）。
- **一个入口**：线上 action 与智能体工具是同一组操作（`TaskBoard`）。校验、变更与它留下的活动记录是一次写入，任务的所有卡片在同一次写入里刷新，然后才通知看着的人。

## 草稿、确认与卡片

智能体在对话里 `draft_task`：标题、目标、已决定、验收标准、来源，加上**工作区**的选择。这是对话时间线上的一行（`task_draft`），看板上还没有任何东西。用户可以改标题、描述、起始状态后确认（`tasks.confirmDraft`），同一行变成该任务的卡片（`task_card`），任务入队（起始状态是 `backlog` 则只建不跑）。草稿的描述要写给"什么都不知道的读者"：执行者看不到这段对话。

### 草稿属于写出它的那一轮

`task_draft` 的 `data` 带 `turnMessageId`：写出它的那条回复行的 id。host 本来就要找这一行（算来源的「第 N–M 条」），顺手记下它的 id——**归属靠数据，不靠猜序**，一轮里两张草稿、或者两轮交错都不会错位。确认时同一行变成 `task_card`，这个字段跟着搬过去，卡片因此留在提出它的那一轮里随任务刷新。`MessageView.data` 是 JSON，没有迁移；缺这个字段的旧行按时间线原样独立绘制。

页面把带这个字段的行画进那条回复的框内（`chat-panel.tsx` 的 `Turn` → `.turn-tasks`）：同一个作者、同一个页脚时间，缩进与一条发丝线说明它来自哪一轮。它**不进**折叠起来的执行过程（`ProcessBox`）：草稿是向用户要一个决定，不是智能体干过的一步；该轮落定后它与答案同级。

折叠用仓库现成的语法（原生 `<details>` + `.thinking-block-header` + chevron），默认与 `ProcessBox` 一致：该轮在途展开，落定后折成一行。读者自己开合的选择按 message id 记在 localStorage（`lib/fold.ts`），不被默认值覆盖，也不受刷新影响。折叠态的标题行带「待确认」与确认入口：折起来看不见的是它的正文，不是它的问题。

**草稿不计入待办（attention），这一条本次明确不改。** 待办数的是在别处等着你的事——提问、看板上 blocked / in_review 的任务、没看过的例行任务报告——它们都藏在一个「你不在那儿看就不知道」的地方，所以要单独列一行。草稿已经有两处出口：它就是这条对话时间线上的一条智能体行，对话列表的未读数为它 +1（`timeline.ts` 的 `digest`），而卡片自己带着标记和确认入口，折着也带。它没有「看过」或「搁下」这个状态——不确认它就一直在，计入待办等于一枚只能靠确认或删行来摘的角标。确认后它是看板上的任务，那时按任务自己的状态（blocked / in_review）进入待办。

## 工作区

建任务时由智能体选（`workspace`）：

| 模式       | 含义                                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `worktree` | git 项目的默认值。在项目所在机器上为任务建一个 git worktree，分支 `eta/task-<编号>`，从项目当前提交开 |
| `local`    | 在项目目录里直接干。不是 git 仓库的项目只能用它                                                       |

提议时就检查：对不是仓库的项目要 `worktree` 会被工具拒绝，让智能体当场听到，而不是等运行失败。

**worktree 的位置**是它所在机器自己的 eta 数据目录下的稳定路径，不在项目目录里：

- primary：`<数据目录>/worktrees/<项目 id>/task-<编号>`
- daemon 所在机器：`~/.eta/worktrees/<项目 id>/task-<编号>`（daemon 以会话读写文件的同一个用户运行）

选在项目目录之外，是为了让项目的 `git status` 保持干净；路径只由任务决定，所以重跑会回到同一份文件；没有任何东西会删它，因为它装着正在被验收的工作。分支已存在时（上一次运行建的）直接复用。建 worktree 是一段 shell，经机器的 transport 执行：primary 在自己的 shell 里，daemon 经链路，文本相同（`workspace.ts`）。worktree 的路径与分支在第一次运行建好后写回任务，任务页显示。

## 运行

一次运行是执行者对任务的一次尝试（`task_run`，状态 `queued | starting | running | completed | failed | interrupted`），**表本身就是队列**（`runner.ts`）。

- **全新的会话。** 运行用 `openRunSession` 开一个新会话：这个智能体的模型、persona、指令、技能、MCP 服务器、环境包和记忆钩子，跟它在对话里的会话一模一样（走同一个 `place.ensure`），但没有对话的历史、没有参与者行。会话存在项目所在的机器上，cwd 是工作区。**它不出现在侧栏**（侧栏是对话），只在任务页：状态加执行记录。
- **会话的键。** 对话里的会话用对话 id 作 `SessionMeta.conversationId`；运行的会话用 `task-run:<运行 id>`（`run-key.ts`）。工具、daemon 的归属校验、用量、提问、记忆都认这把键：用量与提问归到来源对话，记忆钩子按来源对话取。会话里没有对话工具（`mention` 等），有 `list_tasks`、`get_task`、`update_task`、`comment_task` 和 `finish_task`。
- **第一条提示**是任务本身：标题、描述（目标、已决定、验收标准）、来源对话的名字与 id，工作在哪、怎么汇报，别在任务没说时合并进主分支。
- **队列。** 运行按 `created_at` 排队。启动需要两个条件：这个任务上一次运行已结束，机器有空位。否则标出原因：`task_busy`、`machine_full`、`machine_offline`。`pump()` 在一切可能改变答案的时刻调用（排了新的、有运行结束、机器上线、上限被改）。
- **每台机器的并发上限**是机器的设置（`machine.max_active_runs`，默认 **2**，1–20，设置 → 机器里改，`machines.setMaxActiveRuns`）。
- **运行日志就是会话的 transcript。** 任务页订阅 `sessions.<会话 id>`，用聊天里同一套块（思考、文字、工具卡）实时画出来；没有第二份记录。第一条用户消息（简报）不显示。
- **结束靠 `finish_task`。** 执行者调用它：总结变成任务上的一条评论，任务进入 `in_review`（或 `blocked`：需要用户），并且**以智能体的身份**把"#编号 标题 + 总结"发到来源对话。worktree 保留，合并/开 PR 或丢弃由验收后决定，不是自动的。没调用就安静下来的运行被提醒一次，再不报就失败。
- **评论进会话。** 任务上有运行在跑时，用户（或别的智能体）的评论作为用户消息送进它的会话：轮次进行中就 steer，否则等下一轮。执行者自己的评论不回灌给它。
- **打断与重跑。** `tasks.interrupt` 停一次运行（排队的永不开始，在跑的结束为 `interrupted`，任务状态不动）；任务被移到 `done`/`cancelled` 也会停它的运行。`tasks.rerun` 开一次新运行（全新会话，不记得上一次），同一时刻一个任务只能有一次没结束的运行。
- **重启。** 重启时遗留的 `starting/running` 运行全部标为失败（"服务器重启了"），排队中的继续等。链路在运行中断掉，运行以"结果未知"失败，不重放。

## daemon 上的运行

项目在别的机器上时，运行的会话在那台机器上：journal、kernel 与工具都在 daemon，模型调用和产品工具（任务、产物、记忆）经链路回到 primary（见[机器与 daemon](machines.md)）。primary 凭自己的 `task_run` 行相信一个会话属于哪次运行，并要求链路所属的机器就是运行记录的机器。机器离线时运行排队（`machine_offline`），连上后开始。

## 线上的动作

| action                | 含义                                  |
| --------------------- | ------------------------------------- |
| `confirmDraft`        | 确认草稿，建任务并入队                |
| `update`              | 改标题、描述、状态（拖列也是它）      |
| `comment`             | 评论；有运行在跑则送进它的会话        |
| `interrupt` / `rerun` | 停一次运行 / 新开一次运行             |
| `link` / `delete`     | 关联对话 / 删任务（有运行在跑不能删） |

`tasks` 是 eager 的一份列表（每行带 `runStatus`）；每个任务是 `tasks.<id>`：`task`（详情，含工作区与 `runs`）和 `activity`（时间线，包含 `run_queued/started/completed/failed/interrupted/nudged`）。

## 智能体的工具

对话里的智能体：`draft_task`、`list_tasks`、`get_task`、`create_task`、`update_task`、`comment_task`。运行里的执行者：`list_tasks`、`get_task`、`update_task`（不能直接移到 `done`/`cancelled`/`in_review`）、`comment_task`（作用在自己的任务上）、`finish_task`。工具描述承载纪律：`draft_task` 的描述开头是可自检的触发条件（改仓库里的文件、跑构建或测试、结果要人验收、你知道会转好几轮工具），命中任一条就别在聊天里做；留在聊天区的是读、查、解释、问答、表态和一两条命令的验证。`mention` 是把话交给人，`draft_task` 是让工作离开这一轮：它是看板的提案，由用户确认后成为任务，由提出它的智能体在一个看不见这段对话的新会话里执行。
