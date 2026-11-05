# 机器与 daemon

主 node 承载 Web、产品数据、模型凭据和记忆边车。其他机器跑精简的 daemon，不跑完整的 eta。

## machine

`machine` 表的 `kind`：

| kind      | 含义                                                                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------- |
| `primary` | 部署 host 的这台电脑，启动时自动建立（唯一索引保证只有一个）。会话在进程内运行                             |
| `daemon`  | 跑着 `eta-daemon` 的机器。状态 `pending`（已登记，等用户批准）、`online`、`offline`、`revoked`             |
| `ssh`     | 表结构保留了这个值；经 SSH 的执行环境在 `packages/eta-ssh`、`eta-plugin-ssh`，目前产品里没有对应的添加入口 |

project 指向 machine（`project.machine_id`），对话里的会话就在 project 所在的那台机器上、以 project 的目录为 cwd 运行。

## daemon 是什么

`apps/daemon` 用 `bun build --compile` 打成单文件 `eta-daemon`（`bun run --cwd apps/daemon build` → `out/eta-daemon`）。它只含内核、harness、execution、会话存储，以及上游 server 的 SessionManager 与 sessions 插件：**没有 Web、没有 SQLite、没有产品插件、没有 providers 配置**。会话的 kernel 与 journal 都在这台机器上，数据目录和宿主一样由 `$HOME` 决定：`~/.eta/daemon`（一个根，宿主占顶层，daemon 占 `daemon/`；`~/.eta/mcp.json` 和 persona 卡片就在同一个根里，不用跨树借用）。没有 `--data-dir`，也没有 `ETA_DAEMON_DIR`。

```text
eta-daemon setup <primary-url> <code> [--no-wait]   用安装码换一个位置，等待批准（--no-wait 登记完就返回）
eta-daemon run                           连接主 node 并提供服务（默认命令）
eta-daemon install-service               注册成 systemd 用户服务（Linux）或 launchd agent（macOS）
eta-daemon uninstall-service
eta-daemon version                       打印构建版本
```

首版支持 Linux 与 macOS；Windows 走 WSL。注册的是用户级服务，不需要 root，daemon 以会话要读写文件的同一个用户运行；服务单元里不写数据目录，用户服务的 `HOME` 就是那个用户的家目录，所以位置只有一处可说。

早于这次改动的版本把数据放在 `~/.eta-daemon`。新版本发现旧目录还在、新目录不在时会**拒绝启动**并打印迁移命令，不会把它当成空目录：那样等于会话还在磁盘上、在主 node 那边却全没了。已经注册过旧服务的话，先用旧版本 `uninstall-service`，再 `mkdir -p "$HOME/.eta" && mv "$HOME/.eta-daemon" "$HOME/.eta/daemon"`，然后用新版本重新 `install-service`。

## 配对

接入的方式照"一次性安装码的一条命令"：

1. 设置页（`machines.enroll`）生成安装码，**24 小时有效、一次性**，主 node 只存它的摘要（`machine_enrollment`）。界面给出整条命令：`eta-daemon setup <主 node 地址> <码>`。
2. 在新机器上执行。daemon **本地生成**一个 32 字节的密钥（`identity.json`，目录 0700、文件 0600），把密钥的 SHA-256 作为"指纹"，连同主机名、home、系统，`POST /machines/enroll`。主 node 校验安装码，创建 `pending` 的 machine，只保存指纹（密钥本身永远不离开 daemon）。
3. daemon 的终端显示指纹（八字符一组），设置页也显示同一个指纹；用户**核对一致后点批准**（`machines.approve`）。
4. daemon 连上后收到批准，变为 `online`。

安装码用错有限速（10 分钟内错误次数过多会被拒绝），请求体有大小上限。撤销（`machines.revoke`）会切断这条连接并拒绝再连；它**不会**停止已经在那台机器上运行的会话。

### tailnet

主 node 在 tailnet 上时（`main.ts` 默认读 `tailscale` 命令；没有 JS SDK，`status --json`、`whois --json` 的输出是稳定的），三件事变简单（`apps/eta/src/machines/tailscale.ts`）：

- **地址**：`--host tailscale` 监听本机的 tailnet 地址；新机器默认拨主 node 的 MagicDNS 名字（监听 tailnet 地址或所有接口时）。
- **免批准**：`POST /machines/enroll` 时用 TCP 对端地址做 `whois`（传输层记下的地址，不信任何头）。登录用户和主 node 自己是同一个、且不是 tagged node（tagged node 不属于任何用户）的，直接放行，并记下它的 node id（`machine.tailnet_node`）。别人的节点、tagged node、不在 tailnet 上的，照旧核对指纹。
- **发现**：`machines.discover` 列出 tailnet 的节点，标出哪些是用户自己的、哪些已经是这里的机器（按 node id，其次按名字）。

### 经 SSH 一步装好

`machines.install { host }`（`apps/eta/src/machines/install.ts`）用用户自己的 `ssh`（OpenSSH 或 Tailscale SSH，`BatchMode`，从不问密码）做人手会做的事：`uname` 判断平台 → 把主 node 带着的该平台构建传成 `~/.eta/bin/eta-daemon` → 用新安装码 `setup --no-wait` → `install-service`，Linux 上再试一下 `loginctl enable-linger`（让用户服务活过 SSH 会话，拒绝了不算失败）。哪一步失败，错误里说是哪一步、对方说了什么。之后它像别的 daemon 一样拨进来；tailnet 上用户自己的节点直接放行。

## 一条 WSS，三类流量

daemon **只出站**：它反向拨号 `GET /machines/connect`（WebSocket），凭证放在握手的 `Authorization` 头里，从不进地址。一条连接承载三个信道（`packages/client-contracts/src/link.ts`）：

| 信道   | 方向             | 内容                                                                                                                                                                                        |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipe` | 主 node → daemon | 普通的 eta 管道协议。daemon 是一个没有自己 socket 的 eta server，主 node 是它的客户端：`sessions.*` 在这里的含义和别处一样                                                                  |
| `svc`  | daemon → 主 node | daemon 缺的几样东西：生成（`model.stream`）、产品工具（`tool.call`）、审批名单（`tool.gate`）、MCP 凭据（`mcp.credential`）、GitHub 令牌（`github.credentials`）、提问通知（`ask.observe`） |
| `ctl`  | 双向             | `welcome`（哪台机器、第几个连接、是否已批准）、`approved`、心跳                                                                                                                             |

因此**模型凭据、OAuth 令牌（含 LLM 网关里的订阅账号）和用量只在主 node**：daemon 要生成时把请求交给主 node，主 node 解析模型、加凭据、向 provider 流式取回再逐事件送回，并计入用量。产品工具（任务、产物、记忆、`mention`、`web_fetch` / `web_search` 等）在主 node 上为对应的会话运行，它们的执行环境是经链路的 SSH 环境，所以读文件读的是那台机器的文件；读网页则是主 node 自己去抓。每个调用都带会话 id，且**只相信主 node 自己的行**：链路所属的机器必须就是该会话 project 的机器。

## 版本：daemon 跟着主 node

daemon 是主 node 的一部分。构建脚本（`apps/daemon/scripts/build.ts`，`build:all` 是四个平台）把版本用 `--define` 写进二进制（`ETA_DAEMON_VERSION`，默认是 commit，工作区有改动时加时间戳），并写 `out/dist/manifest.json`。主 node 带着这些构建：源码运行读 checkout 的 `apps/daemon/out/dist`；打包的 host 把四个平台的构建用 zstd 压缩后嵌在可执行文件里（`stage-host.ts`），`manifest.json` 原样带着，其中的 `sha256`、`size` 指解压后的文件。需要给出某个构建时才解压到 `~/.eta/unpacked/daemon-<hash>/`，核对 sha256 后使用；只问版本不解压。

- daemon 在 `machine.info` 里报 `version`、`platform`（`linux-x64`）、`install`（`service` / `binary` / `source`，看 systemd 的 `INVOCATION_ID`、launchd 的 `XPC_SERVICE_NAME`）和链路协议 `protocol`（`LINK_PROTOCOL`，没报的老 daemon 算 1）。主 node 存进 `machine` 行。
- **连上时版本和带着的不一致**，在让它做任何事之前先让它换（`svc` 的 `upgrade`）：daemon 带自己的凭据 `GET /machines/daemon/<platform>` 取构建，核对 sha256，写到可执行文件旁边，先跑一次 `version` 看能启动、版本对；然后旧文件改名为 `.prev`、新文件就位、在数据目录留一个标记，以 75 退出。systemd 的 `Restart=on-failure`、launchd 的 `KeepAlive.SuccessfulExit=false` 都会在非零退出时重启它。签名没有必要：链路是认证过的，主 node 本来就能在 daemon 上 `exec`。
- **新构建启动时结算标记**：90 秒内连回来就删标记和 `.prev`；没连回来，或启动 3 次都没连回来，就把 `.prev` 放回去再退出，由服务拉起旧版本。
- 换不了的（不是服务、从源码跑、没有对应平台的构建）照旧放进来，原因写在 `machine.update_error`，设置页显示；同一台机器、同一个目标版本一小时内不重复尝试，`machines.upgrade` 是手动重试。只有协议不兼容又换不了的才拒绝接入。
- 机器列表的 `build` 是 `current` / `outdated` / `updating`（没有构建或不是 daemon 时为 null）。

## 钉在一台机器上的智能体

智能体可以有 `machine_id`（null 是跟随项目）。钉住的智能体在任何项目里的会话都建在它的机器上，外部 runtime（Claude Code 等）用的是那台机器上的；`agents.runtimes { machineId }` 经链路问那台机器有哪些 runtime。

- 会话建在哪台机器记在 `participant.machine_id`（旧行为 null，等于项目的机器）；`ofSession`、`sessionsOn` 按它路由。智能体换了机器，下次唤醒在新机器上开新会话。
- 任务的 run 也在智能体的机器上（`task_run.machine_id`）。不在项目所在机器上时没有项目目录可用：cwd 是那台机器的 home，不建 worktree。
- 不在项目所在机器上时，智能体的 system prompt（平台段，不进对话记录，前端看不到）多一段只陈述确定事实的提示：它在哪台机器、这个对话或任务属于哪台机器、上下文里的路径可能是那台机器的，请自己在当前机器上找所需资源。这段算进会话的 stamp，变化时会话重开。

## epoch 与有界

- **每次连接是一个新的 epoch**（主 node 单调递增）。同一设备的新连接会顶替旧的（关闭码 4001），旧连接上的在途调用以"结果未知"失败。
- **断线重连不重放在途调用**。daemon 以递增的间隔重连（1 秒起，上限 30 秒，成功连上后复位）；主 node 在链路断开时把在途调用判为未知，不重发，以免重复执行。
- 一切有界：单帧最大 8 MiB（超出关闭码 1009）、每方同时在途 64 个调用、普通调用 30 秒、一次 run 最长 2 小时、心跳 15 秒、静默 45 秒视为断线。
- **大文件**：单帧的上限不变，读文件改成分窗：执行环境（`packages/eta-ssh`）整文件读取时每次最多拉 3 MiB（base64 后约 4 MiB），第一个窗口同时告诉文件大小，小文件仍然只有一次往返；二进制和文本（含 UTF-8 多字节字符跨窗口）都按字节拼接后再解码。这对 SSH 传输同样适用。

## 会话在远端

任务的运行也是这样的会话（键是 `task:<任务 id>`，一个任务的多次运行共用它；归属以 primary 的 `task_run` 行为准），每台机器同时运行的任务数是它的设置（`machine.max_active_runs`，默认 2），见[任务](tasks.md)。

- 回复进入 working 之前，`machine.lastSeq` 问 daemon 这个会话的 journal 写到哪了，记在回复行的 `data.runFrom` 上。页面只把序号比它大的 transcript 行算作这一轮：序号是 journal 自己分配的，不涉及两台机器的时钟。旧版 daemon 没有这个动作时回复照常运行，只是行上没有 `runFrom`。
- **GitHub 登录**：daemon 机器上的 git 与 gh 登录成 GitHub App（用户授权过就是用户）。daemon 经 `svc` 的 `github.credentials` 向主 node 要令牌（最多一小时，没连接是 `null`），写进自己数据目录的 `github/`，过期前再要；主 node 在 GitHub 连接、授权、断开时发 `machine.githubRefresh` 让它马上再问。App 的私钥、secret 与 refresh token 不出主 node，见 [GitHub](github.md)。
- **插件**：文件按内容哈希同步到 daemon，配置值只在内存里，见[插件](plugins.md)。
- 引擎问"位置"（`SessionPlace`）要一个智能体的会话：本机是 `LocalPlace`，远端是 `RemotePlace`：一次 `machine.open` 把会话和智能体对齐，智能体的指令、模型、思考档、persona 卡和产品工具清单随调用送过去（daemon 注册代理工具，调用时回到主 node 执行）。之后一次 run 是一个长调用（`machine.run`），steer/stop 是 daemon 管道上的普通 `sessions.*` 调用。
- **镜像**：浏览器订阅 `sessions.<id>` 时不需要知道会话在哪台机器。主 node 为远端会话注册同名 target，有人订阅时就订阅 daemon 的同一 target，把它的状态（先整份后 patch）与事件原样再发布；没人看了就取消订阅。链路断开则全部降温，恢复后只重新唤醒仍有人看的。重新订阅时 daemon 会把事件环从头回放一遍；事件帧带 `at`（发生的时刻，毫秒，同一 target 内严格递增，daemon 重启后也不回退），镜像只转发比上次转发的更晚的事件，浏览器不会看到重复的事件。
- **全局列表**：主 node 在链路在线期间订阅 daemon 自己的 `sessions` 列表，把它的会话并进全局 `sessions` 的 `list`（行上有 `machine`，即机器名）。daemon 不可达时保留最后一次的行，打上 `offline` 标记、去掉 `running`。
- **断线期间的提问**：daemon 上的提问、回答、取消通过 `ask.observe` 通知主 node；链路不在时这些通知排队（至多 256 条，最旧的先丢），下一条链路接上后按顺序补发，主 node 在接入后立刻开始应答（不必等机器被报告为就绪）。
- 主 node 重启后，从 `participant` 行得知哪些会话在哪台机器，重新挂上；daemon 重启时从 journal 读回会话。
- `sessions.*` 的调用按会话所在的机器路由（`RemoteSessionsRouter`），一般调用 1 分钟、长调用 10 分钟的上限。
