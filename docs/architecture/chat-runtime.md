# 聊天与运行时架构

本文说明聊天智能体怎样运行：每个智能体一个常驻容器，由它的[环境包](bundles.md)构建，状态在它自己的 Docker 卷上；容器里的 runtime 直接驱动 Codex 的 app-server（JSON-RPC，类型由固定版本的 Codex 生成），控制面经 runtime 的控制接口把工作交给它，runtime 把发生的事发到 NATS。公开契约以 [RFC #1](https://github.com/akarachen/axp/issues/1) 第 3–4 节为准，本文只记录实现取舍和运维要点。

## 组件与进程

| 进程                   | 代码                                                | 职责                                                                                           |
| ---------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 公共 API（`api`）      | `api/chat.go`、`chat/chat.go`                       | 产品接口、SSE、幂等、产品投影与 `ui_event`；工作只写进 PostgreSQL                              |
| 内部 API（`internal`） | `api/internal.go`、`control/gate.go`                | runtime 网关的 forward auth（谁持有这把 key、有没有这个插件），以及 groups、tasks、agenvo 插件 |
| controller             | `control/controller.go`、`dispatch.go`、`events.go` | 唯一持有 Docker socket、唯一能连到 runtime 的进程：构建镜像、运行容器、交付工作、导入事件      |
| NATS JetStream         | stream `AGENT_EVENTS`                               | runtime 发出的事件，按智能体一个 subject                                                       |
| agent runtime（容器）  | `apps/agent-runtime/src`                            | Node 24：驱动 Codex app-server，hono 提供控制接口，事件发到 NATS                               |

代码路径相对于 `apps/control-plane/internal`。公共 API 不在 runtime 网络上，所以它从不直接调用 runtime：它写入命令后 `NOTIFY axp_agent_work`（提交时才送达），controller 收到后立即交付。

## 群与参与者

`conversation` 仍是整个工作区的事件分区，不代表群。`chat_group` 有名字、目标、已定事项、归档标记和用户读到的 seq，没有业务状态。`group_participant` 记录成员和临时参与者，同时保存 `(群, 智能体)` 的 Codex thread id、恢复状态及上次参与的 seq。新建智能体时在同一事务里创建唯一的私聊群；私聊不能改成员，要按话题多聊几段就新建群。

单智能体群和私聊默认唤醒唯一成员。多智能体群只有 `mentions` 中的成员会被唤醒，没有点名的消息只留作上下文。每个智能体仍有自己的队列和工作区，跨群串行；不同智能体可以并行。历史只提供 `GET /groups/{id}/messages`，快照包含群列表、活跃回复和交互，仍由一条工作区 SSE 推送；`group.updated` 更新群，消息和交互均带 `group_id`。消息 seq 固定回复顺序，revision 用于重连去重。

群的“全部停止”只停止本群的排队和执行中命令。执行中的命令记下中断请求，`CurrentCommand` 会拒绝它后续的工具调用；排队命令直接取消，不另存唤醒链状态。移除成员会停止它在本群的工作，保留发言和 thread 映射，恢复状态记为 archived；重新邀请时仍使用原来的 thread。

控制面给 runtime 的输入只有群头（名称、成员、点名者、新消息数）和被点名的消息。前情由必选 groups 插件的 skill 指导智能体用 `read_group` / `search_group` 自取，不批量注入历史或简报。智能体的普通回复即使写了 @ 也不会唤醒其他智能体。

智能体之间只能用 `mention`：在当前群或私聊里写下一条有作者和接收者的消息，再给接收者排队，回答仍留在这里，不自动回叫。非成员成为这次上下文的临时参与者，群里写邀请提示。`agent_command.root_message_id` 指向最初的用户消息，先用 `FOR UPDATE` 锁住根消息，再数以它为根的 `kind=mention` 消息，所有分支合计最多五次；第五次排队时写审阅提醒，后续调用不再排队。MCP 工具用网关注入的身份和当前群检查执行槽，不能由参数跨群读写。forward auth 和工具共用 `ActiveCommand` 查询当前执行槽。系统事件由 `kind=system` 表达，role 仍只有 user / assistant，作者约束按 kind 校验。

`search_group` 按空白拆词，每个词都用转义后的 `ILIKE` 匹配消息正文或卡片数据，要求全部命中；中文不依赖分词索引。

表结构使用 goose；既有消息、附件和环境包的转换按 #237 手工完成，应用没有迁移或兼容路径。

## 一条消息的路径

1. `POST /chat/messages {group_id, mentions, parts}` 在一个事务里写入幂等记录、一条用户消息、按点名顺序排列的助手回复占位和各自的 `agent_command(queued)`，并通知 controller，返回 202。用户消息的 id 可以由客户端给出（见下文[发送](#发送)）。每个智能体最多 20 条在等（`429 QUEUE_FULL`）。
2. controller 的 `Dispatch`：智能体的容器是当前配置、它的 runtime 已经报告启动（`agent.boot_id`），且没有正在执行的命令时，取最早的一条，先在事务里记为已交付（`status = running`、`delivered_at`、`boot_id`），再 `POST /prompt {boot_id, command_id, thread_key, codex_thread_id, text, kind}`。
3. runtime 用 `turn/start` 开始一个 turn（`clientUserMessageId` 就是命令 id），Codex 的通知被转换成事件：`turn.started`、`item.updated`（增量文本每 0.3 秒合并一次）、`approval.*`、`turn.steered`、`turn.completed`。
4. 事件发到 `axp.agent.<agent>.events`；controller 按顺序读 stream，每批在一个事务里导入 `agent_event` 并投影为消息块和 `ui_event`，同时记下读到的位置（`event_position`），SSE 推给浏览器。导入后唤醒该智能体：turn 结束了，下一条随即交付。

交付的结果：runtime 接受即成功；runtime 连不上、`busy`、`wrong_boot`（这条是给前一次启动的）或 Codex 正在重启时，命令退回等待，稍后再交付；Codex 拒绝时回复以“智能体执行失败”结束；超时（无法确定 turn 是否开始）时以“执行中断”结束并要求中断，绝不重放。

工具调用投影为活动块：名称、输入和输出都是裁剪过的文本，只用来显示。AXP 自己的插件工具（tasks、routines、github、artifacts）在结果的 `_meta["axp/ref"]` 里写明这次调用创建或操作的那一个对象（`{kind, id, number, title, status, url, body}`）。runtime 不认识具体插件，只把完成的 MCP 调用里的这个字段原样带上；控制面只接受完整的 `task`、`routine`、`pull_request`、`issue_draft` 和 `artifact`（`id` 是 UUID，`number` 是版本），链接必须是 github.com 上对应的 PR 页或新建 issue 页，然后存为活动块的 `ref`。Web 在调用行下面显示一张卡片：任务和定时在对话旁边的面板或全窗口页面里打开，PR 打开 GitHub，Artifact 在 Dialog 里打开工具发布的那个版本（见 [Artifact](artifacts.md)）。`issue_draft` 是 github 插件的 `draft_issue` 生成的草稿，不是已有的 issue：forge-service 只校验仓库并拼出预填标题和正文的 GitHub 新建 issue 链接，不调用 GitHub，也不保存任何东西。它的卡片是虚线框，写着“去 GitHub 创建”，由用户在 GitHub 上审核后提交；正文太长放不进链接时，`body` 随 ref 一起带上，卡片多一个“复制正文”。列表、失败、执行中、旧数据和其他工具都没有 `ref`，只显示原来的调用行。

agenvo 插件的 `execute` 是任意脚本，可以调用多个原生方法、自己决定返回什么；relay 成功时只返回脚本的返回值，失败时才列出已发出的调用（没有参数）。所以脚本做了什么由控制面在转发时记录（`relay.Record`，`tasks.Service.AgenvoMCP`）：脚本放进一个包了 `call` 的函数里，每次原生调用照常只执行一次，同时记下目标、方法和结果（`execution`、错误），`paseo.workspaces.create` 和 Herdr 的 `workspace.create`、`worktree.create`、`worktree.open` 还记下参数和返回。脚本把记录和自己的返回值一起返回，抛错时附在错误后面；控制面把它取出来，智能体看到的回答与原脚本一致（语法错误的列号也移回去），再按 Paseo/Herdr 的返回整理成 `_meta["axp/operations"]`：操作（创建工作区、创建/打开 worktree、添加项目）、电脑名（按 relay 设备查 `computer_runtime`）、runtime、名称、项目、路径、分支、原生 id 和原因。状态只按原生结果判断：返回了工作区才是“已创建”；`accepted` 但没有工作区是“已受理，未确认完成”（Paseo 带了原因则是失败）；`rejected`/`not_started` 是失败；`unknown`、`starting`、脚本结束时还没结束的调用，以及 relay 超时后只有回执的调用，都是“结果未确认”，从不显示为失败或已创建。脚本超时等 relay 自己中止的情况没有参数，只能显示操作和状态。runtime 对完成和失败的调用都带上这个字段，控制面检查后存为活动块的 `operations`，Web 在调用行下面每个操作一张卡片，点开显示完整路径和 id；AXP 没有远程工作区的页面，卡片不链接任何地方。其他原生调用、脚本运行中、旧数据都没有卡片，只看调用行和它的原始输出。

同一批里同一回复连续的 `item.updated` 先在内存里合并，这一段结束时才写一次消息、出一个 revision 和一条 `message.updated`；原始事件仍逐条存进 `agent_event`。重复送达的事件（同一 `(agent, boot, seq)`）只导入一次。字符串里的 NUL 字符在写入 jsonb 前去掉。

停止：命令还在等时直接取消。已交付的记录 `interrupt_requested_at`、回复置为 `stopping`，controller 向 runtime 发 `POST /abort {command_id}`（直到 turn 结束，每 5 秒最多一次）；turn 还没开始时，runtime 记下它，开始时立即中断。runtime 以 `turn.completed(interrupted)` 确认后回复才变为 `stopped`。

压缩：`POST /groups/{id}/compact {mentions}` 像发消息一样建一条 `/compact` 用户消息和回复，但命令 `kind` 为 `compact`，同样排队、一次一个。runtime 调用 `thread/compact/start`，它在 turn 开始前就返回，turn id 从随后的 `turn/started` 得到，之后与普通 turn 一样流式处理，`contextCompaction` 显示为“压缩上下文”。

确认：Codex 以 `on-request` 审批运行（`/etc/codex/config.toml`）。runtime 接住 `commandExecution` / `fileChange` 的审批请求和 plugin 工具的确认请求（只有字段为空的 MCP elicitation，见[用户确认](user-attention.md)），发出 `approval.requested`；控制面建 `approval` 与 choice `interaction`，回复显示“等待确认”。用户回答后审批变为 `decided`，controller 把决定交给 runtime 的 `POST /decide`（每 5 秒一次，直到 runtime 发出 `approval.applied`），交互才显示 `resolved`。等待中被停止时请求以 `cancel` 应答：命令和文件审批的 `cancel` 本身就中断 turn；plugin 确认的 `cancel` 只表示“用户关掉了提示”，所以 runtime 另外调用 `turn/interrupt`。Codex 自己撤回的请求（`serverRequest/resolved`）同样以 `cancel` 结束。其他服务端请求（权限扩展、带表单字段的 elicitation 等）一律保守拒绝。

插话：`mode: "steer"` 的消息照常写入。同一群有 turn 在运行时，controller 先把它交给 runtime 的 `POST /steer`（只试一次）：Codex 采纳后回显带同一 `clientId` 的 `userMessage`，runtime 发出 `turn.steered`，原命令记为成功，turn 的剩余输出和最终的 `turn.completed` 都归插话命令。turn 结束时仍未回显的已采纳插话同样转交，绝不重跑；还没有应答的，turn 结束时先等它的应答（最多 30 秒）。不被采纳的插话照常等待，轮到时作为普通 turn 执行。

## 发送

用户按下发送时消息就有了身份：Web 生成它的 id，消息立刻出现在对话里（“发送中…”），输入框清空。之后每一次尝试都带着同一个 id，既作为消息 id，也作为 `Idempotency-Key`，因此重试、响应丢失后再发、刷新页面后继续发送都是同一条消息。

- 待送达的消息和每个群的草稿保存在浏览器里（`apps/web/src/queries/outbox.ts`，localStorage 的 `axp.groups.v1`），刷新后未送达的会继续发送。同一个群的消息按发送顺序一条一条发。
- 没有响应（断网、超时 20 秒）或 5xx 时自动再试，共 4 次；仍不成功，或服务端明确拒绝（4xx），消息标为“未送达”并给出原因，可以“重试”“编辑”或“丢弃”。
- 消息经 SSE 先于响应到达时，按 id 认出它，不会显示两遍。

### 输入框里的块与附件

输入框是 Lexical 的纯文本编辑器（`apps/web/src/components/workspace/composer-*.ts*`），文字之间可以有块：

- 粘贴超过 1000 字符（按 Unicode 码点）或 12 行的文本折成 `[粘贴文本 · N 字符]`，点开看全文、移除或展开回文本；阈值在 `apps/web/src/lib/composer.ts` 的 `LONG_PASTE`。发送时它就是原文，单独作为一个文本 part，对话里同样折叠显示。超过一条消息的文本上限（100000 字符）的粘贴改为 `粘贴文本.txt` 附件。
- 粘贴的图片和文件立刻上传到当前群（`POST /api/v1/groups/{group_id}/attachments`，请求体就是文件，单个 ≤ 20 MB），块上显示上传中、失败（可重试）或缩略图；有附件未上传完或失败时不能发送。剪贴板同时有文件和文本时取文件；Office/网页复制的文字旁边附带的渲染图会被忽略，取文字。任何 HTML 都不会插入。
- 草稿按群保存为有序的 parts，上传状态按块保存在 `uploads`，刷新后上传中断的块标为失败；附件只属于它上传到的那个群。

发送时消息是有序的 `parts`（`text` 或 `attachment_id`，最多 10 个附件），服务端校验附件属于当前群并标为已发送（`chat_attachment.sent_at`，之后不能删除），消息内容里附件是 `attachment` 块。runtime 收到 `/prompt`、`/steer` 的 `parts` 时，经 runtime gateway 的 `/attachments/v1/{id}`（只能取网关注入的当前群的附件，成员和被点名的临时参与者均可取）把文件下载到 `/agent/attachments/<id>/<文件名>`，再按顺序交给 Codex：文本原样；png/jpeg/gif/webp 作为 `localImage`（模型不支持图像时这一轮会失败并显示错误）；每个附件另有一行说明它的路径、类型和大小，其他文件由智能体用工具读取。文件内容和 base64 都不会进入 prompt。浏览器通过 `GET /api/v1/chat/attachments/{id}` 查看（图片和纯文本内联，其余下载；`nosniff`、`CSP: sandbox`）。

对话里每个智能体同一时刻只有一行在动：正在执行的回复（“工作中”“正在停止”），或者智能体启动时排在第一条的回复（“正在启动智能体”）；其余等待中的回复是静态的“等待中 · 前面还有 n 条”，可以撤回。因环境原因连续失败的回复只在最后一条写出原因。

## 智能体

所有智能体属于唯一的默认对话。智能体有名称、`description`（指令）、模型和 `bundles`（[环境包](bundles.md)，默认全部内置的）。它的插件是这些环境包的插件之和（`agent.plugins`），runtime 网关按它放行插件的路由。

智能体对外的状态是 `idle`、`starting`（有工作在等它的环境：镜像构建、容器启动）、`working`、`waiting_for_input` 和 `unavailable`（镜像构建失败、runtime 无法启动），由 `RefreshAgentStatus` 从内部状态（`agent.status`：`starting`、`ready`、`error`）和进行中的回复推出。

容器启动所用的一切（镜像、模型、指令）由 controller 每个 tick 算出一份配置摘要，写在容器的标签上：

- 名称、指令、模型或环境包变了（`config_version` 递增），或者某个环境包、插件、runtime 镜像变了（镜像摘要不同），controller 在该智能体没有执行中的工作时替换它的容器，新容器在同一个卷上按控制面给出的 id 恢复各群的 thread。替换前不再交付新的命令，所以配置不会在 turn 中途改变，也不会被排队的消息一直拖住。
- 重启（`POST /agents/{id}/restart`）递增 `config_version` 并停止该智能体进行中的回复，中断确认后容器被替换。
- 删除只隐藏智能体：排队的取消、进行中的中断，controller 移除它的容器；卷和历史消息保留。

## runtime

`apps/agent-runtime` 是 TypeScript，`bun build` 打成一个文件，在 `node:24-trixie-slim` 上运行。它自己实现 app-server 的 JSON-RPC 客户端（`src/appserver.ts`，一行一条消息走子进程的 stdio），协议类型由 `bun run generate`（`codex app-server generate-ts`）从 `package.json` 锁定的 `@openai/codex` 生成到 `src/protocol`，不入库；构建镜像时 `scripts/build/image.sh` 把同一个版本传给 Dockerfile 安装，所以镜像里的 Codex 就是生成类型的那一个。升级 Codex 只改 `package.json` 的版本。启动时：

1. 把镜像里编译好的插件装进 `CODEX_HOME`（卷上的 `/agent/codex`）：Codex 只加载装过的副本；上一个镜像装过、这个镜像没有的，卸掉。装好后在副本的 `.mcp.json` 里填入网关地址和工作区。
2. 开始定时刷新 GitHub 凭据（gh 的 `hosts.yml` 和 git 的提交身份，在 `/run/axp`，不在卷上）。
3. 启动 `codex app-server`，此时不开 thread。在 `:8080` 提供控制接口，发出 `runtime.started {}`。
4. 命令带 `thread_key`（群 id）和 `codex_thread_id`（首次为 null）。首次遇到这个群时按给出的 id `thread/resume`，没有 id 才 `thread/start`；发出 `thread.opened {command_id, thread_key, codex_thread_id, resumed}`，控制面保存映射。已经加载的群直接复用；所有 thread 共用智能体的工作目录，不调用 `thread/list` 猜上下文。

runtime 只有一个执行槽，打开或恢复 thread 时也占用它。压缩和停止只作用于当前 thread；插话必须属于同一群。通知和审批检查当前 thread / turn，其他群的迟到事件不进入当前回复。恢复失败返回 `RECOVERY_RESUME_FAILED`，只影响该命令，不新建替代 thread，也不让整个 runtime 退出。

控制接口（hono）只认 controller 的令牌（`HMAC(AXP_SECRET_KEY, control:<agent>)`，`Authorization: Bearer`）：同一网络上的其他 runtime 连得到端口，拿不到令牌。Codex 和智能体执行的命令看不到这个令牌。

| 接口           | 内容                                                                              | 说明                                                                                                              |
| -------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `POST /prompt` | `boot_id`、`command_id`、`thread_key`、`codex_thread_id`、`text`、`parts`、`kind` | 开始命令的 turn（`kind: compact` 时压缩）；有 turn 在运行时 `409 busy`；附件取不到时 `409 attachment_unavailable` |
| `POST /steer`  | `boot_id`、`command_id`、`thread_key`、`codex_thread_id`、`text`、`parts`         | 加入同一群运行中的 turn；没有时 `409 no_active_turn`                                                              |
| `POST /abort`  | `command_id`                                                                      | 中断这个命令的 turn，现在或它开始时                                                                               |
| `POST /decide` | `approval_id`、`decision`                                                         | 用户对审批的决定（`accept`、`decline`）                                                                           |
| `GET /status`  |                                                                                   | `boot_id`、当前命令、群和 turn                                                                                    |

`boot_id` 是 runtime 每次启动生成的。prompt 和 steer 必须带上 controller 记下的那一次（`409 wrong_boot`）：Docker 重启了 runtime 而它还没报告时，发给它的命令退回等待，不会在新的启动里被当成旧的。

启动参数（环境变量，`control.spec`）：`AXP_AGENT_ID`、`AXP_AGENT_KEY`（访问 AXP 服务的 key，`<agent>.<HMAC(agent:<agent>)>`）、`AXP_CONTROL_TOKEN`、`AXP_GATEWAY_URL`、`AXP_NATS_URL`、模型服务 `AXP_LLM_BASE_URL`（runtime 网关的 `/v1`，即 LLM 网关）、`AXP_LLM_API_KEY`（智能体的 key）、`AXP_MODEL`、`AXP_MODEL_CONTEXT_WINDOW`、`AXP_INSTRUCTIONS`（名称和指令，作为 Codex 的 developer instructions）、`AXP_CONFIG_VERSION`，以及 OpenTelemetry 的端点和资源属性。容器里没有任何模型服务商的凭据。

Codex 的静态配置是 `danger-full-access` 沙箱、`on-request` 审批：容器是隔离边界，命令和文件改动仍经产品请用户确认；akhook 的规则检查每条命令和每个文件修改（见[工具调用规则与用户确认](agent-hooks.md)）。

## 恢复与隔离

- runtime 不能继续时退出（Codex 退出、插件安装失败），Docker 按重启策略（`unless-stopped`，越来越久的间隔）重新启动它。新的启动发出 `runtime.started` 时，交付给之前启动的命令以“执行中断，无法确认结果，未自动重试”失败，绝不重放；还在等的命令交给新的启动。
- `runtime.failed` 把智能体置为不可用，等待中的回复以中文原因失败（插件：“智能体扩展启动失败”；恢复：“智能体会话无法恢复”）。下一次启动报告成功后恢复可用。
- 镜像构建失败时，智能体不可用，`build_error` 是构建输出的末尾（智能体编辑器里显示），等待中和之后的消息以“智能体环境构建失败”失败；修改智能体、修改环境包或重启后再构建。
- runtime 没发出去的事件在它退出时丢失；它最后的状态以 controller 的处理为准。
- 一个智能体只能读写自己的卷：卷按智能体命名（`axp-agent-<id>`，开发 `axp-dev-agent-<id>`），只挂进它自己的容器；key 和控制令牌都是按智能体派生的。

## 状态

一个智能体的全部状态是它的卷 `/agent`：`workspace/`（工作区，Codex 的 cwd）和 `codex/`（`CODEX_HOME`，含 Codex 的 thread 记录和装好的插件），以及 `attachments/`（用户发来的附件，原件在对象存储）。没有快照、没有对象存储：容器重建时卷还在，runtime 从卷上恢复 thread。宿主机的卷就是数据，换机器需要自己迁移（`docker volume` 备份）。

## 已知限制

- 上传后既没发送也没在输入框里移除的附件（例如关掉了页面）留在对象存储和 `chat_attachment` 里，目前没有定期清理。
- Codex 在容器内使用 `danger-full-access` 沙箱、`on-request` 审批：容器本身是隔离边界。
- 智能体在其他群工作时，Web 在发送插话时说明已排队。同群插话是否被采纳要等 runtime 交付；未进入 turn 的回复照常排队等待。
- 每个智能体的容器常驻，空闲时也占内存（约几百 MB）。
- 幂等记录与 `ui_event` 暂不清理（RFC v1 约定）。
- SSE 每个连接一个 goroutine，每 500 毫秒轮询一次持久事件表。
