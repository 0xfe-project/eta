# 生产部署

用 [Kamal](https://kamal-deploy.org) 把**当前工作区**部署到运行脚本的这台机器。Kamal 相关文件都在本目录，任何一台满足条件的机器克隆仓库后都能直接拉起：

| 文件                      | 作用                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| `deploy.yml`              | Kamal 配置（角色、kamal-proxy、accessory、镜像仓库）                |
| `deploy.sh`               | 入口：检查环境、准备 SSH/仓库/网络/runtime 镜像，再以容器运行 Kamal |
| `ports.env`               | 生产保留端口，所有机器一致                                          |
| `secrets`                 | Kamal secrets 映射，只引用环境变量，不含密钥                        |
| `Dockerfile`              | 应用镜像，只复制 Turbo 构建的产物（构建上下文是仓库根目录）         |
| `Dockerfile.dockerignore` | 该 Dockerfile 专用的 ignore 规则                                    |

## 新机器上拉起

要求：Linux（amd64 或 arm64）、当前用户无需 sudo 即可使用 Docker、git、openssl，以及本机运行着接受公钥登录的 sshd（Kamal 通过 SSH 回到本机）。不需要安装 Ruby 或 Kamal。

```sh
git clone <repo> axp && cd axp
deploy/deploy.sh          # 首次执行 kamal setup
```

首次运行会：

- 生成 `~/.config/axp/production.env`（控制面的密钥 `AXP_SECRET_KEY`、Postgres 和 SeaweedFS 的密码等，每台机器独立，不入库；后来新增的密钥会在下次部署时自动补上）。模型账号不在这里配置：部署后在 Web 设置的“模型服务”中绑定，凭据保存在 llm 角色的卷 `axp-llm`。
- 生成 `~/.config/axp/kamal_ed25519` 并加入 `~/.ssh/authorized_keys`，限制为只能从 `127.0.0.1`/`::1` 登录。sshd 不在 22 端口时在 `production.env` 设 `AXP_SSH_PORT`。
- 启动本地镜像仓库 `axp-registry`，创建 runtime 网络 `axp-prod-runtime`（子网由 Docker 选空闲的），用 Turbo 构建（或从缓存恢复）镜像产物和两个镜像（见下文“一次部署做什么”）。
- 按本机 CPU 架构构建镜像。保留端口被其他服务占用、Docker 不可用或 SSH 不通时，会在部署前报错。

之后：

```sh
deploy/deploy.sh                         # kamal deploy
deploy/deploy.sh app logs -r api -f      # 其他参数原样传给 kamal
deploy/deploy.sh rollback <version>
```

`bun run deploy` 等同于 `deploy/deploy.sh`。

## 组成

同一个镜像按角色运行：

| 角色              | 进程                           | 说明                                                                                                                                                                                                                          |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway`         | Caddy，`public.caddy`          | 唯一由 kamal-proxy 代理的角色；按路径转发到 llm、memory、forge、routines、api、web、OpenObserve                                                                                                                               |
| `runtime-gateway` | Caddy，`runtime.caddy`         | runtime 网络上唯一提供服务的角色（`axp-runtime-gateway:8090`）；认证 runtime 并转发到 internal、llm、memory、forge                                                                                                            |
| `web`             | Bun 运行 `apps/web/server.js`  | SSR 与静态资源；网络别名 `axp-web`                                                                                                                                                                                            |
| `api`             | `axp-control-plane api`（Go）  | 控制面的公共 API；网络别名 `axp-api`                                                                                                                                                                                          |
| `llm`             | `axp-llm-gateway`（Go）        | 嵌入 CLIProxyAPI；网络别名 `axp-llm`；凭据在卷 `axp-llm`                                                                                                                                                                      |
| `internal`        | `axp-control-plane internal`   | 内部运行协议；网络别名 `axp-internal`，runtime 只能经 runtime 网关访问                                                                                                                                                        |
| `forge`           | `axp-forge`（Go）              | 代码托管（[GitHub](../docs/architecture/forge.md)）；网络别名 `axp-forge`，GitHub App 的凭据在卷 `axp-forge`；浏览器经网关访问 `/api/forge`，runtime 经 runtime 网关访问 `/forge`                                             |
| `routines`        | `axp-routines`（Go）           | 定时任务（[定时任务](../docs/architecture/routines.md)）；网络别名 `axp-routines`，浏览器经网关访问 `/api/routines`；自己的数据库 `axp_routines`（accessory `postgres`，启动时创建并迁移），计划在 `axp-nats`；只能有一个容器 |
| `memory`          | `python -m axp_memory`         | 智能体记忆（[记忆](../docs/architecture/memory.md)）；网络别名 `axp-memory`，runtime 只能经 runtime 网关访问；数据在 accessory `postgres`（pgvector）                                                                         |
| `controller`      | `axp-control-plane controller` | 挂载 Docker socket；用 PostgreSQL advisory lock 保证同一时刻只有一个在运行                                                                                                                                                    |

每个角色只拿自己读取的机密（`deploy.yml` 的 `x-secrets`，没有顶层 `env.secret`：Kamal 把角色的 secret 与顶层的取并集，角色里无法去掉顶层的项）：`api`、`internal`、`controller` 共用同一套初始化，拿全部（`AXP_SECRET_KEY`、`DATABASE_URL`、`AXP_S3_ACCESS_KEY_ID`、`AXP_S3_SECRET_ACCESS_KEY`、`AXP_RELAY_ADMIN_SECRET`、`OTEL_EXPORTER_OTLP_HEADERS`）；`memory`、`routines` 拿 `DATABASE_URL` 和 `OTEL_EXPORTER_OTLP_HEADERS`；`web`、`llm`、`forge` 只拿 `OTEL_EXPORTER_OTLP_HEADERS`；两个网关没有机密。新增机密时加到读取它的角色上。

accessory `relay` 是远程电脑接入用的 agenvo 中继（[任务与远程电脑](../docs/architecture/tasks.md)）：它的镜像 `axp-relay:<agenvo 版本>-<Dockerfile 摘要>` 由 `deploy.sh` 按 `apps/relay/package.json` 固定的版本从 npm 装 `@agenvo/server`，推送到本地仓库，只在这个版本或 `relay.Dockerfile` 变化时重建并重启；状态（配对的设备、OAuth 授权）在卷 `axp-relay`；不发布端口，由 `gateway` 在 AXP 地址的 `/remote/relay` 下对外（`AXP_RELAY_BASE_URL`，由 `AXP_PUBLIC_URL` 推出）。在 `production.env` 设置 `AXP_PUBLIC_URL`（安装命令里的 AXP 地址，没有它远程电脑功能关闭），并让 Access 对 AXP 的 `/remote/` 放行（中继在其下，自己鉴权设备）。

服务之间没有共享密钥：角色中只有 `runtime-gateway` 和 controller 加入 runtime 网络（accessory 中还有 `axp-s3-proxy`、`axp-nats` 和 `axp-otel-collector`），其余角色只在 Kamal 网络上，runtime 连不到（见[网关](../docs/architecture/gateway.md)）。两个网关的访问日志是 JSON，写在容器输出里（`deploy/deploy.sh app logs -r gateway`），不进 OpenObserve。

web、api、llm、memory、forge、routines 不经过 kamal-proxy，重新部署时会有几秒中断（单用户场景可接受）。

### 一次部署做什么

1. 一次 `turbo run image:linux-<arch>`：所有产物并行构建（或从缓存恢复），每个镜像在自己的产物就绪后立即构建——应用镜像（`deploy/Dockerfile`）推送到本地仓库，`axp-agent-runtime:production` 载入本机 Docker（`scripts/build/image.sh`）。镜像任务不进 Turbo 缓存，Docker 层缓存让未变的镜像约一秒完成。与此同时在后台准备 accessory（重启 otel-collector 等）。
2. 用新镜像执行迁移（`axp-control-plane migrate`，经 `kamal app exec -r api`，不占部署锁，与 accessory 并行），保证随后同时启动的各角色不会跑在旧表结构上。首次 `setup` 在 Kamal 启动数据库之后执行。
3. `kamal deploy --skip-push --version <版本>` 部署 Turbo 构建的镜像：gateway 健康后，其余角色并行启动（`boot.parallel_roles`）。

等待都由检查完成，不靠固定时长：每个角色都有 Docker 健康检查（启动期每 0.5 秒一次，能响应 HTTP 即就绪；controller 进程在即就绪），Kamal 据此判断就绪（`readiness_delay: 0`）。旧容器最多等 2 秒（`drain_timeout`）：聊天 SSE 连接不会自己结束，浏览器断开后会带 `Last-Event-ID` 自动续上；控制面收到 SIGTERM 后最多等 1 秒就关闭连接。controller 收到 SIGTERM 后跑完当前一轮即退出（停止时限 30 秒，留给正在进行的 Docker 操作）。

队列是 accessory `axp-nats`（NATS JetStream，卷 `axp-nats`，见[队列](../docs/architecture/queue.md)），在 Kamal 网络和 runtime 网络上可达、不发布端口，不设鉴权；已有的机器在下一次部署前会自动启动它。数据库是 Kamal accessory `axp-postgres`（卷 `axp-postgres`，镜像 `pgvector/pgvector:pg17-trixie`：PostgreSQL 17 加 pgvector，智能体记忆存在表 `memories`；镜像变化时 `deploy.sh` 在迁移前重启它）。每个智能体的全部状态（工作区和 Codex 会话）是 accessory `axp-s3`（SeaweedFS，卷 `axp-s3`）里的一个快照对象。SeaweedFS 只在 Kamal 网络上、不发布端口：它在 S3 之外的端口上提供不鉴权的 filer、master、volume、WebDAV 和管理接口。runtime 经 accessory `axp-s3-proxy`（Caddy，runtime 网络上的 `axp-s3:8333`）只能访问它的 S3 端口，代理原样保留预签名地址的 `Host`（见[网关](../docs/architecture/gateway.md)）。之前 SeaweedFS 直接挂在 runtime 网络上的机器，`deploy.sh` 会在下一次部署时把它重启到只在 Kamal 网络上，再启动代理；controller 启动时创建桶 `axp-agents`。runtime 容器不挂载任何卷。数据都在本机卷里，换机器不会自动迁移；开发环境的 `axp-dev-*` 容器和卷与这些完全分开。

日志由 Kamal accessory `axp-openobserve`（[OpenObserve](https://openobserve.ai)，卷 `axp-openobserve`）收集：各角色通过 OTLP 发送，`OTEL_SERVICE_NAME` 区分来源（`web`、`llm-gateway`、`memory-service`、`forge-service`、`routine-service`、`control-plane-api`、`control-plane-internal`、`control-plane-controller`）。agent runtime 容器运行智能体执行的代码、不持有任何凭据：它们把日志、trace 和指标（包括 Codex 原生的 OpenTelemetry 数据，日志事件含 prompt）发给 accessory `axp-otel-collector`（runtime 网络上的 `otel-collector:4318`，配置见 `otel-collector.yaml`），由它带上凭据转发到 OpenObserve，记录带有 `axp.agent.id`、`axp.runtime.instance.id`。Codex 每收到一段流式输出都会产生一条日志和几个 span（约每两个字一条），Collector 会过滤掉这部分，只保留回合级的事件和 span；Collector 不保存状态，每次部署都会重启以应用配置变更。root 账号是 `root@axp.local`，密码 `AXP_OBSERVE_PASSWORD` 由 `deploy.sh` 首次需要时写入 `production.env`；已有的机器在下一次部署前会自动启动这个 accessory。

记什么由服务自己决定，规则是：记下排查时需要的，不记重复的。

- 健康检查和前端轮询路由的成功 GET 不记，路由由各服务自己列出（llm-gateway 的 `RedirectStdout`、memory-service 的 `setup(quiet=…)`）；其他请求照记，4xx 记 WARN，5xx 记 ERROR。
- 业务错误中，调用方自己的错（4xx）不记；上游或服务端的失败（424、5xx）记一条 WARN，带 `request_id`、`code`、方法和路径（`packages/service-go/httpapi`）。`request_id` 就是 gateway 访问日志里的 `uuid`。
- 循环里每轮都会重复的失败（远程电脑离线、数据库断开）在错误变化时记一次；同一个错误持续时，每 10 分钟再记一次，这样最近的时间窗里也能看到；恢复后重新计算（`telemetry.Repeats`）。
- 每条记录带 `service.version`，值为部署的 git commit（Kamal 的 `KAMAL_VERSION`）。

## 端口与访问

生产端口固定在 `ports.env`：kamal-proxy HTTP `24180`、HTTPS `24143`，镜像仓库 `24150`，OpenObserve `24160`（只绑定 `127.0.0.1`，用 `ssh -L 24160:127.0.0.1:24160` 或反向代理访问）。它们不在 dev 的 3000–3992 范围、Linux 临时端口范围（32768+）和常用服务端口内；`production.env` 不能覆盖，`bun run dev --port` 也会拒绝。

kamal-proxy 默认只监听 `127.0.0.1:24180`。AXP 没有登录，**不要直接暴露到公网**：在 Caddy 或隧道后面加访问控制再反代到该地址。可在 `production.env` 中用 `AXP_PUBLIC_HOST`、`AXP_PROXY_BIND` 调整。
