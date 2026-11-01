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
eta-daemon setup <primary-url> <code>   用安装码换一个位置，等待批准
eta-daemon run                           连接主 node 并提供服务（默认命令）
eta-daemon install-service               注册成 systemd 用户服务（Linux）或 launchd agent（macOS）
eta-daemon uninstall-service
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

## 一条 WSS，三类流量

daemon **只出站**：它反向拨号 `GET /machines/connect`（WebSocket），凭证放在握手的 `Authorization` 头里，从不进地址。一条连接承载三个信道（`packages/client-contracts/src/link.ts`）：

| 信道   | 方向             | 内容                                                                                                                                                                                        |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipe` | 主 node → daemon | 普通的 eta 管道协议。daemon 是一个没有自己 socket 的 eta server，主 node 是它的客户端：`sessions.*` 在这里的含义和别处一样                                                                  |
| `svc`  | daemon → 主 node | daemon 缺的几样东西：生成（`model.stream`）、产品工具（`tool.call`）、审批名单（`tool.gate`）、MCP 凭据（`mcp.credential`）、GitHub 令牌（`github.credentials`）、提问通知（`ask.observe`） |
| `ctl`  | 双向             | `welcome`（哪台机器、第几个连接、是否已批准）、`approved`、心跳                                                                                                                             |

因此**模型凭据、OAuth 令牌（含 LLM 网关里的订阅账号）和用量只在主 node**：daemon 要生成时把请求交给主 node，主 node 解析模型、加凭据、向 provider 流式取回再逐事件送回，并计入用量。产品工具（任务、产物、记忆、`mention`、`web_fetch` / `web_search` 等）在主 node 上为对应的会话运行，它们的执行环境是经链路的 SSH 环境，所以读文件读的是那台机器的文件；读网页则是主 node 自己去抓。每个调用都带会话 id，且**只相信主 node 自己的行**：链路所属的机器必须就是该会话 project 的机器。

## epoch 与有界

- **每次连接是一个新的 epoch**（主 node 单调递增）。同一设备的新连接会顶替旧的（关闭码 4001），旧连接上的在途调用以"结果未知"失败。
- **断线重连不重放在途调用**。daemon 以递增的间隔重连（1 秒起，上限 30 秒，成功连上后复位）；主 node 在链路断开时把在途调用判为未知，不重发，以免重复执行。
- 一切有界：单帧最大 8 MiB（超出关闭码 1009）、每方同时在途 64 个调用、普通调用 30 秒、一次 run 最长 2 小时、心跳 15 秒、静默 45 秒视为断线。
- **大文件**：单帧的上限不变，读文件改成分窗：执行环境（`packages/eta-ssh`）整文件读取时每次最多拉 3 MiB（base64 后约 4 MiB），第一个窗口同时告诉文件大小，小文件仍然只有一次往返；二进制和文本（含 UTF-8 多字节字符跨窗口）都按字节拼接后再解码。这对 SSH 传输同样适用。

## 会话在远端

任务的运行也是这样的会话（键是 `task:<任务 id>`，一个任务的多次运行共用它；归属以 primary 的 `task_run` 行为准），每台机器同时运行的任务数是它的设置（`machine.max_active_runs`，默认 2），见[任务](tasks.md)。

- 智能体载入的环境包随会话走：`machine.bundleHave` / `machine.bundlePut` 把 daemon 没有的包的文件送过去，`machine.open` 带上包的哈希和配置值（见[环境包](bundles.md#daemon)）；`machine.which` 让 daemon 回答它的 PATH 上有哪些命令。
- **GitHub 登录**：daemon 机器上的 git 与 gh 登录成 GitHub App（用户授权过就是用户）。daemon 经 `svc` 的 `github.credentials` 向主 node 要令牌（最多一小时，没连接是 `null`），写进自己数据目录的 `github/`，过期前再要；主 node 在 GitHub 连接、授权、断开时发 `machine.githubRefresh` 让它马上再问。App 的私钥、secret 与 refresh token 不出主 node，见 [GitHub](github.md)。
- 引擎问"位置"（`SessionPlace`）要一个智能体的会话：本机是 `LocalPlace`，远端是 `RemotePlace`：一次 `machine.open` 把会话和智能体对齐，智能体的指令、模型、思考档、persona 卡和产品工具清单随调用送过去（daemon 注册代理工具，调用时回到主 node 执行）。之后一次 run 是一个长调用（`machine.run`），steer/stop 是 daemon 管道上的普通 `sessions.*` 调用。
- **镜像**：浏览器订阅 `sessions.<id>` 时不需要知道会话在哪台机器。主 node 为远端会话注册同名 target，有人订阅时就订阅 daemon 的同一 target，把它的状态（先整份后 patch）与事件原样再发布；没人看了就取消订阅。链路断开则全部降温，恢复后只重新唤醒仍有人看的。重新订阅时 daemon 会把事件环从头回放一遍；事件帧带 `at`（发生的时刻，毫秒，同一 target 内严格递增，daemon 重启后也不回退），镜像只转发比上次转发的更晚的事件，浏览器不会看到重复的事件。
- **全局列表**：主 node 在链路在线期间订阅 daemon 自己的 `sessions` 列表，把它的会话并进全局 `sessions` 的 `list`（行上有 `machine`，即机器名）。daemon 不可达时保留最后一次的行，打上 `offline` 标记、去掉 `running`。
- **断线期间的提问**：daemon 上的提问、回答、取消通过 `ask.observe` 通知主 node；链路不在时这些通知排队（至多 256 条，最旧的先丢），下一条链路接上后按顺序补发，主 node 在接入后立刻开始应答（不必等机器被报告为就绪）。
- 主 node 重启后，从 `participant` 行得知哪些会话在哪台机器，重新挂上；daemon 重启时从 journal 读回会话。
- `sessions.*` 的调用按会话所在的机器路由（`RemoteSessionsRouter`），一般调用 1 分钟、长调用 10 分钟的上限。
