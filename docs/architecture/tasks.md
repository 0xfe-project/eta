# 任务与远程电脑

本文说明 [#45](https://github.com/AkaraChen/axp/issues/45) 的实现：一个像 [multica](https://github.com/multica-ai/multica) 那样的任务看板，任务可以指派给用户自己，或者指派给用户其他电脑上的编码智能体。远程电脑通过 [agenvo](https://github.com/Xuanwo/agenvo) 中继接入，智能体跑在那台电脑的 [Paseo](https://paseo.sh) 或 [Herdr](https://herdr.dev) 里，工作在用户自己的项目和工作区中。

## agenvo

AXP 用 [Xuanwo/agenvo](https://github.com/Xuanwo/agenvo) 发布在 npm 上的包，版本只在 `apps/relay/package.json` 固定一处（`@agenvo/server`）：开发的中继从这里装，生产的中继镜像（`deploy/relay.Dockerfile`）按这个版本从 npm 装。远程电脑依赖的 `paseo.workspaces.archive`（[#3](https://github.com/Xuanwo/agenvo/pull/3)，任务完成时归档 AXP 开的 Paseo worktree）和 Herdr 的 `worktree.*`、`tab.*`（[#4](https://github.com/Xuanwo/agenvo/pull/4)）从 0.2.0 起都在。

远程电脑上的 connector（`@agenvo/paseo`、`@agenvo/herdr`）与中继同一版本：控制面从中继的 `/health` 读出它的版本，`axp setup` 登记或报告时得到这个版本，从 npm 安装。控制面经中继的 MCP 工具 `execute` 调用 connector：每次调用是一段只含一次 `call` 的脚本，返回这次调用的结果。升级版本时要核对 agenvo 的破坏性变化（方法参数、MCP 工具、中继配置），旧版 connector 不支持的调用会报「connector 不支持……，需要更新」或「connector 需要更新」，在那台电脑上重新运行 `axp setup` 即可。

## 组成

| 部分         | 位置                                                                  | 作用                                                                                                                        |
| ------------ | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 任务看板     | `apps/control-plane/internal/tasks`、Web 的“任务”tab                  | 任务、时间线、运行；打开工作位置、派发与观察远程智能体、收尾（runner）                                                      |
| 中继         | `@agenvo/server`（`apps/relay/package.json`），生产 accessory `relay` | 远程电脑上的 connector 与中继配对、保持 WSS 连接；控制面经它调用 Paseo/Herdr                                                |
| 中继客户端   | `apps/control-plane/internal/relay`                                   | 管理员接口（配对、批准、撤销、状态）和 MCP `execute`                                                                        |
| `axp`        | `apps/remote`（Go，`/remote/dl/axp-<os>-<arch>`）                     | 远程电脑上的安装（`axp setup`）和给智能体用的 CLI                                                                           |
| tasks 插件   | `apps/agent-runtime/plugins/tasks`                                    | AXP 智能体读写看板：`list_tasks`、`get_task`、`list_assignees`、`list_places`、`create_task`、`update_task`、`comment_task` |
| 远程电脑设置 | Web 设置的“远程电脑”                                                  | 添加电脑（安装命令）、核对指纹后批准、在线状态、撤销                                                                        |

## 任务

`task` 有编号（`#12`）、标题、描述（Markdown）、状态和指派对象。状态与 multica 相同：backlog（积压）、todo（待办）、in_progress（进行中）、in_review（待验收）、done（已完成）、blocked（受阻）、cancelled（已取消）。

指派对象是三种之一：

- 没有人；
- 用户自己（`user`）：智能体把事情交给用户的方式；
- 远程智能体（`remote`）：一台电脑、它的一个运行时（`paseo` 或 `herdr`）、运行时里的一个 provider（`codex`、`claude`……），以及**工作位置**。provider 的可选项来自已配对的运行时。

任务由用户在 Web 里或由 AXP 智能体用 tasks 插件创建。发生在任务上的一切都是一条时间线（`task_activity`）：创建、评论、状态、指派、标题和描述的修改、运行的排队/开始/完成/失败/停止/被提醒、交付物（PR）和收尾。AXP 智能体不是指派对象：任务详情里的“让智能体反馈”给选中的智能体发一条聊天消息（queue 或 steer），请它用 `get_task` 读任务、用 `comment_task` 评论。远程智能体完成工作后不会自动通知任何 AXP 智能体。

## 工作位置

远程智能体在用户自己的 Paseo/Herdr 状态里工作，AXP 不另建目录、不替它 checkout。工作位置（`Place`）是二选一：

| 工作位置                                                | Paseo                                                                                         | Herdr                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 新 worktree（`{kind: worktree, from, branch?, base?}`） | 从 Paseo 的项目 branch-off（`paseo.workspaces.create`），worktree 由 Paseo 管理，挂在该项目下 | 从某个工作区的仓库开（`worktree.create`），worktree 由 Herdr 管理 |
| 已有工作区（`{kind: workspace, workspace_id}`）         | 在该工作区里开 agent                                                                          | 在该工作区里新开一个 tab 跑 agent，不占用户已有的 pane            |

分支默认是 `axp/<编号>-<标题 slug>`，base 默认是仓库当前的分支。可选项来自那台电脑的运行时，实时读取（`GET /api/v1/computers/{id}/runtimes/{kind}/places`，智能体用 `list_places`）：Paseo 的全部 git 项目（包括没有工作区的）和工作区（路径、分支、是否有未提交改动）；Herdr 的各个 session 里的工作区（目录取自它们的 pane）。Herdr 没有“项目”的概念，任何工作区的仓库都可以作为新 worktree 的来源。

worktree 只由运行时自己创建：Paseo 打开别人（git、Herdr）建的 worktree 时，会把它登记成一个独立的项目，而不是归到原仓库下。

## 运行

指派给远程智能体（且状态不是 backlog、done、cancelled），以及之后任何人（用户或 AXP 智能体）在任务下的每一条评论，都排一次运行（`task_run`）：远程智能体的一轮。同一个任务同时只有一次运行在进行；每台电脑最多同时进行 4 次。

| 状态                                 | 含义                                                       |
| ------------------------------------ | ---------------------------------------------------------- |
| `queued`                             | 等这个任务的上一轮和这台电脑的空位                         |
| `starting`                           | 打开工作位置、启动原生智能体（每个会话一次），然后发送指令 |
| `running`                            | 观察原生状态，直到这一轮结束                               |
| `completed` / `failed` / `cancelled` | 结束                                                       |

打开的工作位置和原生智能体是一个会话（`task_session`）：同一个任务、同一个指派的后续运行都发给它，所以追问在同一段上下文里继续；改派会关闭旧会话。会话记录设备、工作目录、原生 ID（Paseo 的 agent 和工作区；Herdr 的 session、agent 名、工作区、tab 和 pane）以及 AXP 开了什么（新 worktree 还是只开了 agent/tab）。原生 ID 在 connector 重启后依然有效，中继的 opaque 引用则不然。

Herdr 运行的是交互式终端程序。agent 启动后停在阻塞界面时，AXP 读一次 pane：只有 Claude Code 的“是否信任此文件夹”（`Is this a project you created or one you trust`）会被自动确认（发送 `down`、`enter`），由 Claude 自己记下对仓库的信任，之后这个仓库的 worktree 不会再问；其他阻塞界面一律不碰，启动失败并提示到那台电脑上查看。这符合 agenvo 的约定：阻塞时由调用方读界面、按自己的授权回答。

第一轮的指令是任务本身、工作位置的约定和回报规则，只点名 `axp` skill，不重复它的用法（见下文“`axp` 命令”）；后续是那条评论。智能体必须在每一轮结束前用 `axp task comment` 回复：一轮结束（Paseo 报告 turn 完成；或者看到它工作过、之后空闲；或者空闲足够久）时，若这一轮没有远程评论，就提醒它一次；提醒之后仍然没有评论，这次运行失败。

不重放写操作：发送指令之前先记下发送时间，中继无法确认结果（`unknown`、断线、超时）时，以原生状态核对（Paseo 的最后输入时间）；2 分钟内没有送达迹象才判为失败。打开工作位置没有可用的幂等键，结果不确定时运行直接失败，而不是冒险再开一个：打开之前先记下 `opening_at`，有它却没有会话记录的运行（打开时进程被杀掉）直接失败。一次启动开始之后，即使 runner 被要求停止（部署时的 SIGTERM）也会做完并记录；控制器等它结束才退出。启动过程中运行被停止、改派或任务完成时，不发送指令，刚打开的会话关闭并等待收尾。runner 只在控制器持有锁时运行，锁丢失时先停下，重新拿到锁再启动，所以按电脑的并发上限只由一个 runner 执行。离线的电脑可能还在干活：运行保持 `running`，不迁移到别的电脑。远程智能体空闲、turn 完成都不代表任务成功，验收以评论和交付物为准，由用户（或用户请来的智能体）决定。

停止一次运行：Paseo 调用原生 cancel，Herdr 发送 `esc`。

执行记录（`GET …/runs/{run}/log`）从远程智能体现读，不在 AXP 存：

- Paseo：用原生 `before` 游标从最新往前读，一页最多 20 条，按时间从旧到新排列，`older` 用来读更早的一页（`?before=`）。connector 遇到超过 64 KiB 的结果会整体拒绝（`result_too_large`），不会截断，所以这一页超限时条数减半重读，直到 1 条；第一次读成功就返回，页里不足 20 条也正常。
  - 1 条仍然超限时返回 424 `REMOTE_LOG_TOO_LARGE`，前端保留已经读到的记录。AXP 不知道一条记录占了哪些 seq，所以不猜着跳过它；需要跳过或截断时，应由原生端或 connector 给出能继续读的游标。
  - 时间线重建了（epoch 变化）时，旧游标失效，返回 409 `LOG_RESET`；前端的轮询会从最新一页重新开始读。
- Herdr：读最近 300 行终端输出，超限时依次改读 150、80 行。
- 读不到记录只是读失败，不影响运行状态，也不会重发任何东西。

## 收尾

任务改为 done 时，正在进行的运行被停止，会话关闭并等待收尾；运行停下后，runner 只处理 AXP 开的东西，在时间线上记一条 `cleanup`：

|       | 新 worktree                                                                           | 已有工作区                      |
| ----- | ------------------------------------------------------------------------------------- | ------------------------------- |
| Paseo | 归档工作区：agent 停止，worktree 目录删除，分支保留                                   | 归档 AXP 开的 agent，工作区不动 |
| Herdr | 删除 worktree，分支保留；有未提交改动时 Herdr 拒绝删除，worktree 保留并在时间线上说明 | 关掉 AXP 开的 tab               |

Paseo 归档 worktree 时不检查未提交的改动，未提交的内容会丢失；这是 Paseo 的行为，由用户承担（已提交的内容在分支上）。电脑离线时收尾稍后重试。启动失败的会话同样收尾。

## 远程电脑

### 接入

1. 设置 → 远程电脑 → 添加电脑，得到一条一次性的安装命令（24 小时内有效）：`curl -fsSL https://<AXP>/remote/install.sh | sh -s -- <code>`。
2. 在那台电脑上运行。脚本下载 `axp`，`axp setup` 检查 Node.js 24.13+ 以及正在运行的 Paseo daemon 和/或已安装的 Herdr（只检查，不代装），用安装码换到这台电脑的令牌并报告运行时和 provider，为这里的智能体装上 `axp` skill，从 npm 安装 agenvo connector（`@agenvo/<kind>`，AXP 给出的中继版本），给每个 connector 配置唯一的实例（以运行时命名）。
3. 每个 connector 以名字 `axp:<电脑 id>:<运行时>` 向中继发起配对，安装命令打印指纹并等待。设置页从中继的管理接口按这个名字找到待批准的配对，用户核对指纹一致后批准，控制面用管理员接口批准。同一个名字下有多个待批准的配对时（重跑了 `axp setup`，或别人用了同样的名字），设置页全部列出；批准请求带上用户核对的那个指纹，控制面只批准摘要完全一致的配对，对不上返回 409 `FINGERPRINT_MISMATCH`。
4. 批准后，安装命令用 agenvo 自己的 `service install` 把每个 connector 注册为用户服务（Linux systemd、macOS launchd）。之后在线状态就是中继看到的 connector 状态，AXP 与那台电脑之间没有别的进程或心跳。connector 的运行时有变化时（比如 Paseo daemon 换了身份），设置里会再次出现“等待批准”。再次运行 `axp setup` 会重新报告运行时，并接入新出现的运行时。
5. 撤销：设置里“撤销并移除”在中继上撤销这台电脑的设备，令牌随电脑一起删除；它的任务改为未指派。撤销不会停止已经在那台电脑上进行的工作。`axp uninstall` 卸载 connector 的服务并清除凭据。被移除的电脑要重新接入，在设置里复制新的安装命令再运行即可：带安装码的 `axp setup` 总是重新登记，登记成另一台电脑时先断开 connector 原来的配对（`disconnect`），再按新标签配对；不带安装码、而令牌已被删除时，`axp setup` 提示去复制新的安装命令。
6. 更新：connector 连上中继时报告自己的 agenvo 版本，中继只在 MCP `search` 的实例列表里给出（`connectorVersion`），控制面读取状态时一并读出，与中继自己的版本（`/health`）比较。不一致时设置里这台电脑显示“connector 需要更新”和“更新”按钮。“更新”（离线的电脑在“⋯”菜单里的“更新 connector”）为已接入的电脑生成新的安装命令，在那台电脑上运行：同一台电脑重新登记（令牌换新，配对保留），下载新的 `axp`，安装中继版本的 connector，把 connector 改到当前的中继地址并重启服务；connector 有变化时设置里出现“等待批准”，核对指纹后批准。只比较版本号。

`axp` 的配置（AXP 地址、令牌、中继地址）在安装目录里（`~/.local/share/axp/config.json`，0600），CLI 按自己二进制的位置找到它，所以在任何智能体的环境里都能用；安装时报告 `axp` 的路径，指令里也会告诉智能体。

### 隔离与权限

智能体以完全权限运行：Paseo 由 agenvo 设为 `full-access`/`bypassPermissions`；Herdr 由 AXP 在启动时传入各智能体跳过审批和沙箱的参数（`native.go` 的 `fullAccess`）。远程智能体能做那台电脑的用户能做的一切，设置页提示只接入专门用来干活的电脑。

### `axp` 命令

| 命令                                              | 作用                                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `axp task show`                                   | 任务的描述、状态和时间线                                                                                            |
| `axp task comment <text>` / `--file <path>`       | 在任务下回复（结束这一轮的条件）                                                                                    |
| `axp task status in_progress\|in_review\|blocked` | 远程智能体能设的状态                                                                                                |
| `axp gh <args…>`                                  | 经 AXP 的 GitHub App 运行 gh：用户授权过 App 时以用户的名义，否则是 App 的 bot；`gh pr create` 开出的 PR 记为交付物 |
| `axp setup` / `status` / `uninstall`              | 电脑本身的接入、查看和卸载                                                                                          |

怎么用这些命令（回报、状态、开 PR、补附件）只写在 `axp` skill 里（`apps/remote/skills/axp/SKILL.md`）：它编进 `axp` 二进制，`axp setup` 把它装到 `~/.claude/skills/axp`（Claude Code）和 `~/.agents/skills/axp`（Codex），`axp uninstall` 删除。skill 与 CLI 同一版本；控制面的指令和 AXP 智能体的插件都不再复述它。已接入的电脑重新运行一次安装命令即可装上。

`axp task` 的任务依次取自 `--task`、环境变量 `AXP_TASK_ID`（AXP 在 Herdr 里开的 tab 带着它），最后按当前目录向 AXP 查询（`/remote/v1/current-task`：这台电脑上哪个进行中的会话在这个目录或其上级工作）。git 用那台电脑自己的凭据；`axp gh` 向 AXP 要 gh 的 token（控制面向 forge 服务的 `/forge/credentials` 要，调用方记为 `computer-<id>`），与 runtime 里的智能体拿到的相同：用户授权过 App 时是用户的 token（`ghu_`），没有授权时是 installation token（见[代码托管](forge.md#身份)）。`axp gh` 先在 stderr 说明这次以谁的身份运行。

## 接口与鉴权

| 路径                                   | 调用方                             | 鉴权                                                                              |
| -------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `/api/v1/tasks*`、`/api/v1/computers*` | 浏览器（经 `gateway`）             | 与其余 `/api` 相同（边缘的 Cloudflare Access）                                    |
| `/remote/install.sh`、`/remote/dl/*`   | 远程电脑                           | 无（公开内容）                                                                    |
| `/remote/v1/enroll`                    | `axp setup`                        | 一次性安装码（只存摘要）                                                          |
| `/remote/v1/*`                         | `axp setup` 与 CLI                 | 电脑的令牌（`Authorization: Bearer`，只存摘要）；只能读写指派给它或它运行过的任务 |
| `/remote/relay/*`                      | connector（经 `gateway` 到中继）   | 中继自己：配对需在 AXP 里批准，之后用设备密钥；管理页用管理员密钥                 |
| `/tasks/mcp`                           | AXP 智能体（经 `runtime-gateway`） | runtime 网关注入的 `X-AXP-Agent-Id`                                               |

`/remote/` 在 `axp.akr.moe` 上绕过 Cloudflare Access（Access 的 Bypass 应用），其余路径不变。`/remote` 是公共 API 进程上一份独立的 huma 文档（`/remote/openapi.json`），不进 Web 的类型。

控制面调用中继：

- **管理员接口**（`/api/admin/*`，Bearer 管理员密钥）：状态（设备、实例、在线、待批准的配对）、批准配对（配对码 + 指纹）、批准实例、撤销设备。
- **MCP**（`/mcp`，工具 `execute`）：中继只接受 OAuth 访问令牌，令牌在所有者于浏览器中同意后签发。控制面持有管理员密钥，所以自己完成这一流程：动态注册客户端、用管理员密钥登录、读取同意页的一次性 handle 并同意、用授权码（S256 PKCE）换令牌。令牌存在表 `relay_token`（一行），API 与 controller 共用；刷新令牌只能用一次，所以刷新在事务的 advisory lock 下进行，授权失效（30 天或被撤销）时重新走一遍。

中继的公开地址是它的 base URL：生产为 AXP 地址下的 `/remote/relay`（`AXP_RELAY_BASE_URL`，由 `AXP_PUBLIC_URL` 推出）。它检查 `Host` 和路径前缀，所以控制面在内网访问它时也带上 base URL 的主机名和前缀。`axp setup` 登记或报告时从 AXP 得到这个地址；地址变化时（迁移、开发实例换端口），它把已配对的 connector 改到新地址并重启服务，不需要重新配对，因为设备随中继的状态保留。

## 部署

| 环境 | 中继                                                                                                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 开发 | `bun run dev` 在端口块的 `P+8` 启动，自签证书（`var/relay`）直接提供 TLS（开发网关是 HTTP），base URL 为 `https://localhost:P+8/remote/relay`。本机的 connector 用 `axp setup --ca-file var/relay/cert.pem` 信任它 |
| 生产 | accessory `relay`（`deploy/relay.Dockerfile`，标签为 agenvo commit 与 Dockerfile 的摘要，只在它们变化时重建并重启），状态在卷 `axp-relay`，不发布端口，由 `gateway` 在 `/remote/relay/*` 转发                      |

生产的中继在 AXP 自己的域名下（`https://axp.akr.moe/remote/relay`）：`/remote/` 已对 Cloudflare Access 放行，中继由自己的配对和设备密钥鉴权。`gateway` 把 `/remote/relay/*` 原样（保留 `Host` 和路径）转发给 `axp-relay:8080`，WebSocket（`/remote/relay/connect`）同样经过它；客户端地址取 Cloudflare 的 `CF-Connecting-IP` 作为 `X-Forwarded-For`（中继信任一跳），用于中继的限流。管理员密钥 `AXP_RELAY_ADMIN_SECRET` 由 `deploy.sh` 生成，同时交给中继和控制面。`AXP_PUBLIC_URL` 是安装命令里的 AXP 地址，没有设置时远程电脑功能关闭。

## 验证

- `apps/control-plane/internal/api/tasks_test.go`：用假的中继（Paseo 和 Herdr connector）覆盖接入（安装码只能用一次、按名字配对、批准、在线）、工作位置的查询、Paseo 新 worktree 从派发到完成和收尾（归档工作区）、已有工作区只归档 agent、Herdr 在新 worktree 的 tab 里运行（环境变量带任务 ID、自动确认 Claude 的信任对话框、有未提交改动时保留 worktree）、按目录找当前任务、提醒一次后失败、停止、改派、backlog、指派的校验、电脑之间的隔离，以及 AXP 智能体经 MCP 使用看板。
- `apps/control-plane/internal/relay`、`apps/remote`：MCP 应答的解析（JSON 与 SSE）、当前任务的来源。
- 切到上游 agenvo（`c7ca5dc`）并把中继放到 `/remote/relay` 下之后，在开发环境里用真实的中继、本机的 Paseo 和独立的 Herdr server（Claude）走过：带安装码的 `axp setup` 经 `/remote/relay` 配对并批准、控制面经 `execute` 读取两边的工作位置、Herdr 新 worktree 里完成一个任务（完全权限启动、自动确认信任对话框、智能体提交并回报）以及 done 后的收尾；把开发实例换到另一个端口后，不带安装码的 `axp setup` 把已配对的 connector 改到新地址，不重新配对即上线；注册服务时重跑 setup 会重启服务。没有在这一版上跑 Paseo 任务（Paseo 方法与之前相同），开发环境里注册为服务的 connector 不带开发中继的 CA，连不上自签证书的中继（生产不受影响）。
- 在开发环境里，用合入了 #3、#4 的 agenvo 构建、真实的中继、本机的 Paseo（Claude）和 Herdr（Claude）走过：运行安装命令、在设置里核对指纹并批准、读取工作位置、在 Paseo 新 worktree 和 Herdr 新 worktree 里各完成一个任务（Herdr 自动确认了 Claude 的信任对话框）、在 Herdr 已有工作区的新 tab 里完成一个任务，以及三者在 done 后的收尾。
