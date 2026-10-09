# 任务与远程电脑

本文说明 [#45](https://github.com/AkaraChen/axp/issues/45) 的实现：一个像 [multica](https://github.com/multica-ai/multica) 那样的任务看板，任务可以指派给用户自己，或者指派给用户其他电脑上的编码智能体。远程电脑通过 [agenvo](https://github.com/AkaraChen/agenvo) 中继接入，智能体跑在那台电脑的 [Paseo](https://paseo.sh) 或 [Herdr](https://herdr.dev) 里，工作在用户自己的项目和工作区中。

## agenvo

`vendor/agenvo` 指向自己维护的 fork [AkaraChen/agenvo](https://github.com/AkaraChen/agenvo)，它的 main 在上游之上合入了两项远程电脑依赖、但上游尚未合入的能力：

- [Xuanwo/agenvo#3](https://github.com/Xuanwo/agenvo/pull/3)：`paseo.workspaces.archive`，任务完成时归档 AXP 开的 Paseo worktree。
- [Xuanwo/agenvo#4](https://github.com/Xuanwo/agenvo/pull/4)：Herdr 的 `worktree.list/create/open/remove` 和 `tab.create/close`。

中继和远程电脑上的 connector 都从这个 submodule 构建（`/remote/dl/agenvo-<kind>.tgz`）。旧版 connector 没有这些方法，调用时报「connector 不支持……，需要更新」，在那台电脑上重新运行 `axp setup` 即可。上游合入后，fork 跟进上游再升级 submodule。

## 组成

| 部分         | 位置                                                                       | 作用                                                                                                                        |
| ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 任务看板     | `apps/control-plane/internal/tasks`、Web 的“任务”tab                       | 任务、时间线、运行；打开工作位置、派发与观察远程智能体、收尾（runner）                                                      |
| 中继         | `vendor/agenvo`（submodule，固定在 fork 的提交上），生产 accessory `relay` | 远程电脑上的 connector 与中继配对、保持 WSS 连接；控制面经它调用 Paseo/Herdr                                                |
| 中继客户端   | `apps/control-plane/internal/relay`                                        | 管理员接口（配对、批准、撤销、状态）和 MCP `runtime_call`                                                                   |
| `axp`        | `apps/remote`（Go，`/remote/dl/axp-<os>-<arch>`）                          | 远程电脑上的安装（`axp setup`）和给智能体用的 CLI                                                                           |
| tasks 插件   | `apps/agent-runtime/plugins/tasks`                                         | AXP 智能体读写看板：`list_tasks`、`get_task`、`list_assignees`、`list_places`、`create_task`、`update_task`、`comment_task` |
| 远程电脑设置 | Web 设置的“远程电脑”                                                       | 添加电脑（安装命令）、核对指纹后批准、在线状态、撤销                                                                        |

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

不重放写操作：发送指令之前先记下发送时间，中继无法确认结果（`unknown`、断线、超时）时，以原生状态核对（Paseo 的最后输入时间）；2 分钟内没有送达迹象才判为失败。打开工作位置没有可用的幂等键，结果不确定时运行直接失败，而不是冒险再开一个。离线的电脑可能还在干活：运行保持 `running`，不迁移到别的电脑。远程智能体空闲、turn 完成都不代表任务成功，验收以评论和交付物为准，由用户（或用户请来的智能体）决定。

停止一次运行：Paseo 调用原生 cancel，Herdr 发送 `esc`。

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
2. 在那台电脑上运行。脚本下载 `axp`，`axp setup` 检查 Node.js 24.13+ 以及正在运行的 Paseo daemon 和/或已安装的 Herdr（只检查，不代装），用安装码换到这台电脑的令牌并报告运行时和 provider，为这里的智能体装上 `axp` skill，从 AXP 下载并安装 agenvo connector（`/remote/dl/agenvo-<kind>.tgz`，与中继同一版本），给每个 connector 配置唯一的实例（以运行时命名）。
3. 每个 connector 以名字 `axp:<电脑 id>:<运行时>` 向中继发起配对，安装命令打印指纹并等待。设置页从中继的管理接口按这个名字找到待批准的配对，用户核对指纹一致后批准，控制面用管理员接口批准。
4. 批准后，安装命令用 agenvo 自己的 `service install` 把每个 connector 注册为用户服务（Linux systemd、macOS launchd）。之后在线状态就是中继看到的 connector 状态，AXP 与那台电脑之间没有别的进程或心跳。connector 的运行时有变化时（比如 Paseo daemon 换了身份），设置里会再次出现“等待批准”。再次运行 `axp setup` 会重新报告运行时，并接入新出现的运行时。
5. 撤销：设置里“撤销并移除”在中继上撤销这台电脑的设备，令牌随电脑一起删除；它的任务改为未指派。撤销不会停止已经在那台电脑上进行的工作。`axp uninstall` 卸载 connector 的服务并清除凭据。

`axp` 的配置（AXP 地址、令牌、中继地址）在安装目录里（`~/.local/share/axp/config.json`，0600），CLI 按自己二进制的位置找到它，所以在任何智能体的环境里都能用；安装时报告 `axp` 的路径，指令里也会告诉智能体。

### 隔离与权限

agenvo 让 Codex 和 Claude 以完全权限运行（Paseo 的 `full-access`/`bypassPermissions`，Herdr 的跳过审批参数）。远程智能体能做那台电脑的用户能做的一切，设置页提示只接入专门用来干活的电脑。

### `axp` 命令

| 命令                                              | 作用                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `axp task show`                                   | 任务的描述、状态和时间线                                                                                           |
| `axp task comment <text>` / `--file <path>`       | 在任务下回复（结束这一轮的条件）                                                                                   |
| `axp task status in_progress\|in_review\|blocked` | 远程智能体能设的状态                                                                                               |
| `axp gh <args…>`                                  | 以 AXP 的 GitHub App 身份运行 gh（`gh pr …` 在用户授权过 App 时以用户的名义）；`gh pr create` 开出的 PR 记为交付物 |
| `axp setup` / `status` / `uninstall`              | 电脑本身的接入、查看和卸载                                                                                         |

怎么用这些命令（回报、状态、开 PR、补附件）只写在 `axp` skill 里（`apps/remote/skills/axp/SKILL.md`）：它编进 `axp` 二进制，`axp setup` 把它装到 `~/.claude/skills/axp`（Claude Code）和 `~/.agents/skills/axp`（Codex），`axp uninstall` 删除。skill 与 CLI 同一版本；控制面的指令和 AXP 智能体的插件都不再复述它。已接入的电脑重新运行一次安装命令即可装上。

`axp task` 的任务依次取自 `--task`、环境变量 `AXP_TASK_ID`（AXP 在 Herdr 里开的 tab 带着它），最后按当前目录向 AXP 查询（`/remote/v1/current-task`：这台电脑上哪个进行中的会话在这个目录或其上级工作）。git 用那台电脑自己的凭据；`axp gh` 向 AXP 要 GitHub App 的 installation token（控制面向 forge 服务的 `/forge/credentials` 要，调用方记为 `computer-<id>`）；`axp gh pr …` 要的是 `?as=user`：用户授权过 App 时是用户的 token（`ghu_`），PR 以用户的名义打开，没有授权时仍是 installation token。

## 接口与鉴权

| 路径                                   | 调用方                             | 鉴权                                                                              |
| -------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `/api/v1/tasks*`、`/api/v1/computers*` | 浏览器（经 `gateway`）             | 与其余 `/api` 相同（边缘的 Cloudflare Access）                                    |
| `/remote/install.sh`、`/remote/dl/*`   | 远程电脑                           | 无（公开内容）                                                                    |
| `/remote/v1/enroll`                    | `axp setup`                        | 一次性安装码（只存摘要）                                                          |
| `/remote/v1/*`                         | `axp setup` 与 CLI                 | 电脑的令牌（`Authorization: Bearer`，只存摘要）；只能读写指派给它或它运行过的任务 |
| `/tasks/mcp`                           | AXP 智能体（经 `runtime-gateway`） | runtime 网关注入的 `X-AXP-Agent-Id`                                               |

`/remote/` 在 `axp.akr.moe` 上绕过 Cloudflare Access（Access 的 Bypass 应用），其余路径不变。`/remote` 是公共 API 进程上一份独立的 huma 文档（`/remote/openapi.json`），不进 Web 的类型。

控制面调用中继：

- **管理员接口**（`/api/admin/*`，Bearer 管理员密钥）：状态（设备、实例、在线、待批准的配对）、批准配对（配对码 + 指纹）、批准实例、撤销设备。
- **MCP**（`/mcp`）：中继只接受 OAuth 访问令牌，令牌在所有者于浏览器中同意后签发。控制面持有管理员密钥，所以自己完成这一流程：动态注册客户端、用管理员密钥登录、读取同意页的一次性 handle 并同意、用授权码（S256 PKCE）换令牌。令牌存在表 `relay_token`（一行），API 与 controller 共用；刷新令牌只能用一次，所以刷新在事务的 advisory lock 下进行，授权失效（30 天或被撤销）时重新走一遍。

中继检查 `Host` 是否等于它的公开 origin，所以控制面在内网访问它时也带上 origin 的主机名。

## 部署

| 环境 | 中继                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开发 | `bun run dev` 在端口块的 `P+8` 启动，自签证书（`var/relay`）直接提供 TLS，origin 为 `https://localhost:P+8`。本机的 connector 用 `axp setup --ca-file var/relay/cert.pem` 信任它 |
| 生产 | accessory `relay`（`deploy/relay.Dockerfile`，标签为 agenvo commit 与 Dockerfile 的摘要，只在它们变化时重建并重启），状态在卷 `axp-relay`，发布在 `127.0.0.1:24170`              |

生产的中继有自己的公网主机名（`production.env` 的 `AXP_RELAY_ORIGIN`，例如 `https://axp-relay.akr.moe`）：connector 只接受不带路径的 origin，而中继占用根路径（`/connect`、`/pairings`、`/mcp`……），不能放在 AXP 的路径下；这个主机名不经过 Cloudflare Access，由中继自己的配对和令牌鉴权。宿主机的反向代理把它转发到 `127.0.0.1:24170`，保留 `Host`；中继信任这一跳的 `X-Forwarded-For`。管理员密钥 `AXP_RELAY_ADMIN_SECRET` 由 `deploy.sh` 生成，同时交给中继和控制面。`AXP_PUBLIC_URL` 是安装命令里的 AXP 地址。没有设置 `AXP_RELAY_ORIGIN` 时远程电脑功能关闭。

## 验证

- `apps/control-plane/internal/api/tasks_test.go`：用假的中继（Paseo 和 Herdr connector）覆盖接入（安装码只能用一次、按名字配对、批准、在线）、工作位置的查询、Paseo 新 worktree 从派发到完成和收尾（归档工作区）、已有工作区只归档 agent、Herdr 在新 worktree 的 tab 里运行（环境变量带任务 ID、自动确认 Claude 的信任对话框、有未提交改动时保留 worktree）、按目录找当前任务、提醒一次后失败、停止、改派、backlog、指派的校验、电脑之间的隔离，以及 AXP 智能体经 MCP 使用看板。
- `apps/control-plane/internal/relay`、`apps/remote`：MCP 应答的解析（JSON 与 SSE）、当前任务的来源。
- 在开发环境里，用合入了 #3、#4 的 agenvo 构建、真实的中继、本机的 Paseo（Claude）和 Herdr（Claude）走过：运行安装命令、在设置里核对指纹并批准、读取工作位置、在 Paseo 新 worktree 和 Herdr 新 worktree 里各完成一个任务（Herdr 自动确认了 Claude 的信任对话框）、在 Herdr 已有工作区的新 tab 里完成一个任务，以及三者在 done 后的收尾。
