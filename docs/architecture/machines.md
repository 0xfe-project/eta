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

`apps/daemon` 用 `bun build --compile` 打成单文件 `eta-daemon`（`bun run --cwd apps/daemon build` → `out/eta-daemon`）。它只含内核、harness、execution、会话存储，以及上游 server 的 SessionManager 与 sessions 插件：**没有 Web、没有 SQLite、没有产品插件、没有 providers 配置**。会话的 kernel 与 journal 都在这台机器上（默认数据目录 `~/.eta-daemon`，或 `ETA_DAEMON_DIR`、`--data-dir`）。

```text
eta-daemon setup <primary-url> <code> [--data-dir <dir>]   用安装码换一个位置，等待批准
eta-daemon run [--data-dir <dir>]                           连接主 node 并提供服务（默认命令）
eta-daemon install-service [--data-dir <dir>]               注册成 systemd 用户服务（Linux）或 launchd agent（macOS）
eta-daemon uninstall-service [--data-dir <dir>]
```

首版支持 Linux 与 macOS；Windows 走 WSL。注册的是用户级服务，不需要 root，daemon 以会话要读写文件的同一个用户运行。

## 配对

接入的方式照"一次性安装码的一条命令"：

1. 设置页（`machines.enroll`）生成安装码，**24 小时有效、一次性**，主 node 只存它的摘要（`machine_enrollment`）。界面给出整条命令：`eta-daemon setup <主 node 地址> <码>`。
2. 在新机器上执行。daemon **本地生成**一个 32 字节的密钥（`identity.json`，目录 0700、文件 0600），把密钥的 SHA-256 作为"指纹"，连同主机名、home、系统，`POST /machines/enroll`。主 node 校验安装码，创建 `pending` 的 machine，只保存指纹（密钥本身永远不离开 daemon）。
3. daemon 的终端显示指纹（八字符一组），设置页也显示同一个指纹；用户**核对一致后点批准**（`machines.approve`）。
4. daemon 连上后收到批准，变为 `online`。

安装码用错有限速（10 分钟内错误次数过多会被拒绝），请求体有大小上限。撤销（`machines.revoke`）会切断这条连接并拒绝再连；它**不会**停止已经在那台机器上运行的会话。

## 一条 WSS，三类流量

daemon **只出站**：它反向拨号 `GET /machines/connect`（WebSocket），凭证放在握手的 `Authorization` 头里，从不进地址。一条连接承载三个信道（`packages/client-contracts/src/link.ts`）：

| 信道   | 方向             | 内容                                                                                                                       |
| ------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `pipe` | 主 node → daemon | 普通的 eta 管道协议。daemon 是一个没有自己 socket 的 eta server，主 node 是它的客户端：`sessions.*` 在这里的含义和别处一样 |
| `svc`  | daemon → 主 node | daemon 缺的四样东西：生成（`model.stream`）、产品工具（`tool.call`）、审批名单（`tool.gate`）、提问通知（`ask.observe`）   |
| `ctl`  | 双向             | `welcome`（哪台机器、第几个连接、是否已批准）、`approved`、心跳                                                            |

因此**模型凭据、OAuth 令牌（含 LLM 网关里的订阅账号）和用量只在主 node**：daemon 要生成时把请求交给主 node，主 node 解析模型、加凭据、向 provider 流式取回再逐事件送回，并计入用量。产品工具（任务、产物、记忆、`mention` 等）在主 node 上为对应的会话运行，它们的执行环境是经链路的 SSH 环境，所以读文件读的是那台机器的文件。每个调用都带会话 id，且**只相信主 node 自己的行**：链路所属的机器必须就是该会话 project 的机器。

## epoch 与有界

- **每次连接是一个新的 epoch**（主 node 单调递增）。同一设备的新连接会顶替旧的（关闭码 4001），旧连接上的在途调用以"结果未知"失败。
- **断线重连不重放在途调用**。daemon 以递增的间隔重连（1 秒起，上限 30 秒，成功连上后复位）；主 node 在链路断开时把在途调用判为未知，不重发，以免重复执行。
- 一切有界：单帧最大 8 MiB（超出关闭码 1009）、每方同时在途 64 个调用、普通调用 30 秒、一次 run 最长 2 小时、心跳 15 秒、静默 45 秒视为断线。

## 会话在远端

- 引擎问"位置"（`SessionPlace`）要一个智能体的会话：本机是 `LocalPlace`，远端是 `RemotePlace`：一次 `machine.open` 把会话和智能体对齐，智能体的指令、模型、思考档、persona 卡和产品工具清单随调用送过去（daemon 注册代理工具，调用时回到主 node 执行）。之后一次 run 是一个长调用（`machine.run`），steer/stop 是 daemon 管道上的普通 `sessions.*` 调用。
- **镜像**：浏览器订阅 `sessions.<id>` 时不需要知道会话在哪台机器。主 node 为远端会话注册同名 target，有人订阅时就订阅 daemon 的同一 target，把它的状态（先整份后 patch）与事件原样再发布；没人看了就取消订阅。链路断开则全部降温，恢复后只重新唤醒仍有人看的。
- 主 node 重启后，从 `participant` 行得知哪些会话在哪台机器，重新挂上；daemon 重启时从 journal 读回会话。
- `sessions.*` 的调用按会话所在的机器路由（`RemoteSessionsRouter`），一般调用 1 分钟、长调用 10 分钟的上限。
