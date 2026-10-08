# 任务与远程电脑

本文说明 [#45](https://github.com/AkaraChen/axp/issues/45) 的实现：一个像 [multica](https://github.com/multica-ai/multica) 那样的任务看板，任务可以指派给用户自己，或者指派给用户其他电脑上的编码智能体。远程电脑通过 [agenvo](https://github.com/Xuanwo/agenvo) 中继接入，智能体跑在那台电脑的 [Paseo](https://paseo.sh) 或 [Herdr](https://herdr.dev) 里。

## 组成

| 部分         | 位置                                                                   | 作用                                                                                                         |
| ------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 任务看板     | `apps/control-plane/internal/tasks`、Web 的“任务”tab                   | 任务、时间线、运行；派发与观察远程智能体（runner）                                                           |
| 中继         | `vendor/agenvo`（submodule，固定版本，不改动），生产 accessory `relay` | 远程电脑上的 connector 与中继配对、保持 WSS 连接；控制面经它调用 Paseo/Herdr                                 |
| 中继客户端   | `apps/control-plane/internal/relay`                                    | 管理员接口（配对、批准、撤销、状态）和 MCP `runtime_call`                                                    |
| `axp`        | `apps/remote`（Go，`/remote/dl/axp-<os>-<arch>`）                      | 远程电脑上的 daemon（看护 connector、心跳、建工作区）和给智能体用的 CLI                                      |
| tasks 插件   | `apps/agent-runtime/plugins/tasks`                                     | AXP 智能体读写看板：`list_tasks`、`get_task`、`create_task`、`update_task`、`comment_task`、`list_assignees` |
| 远程电脑设置 | Web 设置的“远程电脑”                                                   | 添加电脑（安装命令）、核对指纹后批准、在线状态、撤销                                                         |

## 任务

`task` 有编号（`#12`）、标题、描述（Markdown）、状态和指派对象，可选关联一个 GitHub 仓库（`owner/name`）。状态与 multica 相同：backlog（积压）、todo（待办）、in_progress（进行中）、in_review（待验收）、done（已完成）、blocked（受阻）、cancelled（已取消）。

指派对象是三种之一：

- 没有人；
- 用户自己（`user`）：智能体把事情交给用户的方式；
- 远程智能体（`remote`）：一台电脑、它的一个运行时（`paseo` 或 `herdr`）和运行时里的一个 provider（`codex`、`claude`……）。可选项来自已配对的运行时和 daemon 报告的 provider。

任务由用户在 Web 里或由 AXP 智能体用 tasks 插件创建。发生在任务上的一切都是一条时间线（`task_activity`）：创建、评论、状态、指派、标题和描述的修改、运行的排队/开始/完成/失败/停止/被提醒、仓库的 checkout（仓库、分支、起始 commit）和交付物（PR）。AXP 智能体不是指派对象：任务详情里的“让智能体反馈”给选中的智能体发一条聊天消息（queue 或 steer），请它用 `get_task` 读任务、用 `comment_task` 评论。远程智能体完成工作后不会自动通知任何 AXP 智能体。

## 运行

指派给远程智能体（且状态不是 backlog、done、cancelled），以及之后任何人（用户或 AXP 智能体）在任务下的每一条评论，都排一次运行（`task_run`）：远程智能体的一轮。同一个任务同时只有一次运行在进行；每台电脑最多同时进行 4 次。

| 状态                                 | 含义                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `queued`                             | 等这个任务的上一轮和这台电脑的空位                                                          |
| `preparing`                          | daemon 在下一次心跳里收到要求，建好工作区 `<root>/<任务 id>/` 后报告；10 分钟没准备好则失败 |
| `starting`                           | 在工作区里打开原生智能体（每个会话一次），然后发送指令                                      |
| `running`                            | 观察原生状态，直到这一轮结束                                                                |
| `completed` / `failed` / `cancelled` | 结束                                                                                        |

控制面经中继打开的原生智能体是一个会话（`task_session`）：同一个任务、同一个指派对象的后续运行都发给它，所以追问在同一段上下文里继续；改派会关闭旧会话。会话记录设备、实例、工作区和原生 ID（Paseo 的 agent ID；Herdr 的 session、agent 名、pane 和 workspace），原生 ID 在 connector 重启后依然有效，中继的 opaque 引用则不然。

第一轮的指令是 CLI 的用法、规则和任务本身；后续是那条评论。智能体必须在每一轮结束前用 `axp task comment` 回复：一轮结束（Paseo 报告 turn 完成；或者看到它工作过、之后空闲；或者空闲足够久）时，若这一轮没有远程评论，就提醒它一次；提醒之后仍然没有评论，这次运行失败。

不重放写操作：发送指令之前先记下发送时间，中继无法确认结果（`unknown`、断线、超时）时，以原生状态核对（Paseo 的最后输入时间）；2 分钟内没有送达迹象才判为失败。打开原生智能体没有可用的幂等键，结果不确定时运行直接失败，而不是冒险再开一个。离线的电脑可能还在干活：运行保持 `running`，不迁移到别的电脑。远程智能体空闲、`turn` 完成都不代表任务成功，验收以评论和交付物为准，由用户（或用户请来的智能体）决定。

停止一次运行：Paseo 调用原生 cancel，Herdr 发送 `esc`。

## 远程电脑

### 接入

1. 设置 → 远程电脑 → 添加电脑，得到一条一次性的安装命令（24 小时内有效）：`curl -fsSL https://<AXP>/remote/install.sh | sh -s -- <code>`。
2. 在那台电脑上运行。脚本下载 `axp`，`axp setup` 检查 Node.js 24.13+ 以及正在运行的 Paseo daemon 和/或已安装的 Herdr（只检查，不代装），从 AXP 下载并安装 agenvo connector（`/remote/dl/agenvo-<kind>.tgz`，与中继同一版本），用安装码换到这台电脑的令牌，配置每个 connector 的唯一实例（以运行时命名），把 `axp daemon` 注册为用户服务（Linux systemd、macOS launchd）。任务根目录默认 `~/axp/tasks`（`--root`）。
3. daemon 为每个运行时运行 `connect`：connector 向中继发起配对，打印设备指纹；daemon 把配对码和指纹报给 AXP。用户在设置里核对指纹与 daemon 日志一致后批准，控制面用管理员接口批准配对，connector 拿到设备身份后，daemon 改为运行 `run` 并一直看护它（退出后重启，清理残留的锁）。connector 的运行时有变化时（比如 Paseo daemon 换了身份），设置里会再次出现“等待批准”。
4. 撤销：设置里“撤销并移除”在中继上撤销这台电脑的设备，令牌随电脑一起删除；它的任务改为未指派。撤销不会停止已经在那台电脑上进行的工作。daemon 被 AXP 拒绝后停止。

`axp` 的配置（AXP 地址、令牌、中继地址、任务根目录）在安装目录里（`~/.local/share/axp/config.json`，0600），CLI 按自己二进制的位置找到它，所以在任何智能体的环境里都能用；daemon 在心跳里报告 `axp` 的路径，指令里也会告诉智能体。

### 隔离与权限

agenvo 让 Codex 和 Claude 以完全权限运行（Paseo 的 `full-access`/`bypassPermissions`，Herdr 的跳过审批参数）。隔离依靠：每个任务一个工作区目录、规则要求只在任务目录里修改文件，以及“只接入专门用来干活的电脑”（设置页里的提示）。远程智能体能做那台电脑的用户能做的一切。

Herdr 运行的是交互式的终端程序：daemon 把任务根目录标记为 Claude Code 信任的目录（`~/.claude.json`），否则每个新任务目录都会停在信任确认界面；其他交互提示（例如 Codex 的升级提示）需要用户在那台电脑上处理，执行记录里能看到终端内容。

### `axp` 命令

| 命令                                              | 作用                                                                                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `axp task show`                                   | 任务的描述、状态和时间线                                                                                          |
| `axp task comment <text>` / `--file <path>`       | 在任务下回复（结束这一轮的条件）                                                                                  |
| `axp task status in_progress\|in_review\|blocked` | 远程智能体能设的状态                                                                                              |
| `axp repo checkout <owner/name> [--ref R]`        | 用 AXP 的 GitHub App 克隆到 `<工作区>/<name>`，新建分支 `axp/<编号>`，记录起始 commit；已存在则保持原样，只 fetch |
| `axp gh <args…>`                                  | 以 App 的身份运行 gh；`gh pr create` 开出的 PR 记为交付物                                                         |
| `axp setup` / `daemon` / `status` / `uninstall`   | 电脑本身的安装、运行、检查和卸载                                                                                  |

任务由工作目录决定：`<root>/<任务 id>/` 及其子目录。git 的凭据助手是 `axp git-credential`，每次向 AXP 要 GitHub App 的 installation token（控制面向 forge 服务的 `/forge/credentials` 要，调用方记为 `computer-<id>`），提交以 App 的 bot 身份署名。

## 接口与鉴权

| 路径                                   | 调用方                             | 鉴权                                                                              |
| -------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| `/api/v1/tasks*`、`/api/v1/computers*` | 浏览器（经 `gateway`）             | 与其余 `/api` 相同（边缘的 Cloudflare Access）                                    |
| `/remote/install.sh`、`/remote/dl/*`   | 远程电脑                           | 无（公开内容）                                                                    |
| `/remote/v1/enroll`                    | `axp setup`                        | 一次性安装码（只存摘要）                                                          |
| `/remote/v1/*`                         | daemon 与 CLI                      | 电脑的令牌（`Authorization: Bearer`，只存摘要）；只能读写指派给它或它运行过的任务 |
| `/tasks/mcp`                           | AXP 智能体（经 `runtime-gateway`） | runtime 网关注入的 `X-AXP-Agent-Id`                                               |

`/remote/` 在 `axp.akr.moe` 上绕过 Cloudflare Access（Access 的 Bypass 应用），其余路径不变。`/remote` 是公共 API 进程上一份独立的 huma 文档（`/remote/openapi.json`），不进 Web 的类型。

控制面调用中继：

- **管理员接口**（`/api/admin/*`，Bearer 管理员密钥）：状态（设备、实例、在线）、批准配对（配对码 + 指纹）、批准实例、撤销设备。
- **MCP**（`/mcp`）：中继只接受 OAuth 访问令牌，令牌在所有者于浏览器中同意后签发。控制面持有管理员密钥，所以自己完成这一流程：动态注册客户端、用管理员密钥登录、读取同意页的一次性 handle 并同意、用授权码（S256 PKCE）换令牌。令牌存在表 `relay_token`（一行），API 与 controller 共用；刷新令牌只能用一次，所以刷新在事务的 advisory lock 下进行，授权失效（30 天或被撤销）时重新走一遍。

中继检查 `Host` 是否等于它的公开 origin，所以控制面在内网访问它时也带上 origin 的主机名。

## 部署

| 环境 | 中继                                                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开发 | `bun run dev` 在端口块的 `P+8` 启动，自签证书（`var/relay`）直接提供 TLS，origin 为 `https://localhost:P+8`。本机的 connector 用 `axp setup --ca-file var/relay/cert.pem` 信任它 |
| 生产 | accessory `relay`（`deploy/relay.Dockerfile`，标签为 agenvo commit 与 Dockerfile 的摘要，只在它们变化时重建并重启），状态在卷 `axp-relay`，发布在 `127.0.0.1:24170`              |

生产的中继有自己的公网主机名（`production.env` 的 `AXP_RELAY_ORIGIN`，例如 `https://axp-relay.akr.moe`）：connector 只接受不带路径的 origin，而中继占用根路径（`/connect`、`/pairings`、`/mcp`……），不能放在 AXP 的路径下；这个主机名不经过 Cloudflare Access，由中继自己的配对和令牌鉴权。宿主机的反向代理把它转发到 `127.0.0.1:24170`，保留 `Host`；中继信任这一跳的 `X-Forwarded-For`。管理员密钥 `AXP_RELAY_ADMIN_SECRET` 由 `deploy.sh` 生成，同时交给中继和控制面。`AXP_PUBLIC_URL` 是安装命令里的 AXP 地址。没有设置 `AXP_RELAY_ORIGIN` 时远程电脑功能关闭。

## 验证

- `apps/control-plane/internal/api/tasks_test.go`：用假的中继（Paseo connector）走完接入（安装码只能用一次、配对、批准、在线）、派发（准备工作区、打开智能体、指令里带 CLI 路径和仓库）、远程的 checkout/评论/状态/交付物、完成、执行记录、追问发给同一个会话、提醒一次后失败、停止、改派、backlog、电脑之间的隔离，以及 AXP 智能体经 MCP 使用看板。
- `apps/control-plane/internal/relay`、`apps/remote`：MCP 应答的解析（JSON 与 SSE）、任务目录的识别、仓库名。
- 在开发环境里用真实的 agenvo 中继、本机的 Paseo（Claude）和 Herdr（Claude）走过：安装命令、在设置里批准、建任务、远程智能体回复并改为待验收、追问、提醒、停止、执行记录，以及 AXP 智能体通过 tasks 插件建任务和评论。
