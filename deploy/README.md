# 生产部署

AXP 部署在运行脚本的这台机器上的单节点 [Nomad](https://developer.hashicorp.com/nomad)。开发用同一个 agent（`scripts/dev.sh`），命名空间分开。

| 文件                     | 作用                                                                      |
| ------------------------ | ------------------------------------------------------------------------- |
| `nomad/deploy.sh`        | 入口：密钥与设置、基础设施、用本机 Docker 构建镜像、迁移、部署            |
| `nomad/agent.hcl`        | Nomad agent 的配置（装机时复制到 `/etc/nomad.d/`）                        |
| `nomad/infra.nomad.hcl`  | 基础设施：PostgreSQL、NATS、S3、Rustrak；生产和开发用不同的命名空间和端口 |
| `nomad/axp.nomad.hcl`    | AXP 自己：两个网关、web、控制面的三个进程                                 |
| `nomad/backup.nomad.hcl` | 每晚备份数据库                                                            |
| `nomad/lib.sh`           | 部署和开发脚本共用：创建卷                                                |
| `rustrak.ts`             | 向 Rustrak 要项目的 DSN 和上传 source map 的令牌                          |
| `Dockerfile`             | AXP 的镜像，只复制 Turbo 构建的产物（构建上下文是仓库根目录）             |

## 一台机器装好 Nomad

只需要一次（需要 root）。网关由宿主的 Caddy 反代，Nomad 只监听 loopback；容器由本机的 Docker 运行，智能体和环境包的服务在 Nomad 的 bridge 网络上（需要 CNI 插件）：

```sh
# Docker（如果还没有）：https://docs.docker.com/engine/install/
# Nomad 2.0 以上（dynamic host volume、原生服务发现）
curl -fsSL https://releases.hashicorp.com/nomad/2.0.7/nomad_2.0.7_linux_amd64.zip | sudo busybox unzip -d /usr/local/bin - && sudo chmod +x /usr/local/bin/nomad
# CNI 插件（bridge 网络）
sudo mkdir -p /opt/cni/bin
curl -fsSL https://github.com/containernetworking/plugins/releases/download/v1.8.0/cni-plugins-linux-amd64-v1.8.0.tgz | sudo tar -xz -C /opt/cni/bin
# agent 的配置与服务
sudo mkdir -p /etc/nomad.d /var/lib/nomad
sudo cp deploy/nomad/agent.hcl /etc/nomad.d/
sudo tee /etc/systemd/system/nomad.service <<'EOF'
[Unit]
Description=Nomad
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/nomad agent -config /etc/nomad.d
KillMode=process
KillSignal=SIGINT
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now nomad
```

`deploy/nomad/agent.hcl` 让 Docker 驱动允许挂载宿主目录（controller 用 Docker 的 socket 构建镜像）并且不回收镜像（镜像只在本机，不在任何仓库）。Nomad 的 API（4646）只在 loopback 上；`nomad` 命令默认就连它。

## 部署

```sh
deploy/nomad/deploy.sh                  # 部署工作区（bun run deploy 同此）
deploy/nomad/deploy.sh --version <tag>  # 回到本机已有的版本（回滚），不构建也不迁移
nomad alloc logs -namespace axp -job axp -task api -f   # 日志，也在 Rustrak
```

一次部署做的事：

1. 第一次运行时生成 `~/.config/axp/production.env`（`AXP_SECRET_KEY`、Postgres 密码、Rustrak 的会话密钥和管理员账号 `RUSTRAK_SUPERUSER`、内置 S3 的凭据；每台机器独立，不入库）；之后新增的密钥在下一次部署时补上。基础设施的凭据写进命名空间 `axp` 的变量 `nomad/jobs`。
2. 建命名空间 `axp`（基础设施、AXP、环境包的服务）和 `axp-agents`（智能体），建基础设施的卷，运行基础设施（`infra.nomad.hcl`）。Rustrak 就绪后，第一次部署用管理员账号建项目 `axp`，把它的 `SENTRY_DSN` 和上传 source map 用的 `RUSTRAK_TOKEN` 记进 `production.env`（`rustrak.ts`）。
3. 版本是 git commit（工作区有改动时加 `-dirty-<时间>`）。用本机的 Docker 构建四个镜像：`axp:<版本>`（`deploy/Dockerfile`）、`axp-agent-runtime:production`（智能体镜像的底）、`axp-memory:<版本>` 和 `axp-relay:<版本>`（内置环境包的服务）。Docker 的缓存让没变的镜像约一秒完成。随后把 Web 的 source map 上传到 Rustrak（失败只警告）。
4. 把 AXP 的设置写进变量 `nomad/jobs/axp`（版本、`DATABASE_URL`、`AXP_PUBLIC_URL`、S3 的地址、`SENTRY_DSN`），用新镜像跑迁移（`docker run … axp-control-plane migrate`）。迁移失败时停止，正在跑的版本不受影响。
5. 运行 AXP（`axp.nomad.hcl`，`nomad job run` 等到 deployment 成功）和备份。

模型账号不在这里配置：部署后在 Web 设置的「模型服务」里绑定，凭据在卷 `llm`。

## 组成

命名空间 `axp`，job `axp` 的各组都在宿主网络上：

| task             | 端口                               | 说明                                                                                                                                                     |
| ---------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway`        | `127.0.0.1:24180`、`0.0.0.0:24090` | 一个 Caddy，两个站点：`public.caddy` 是浏览器唯一的入口；`runtime.caddy` 是智能体和环境包服务唯一的入口（它们从 bridge 网络的网关 `172.26.64.1` 连进来） |
| `web`            | `127.0.0.1:24003`                  | SSR 与静态资源                                                                                                                                           |
| `api`            | `127.0.0.1:24000/24001`            | `axp-control-plane serve`：公共 API、内部 API、模型（CLIProxyAPI）；GitHub App 的凭据在卷 `forge`，模型账号在卷 `llm`，所以同时只跑一个                  |
| `routine-worker` |                                    | 定时任务的执行（库 `axp_routines`）；同一时刻只有一个（advisory lock）                                                                                   |
| `controller`     |                                    | 智能体的镜像（本机 Docker）和 job（`axp-agents`，每个一个卷 `agent-<id>`）、派发、事件导入、环境包的服务（命名空间 `axp` 里的 job）；同一时刻只有一个    |

job `infra`：`postgres`（pgvector，宿主网络 `24432`）、`nats`（JetStream，宿主网络 `24222`）、`s3`（SeaweedFS，bridge 网络，宿主 `127.0.0.1:24333`）、`rustrak`（错误、日志、trace，bridge 网络，宿主 `127.0.0.1:24080`）。

环境包的服务由 controller 按环境包运行，是命名空间 `axp` 里的 job `bundle-<环境包>`（[环境包](../docs/architecture/bundles.md#服务)）：内置的 `memory`（智能体的记忆，库 `axp_bundle_memory`）和 `agenvo`（远程电脑接入的中继，卷 `agenvo-relay`，在 AXP 地址的 `/remote/relay` 下对外）。它们在 bridge 网络上，用 Nomad 的服务发现注册自己的地址，网关按服务名路由到它们；`nomad job status -namespace axp` 看它们的状态，`GET /api/v1/bundles` 的 `service_status` 是 controller 记录的状态。

智能体的 runtime 是命名空间 `axp-agents` 里的 job `agent-<id>`，也在 bridge 网络上；controller 直接连它们的地址交付工作。所有容器都从本机的 Docker 运行镜像，没有镜像仓库。

## 入口与访问

AXP 没有登录。`gateway` 只监听 `127.0.0.1:24180`，宿主的 Caddy 把域名反代到这里，Cloudflare Access 在更外层：Access 放行的只有 `/remote/`（远程电脑，每个接口自己鉴权）和 Artifact 的 `/share/artifacts/`、`/preview/artifacts/`（见 [Artifact](../docs/architecture/artifacts.md#路由矩阵)）。远程电脑功能需要在 `production.env` 设 `AXP_PUBLIC_URL`（安装命令里的 AXP 地址），中继的地址由它推出。

Rustrak 的界面要独占一个源，不经网关：打开 `http://127.0.0.1:24080`（远程时配合 `ssh -L`），账号是 `production.env` 的 `RUSTRAK_SUPERUSER`（`邮箱:密码`）。网关只把 `/sentry/api/<项目>/envelope/` 转给它。

Nomad 自己的界面在 `http://127.0.0.1:4646/ui`。

## 存储与备份

卷都是 Nomad 的 dynamic host volume（`mkdir` 插件，目录在 `/var/lib/nomad/host_volumes/<id>`，`nomad volume status -type host` 列出），job 停了、环境包卸载了、智能体删了都不会删卷；不要的卷用 `nomad volume delete -type host` 删。

- 每天 04:00 的 job `backup` 把所有数据库 `pg_dumpall` 到卷 `backups`，保留 7 份。
- 其他卷（`objects`、`forge`、`llm`、`agenvo-relay`、`agent-*`、`rustrak`、`nats`）需要的话自己复制到机器外。
- Artifact 也可以放外部 S3：在 `production.env` 设 `AXP_S3_ENDPOINT`、`AXP_S3_BUCKET`、`AXP_S3_REGION` 和 `AXP_S3_ACCESS_KEY_ID`/`AXP_S3_SECRET_ACCESS_KEY`；已有的对象不会自动搬。

## 日志

各进程用 Sentry 的 SDK 发到 Rustrak 的项目 `axp`，标签 `service`（`web`、`control-plane`、`memory-service`）和 `command`（控制面的 `serve`、`controller`、`routine-worker`、`migrate`）区分来源，release 是部署的版本（`AXP_VERSION`）。浏览器和环境包服务经网关的 `/sentry` 发送。Codex 自己的 OpenTelemetry 导出关掉了，智能体的 prompt trace 不再收集。

记什么由服务自己决定：健康检查和前端轮询的成功 GET 不记；调用方自己的错（4xx）不记，上游和服务端的失败（424、5xx）记 WARN；循环里重复的失败在变化时记一次，持续时每 10 分钟再记一次（`telemetry.Repeats`）。

## 网络与信任

k3s 时期的 NetworkPolicy 没有了：bridge 网络上的容器连得到宿主网络上的所有端口（数据库、NATS、内部 API）。智能体执行代码，所以这是一笔明知的债：内部 listener 和基础设施应该改为凭密钥认证，不再依赖网络拓扑。
