# 生产部署

AXP 部署在运行脚本的这台机器上的单节点 [k3s](https://k3s.io)。开发用同一个集群（`scripts/dev.sh`），命名空间分开。

| 文件                 | 作用                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `k3s/deploy.sh`      | 入口：密钥与设置、基础设施、用集群里的 BuildKit 构建镜像、迁移、部署                        |
| `k3s/infra/`         | 基础设施：PostgreSQL、NATS、S3、OpenObserve 与 Collector、镜像仓库和 BuildKit；CRD          |
| `k3s/app/`           | AXP 自己：两个网关、web、控制面的三个进程、权限、备份                                       |
| `k3s/production/`    | 生产的 overlay：命名空间 `axp`，镜像仓库和 BuildKit 的固定地址                              |
| `k3s/dev/`           | 开发的基础设施：命名空间 `axp-dev`，开发用的固定凭据                                        |
| `k3s/workloads.yaml` | 智能体与环境包服务的命名空间（`<ns>-agents`、`<ns>-bundles`）、它们的网络策略和控制面的权限 |
| `Dockerfile`         | AXP 的镜像，只复制 Turbo 构建的产物（构建上下文是仓库根目录）                               |

## 一台机器装好 k3s

只需要一次（需要 root）。网关由宿主的 Caddy 反代，所以不装 traefik 和 servicelb；节点从集群里的镜像仓库拉镜像，地址固定：

```sh
sudo mkdir -p /etc/rancher/k3s
sudo tee /etc/rancher/k3s/config.yaml <<'EOF'
disable: [traefik, servicelb, metrics-server]
flannel-backend: host-gw
write-kubeconfig-mode: "0600"
EOF
sudo tee /etc/rancher/k3s/registries.yaml <<'EOF'
mirrors:
  "10.43.100.1:5000":
    endpoint: ["http://10.43.100.1:5000"]
  "10.43.100.11:5000":
    endpoint: ["http://10.43.100.11:5000"]
EOF
# k3s and its containers take root's inotify instances (128 by default); the
# models' file watcher in the API needs one too.
echo 'fs.inotify.max_user_instances = 1024' | sudo tee /etc/sysctl.d/90-axp-k3s.conf
sudo sysctl -p /etc/sysctl.d/90-axp-k3s.conf
curl -sfL https://get.k3s.io | sudo INSTALL_K3S_VERSION=v1.36.5+k3s1 sh -
mkdir -p ~/.kube && sudo cat /etc/rancher/k3s/k3s.yaml >~/.kube/config && chmod 600 ~/.kube/config
```

`10.43.100.1`/`.2` 是生产的镜像仓库和 BuildKit，`10.43.100.11`/`.12` 是开发的（`k3s/production`、`k3s/dev` 里的 Service 固定了这些地址）。API server（6443）和 kubelet（10250）都要求证书认证；机器在公网上时，用防火墙只放行需要的端口更稳妥。

## 部署

```sh
deploy/k3s/deploy.sh                  # 部署工作区（bun run deploy 同此）
deploy/k3s/deploy.sh --version <tag>  # 回到仓库里已有的版本（回滚），不构建也不迁移
kubectl -n axp logs deploy/api -f     # 日志，也在 OpenObserve
```

一次部署做的事：

1. 第一次运行时生成 `~/.config/axp/production.env`（`AXP_SECRET_KEY`、Postgres 密码、OpenObserve 密码、内置 S3 的凭据；每台机器独立，不入库）；之后新增的密钥在下一次部署时补上。再从它写出 Secret `infra`（基础设施的）和 `axp`（控制面的）。
2. 部署基础设施（`k3s/production/infra`），以及 `axp-agents`、`axp-bundles` 两个命名空间（`k3s/workloads.yaml`）。
3. 版本是 git commit（工作区有改动时加 `-dirty-<时间>`）。仓库里还没有这个版本时，用集群里的 BuildKit 构建四个镜像并推到集群里的仓库：`axp:<版本>`（`deploy/Dockerfile`）、`axp-agent-runtime:production`（智能体镜像的底）、`axp-memory:<版本>` 和 `axp-relay:<版本>`（内置环境包的服务）。BuildKit 的缓存让没变的镜像约一秒完成。
4. 写 ConfigMap `axp`（版本、`AXP_PUBLIC_URL`、S3 的地址），用新镜像跑迁移 Job（`axp-control-plane migrate`）。迁移失败时停止，正在跑的版本不受影响。
5. 部署 AXP（`k3s/production`）并等它们就绪。

模型账号不在这里配置：部署后在 Web 设置的「模型服务」里绑定，凭据在卷 `llm`。

## 组成

命名空间 `axp`：

| 工作负载          | 说明                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway`         | Caddy `public.caddy`，在节点网络上监听 `127.0.0.1:24180`：浏览器唯一的入口                                                                              |
| `runtime-gateway` | Caddy `runtime.caddy`，Service `runtime-gateway:8090`：智能体和环境包服务唯一的入口                                                                     |
| `web`             | SSR 与静态资源                                                                                                                                          |
| `api`             | `axp-control-plane serve`：公共 API `:8000`、内部 API `:8001`、模型（CLIProxyAPI）；GitHub App 的凭据在卷 `forge`，模型账号在卷 `llm`，所以同时只跑一个 |
| `routine-worker`  | 定时任务的执行（库 `axp_routines`）；同一时刻只有一个（advisory lock）                                                                                  |
| `controller`      | 智能体的镜像（BuildKit → 仓库）和 Pod（`axp-agents`，每个一个卷 `agent-<id>`）、派发、事件导入、环境包服务（`axp-bundles`）；同一时刻只有一个           |
| 基础设施          | `postgres`（pgvector）、`nats`（JetStream）、`s3`（SeaweedFS）、`openobserve`、`otel-collector`、`registry`、`buildkitd`                                |

命名空间 `axp-bundles` 里是环境包的服务，由 controller 按环境包创建（[环境包](../docs/architecture/bundles.md#服务)）：内置的 `memory`（智能体的记忆，库 `axp_bundle_memory`）和 `agenvo-relay`（远程电脑接入的中继，卷 `agenvo-relay`，在 AXP 地址的 `/remote/relay` 下对外）。`kubectl -n axp-bundles get bundleservices` 看它们的状态。

信任边界由 NetworkPolicy 划定，服务之间不共享密钥（见[网关](../docs/architecture/gateway.md)）：`axp` 只接受自己命名空间里的连接；智能体和环境包服务只连得到 `runtime-gateway`、NATS 和 Collector，环境包服务另外连得到自己的数据库。controller 和 API 的权限只在 `axp-agents`、`axp-bundles` 里（`k3s/workloads.yaml`），智能体的 Pod 不挂 ServiceAccount 令牌。

## 入口与访问

AXP 没有登录。`gateway` 只监听 `127.0.0.1:24180`，宿主的 Caddy 把域名反代到这里，Cloudflare Access 在更外层：Access 放行的只有 `/remote/`（远程电脑，每个接口自己鉴权）和 Artifact 的 `/share/artifacts/`、`/preview/artifacts/`（见 [Artifact](../docs/architecture/artifacts.md#路由矩阵)）。远程电脑功能需要在 `production.env` 设 `AXP_PUBLIC_URL`（安装命令里的 AXP 地址），中继的地址由它推出。

OpenObserve 在 `/observe/`（经网关和 Access），root 账号 `root@axp.local`，密码是 `production.env` 的 `AXP_OBSERVE_PASSWORD`。

## 存储与备份

卷都用 StorageClass `axp`（k3s 的 local-path，数据在 `/var/lib/rancher/k3s/storage`），回收策略 `Retain`：删掉 PVC（卸载环境包、删智能体、重装）不会删数据，PV 和目录要手动清理。

- 每天 04:00 的 CronJob `backup` 把所有数据库 `pg_dumpall` 到卷 `backups`，保留 7 份。
- 其他卷（`objects`、`forge`、`llm`、`agenvo-relay`、`agent-*`、`openobserve`）在 local-path 的目录里，需要的话自己复制到机器外。
- Artifact 也可以放外部 S3：在 `production.env` 设 `AXP_S3_ENDPOINT`、`AXP_S3_BUCKET`、`AXP_S3_REGION` 和 `AXP_S3_ACCESS_KEY_ID`/`AXP_S3_SECRET_ACCESS_KEY`；已有的对象不会自动搬。

## 日志

各进程用 OTLP 发到 OpenObserve，`OTEL_SERVICE_NAME` 区分来源（`web`、`control-plane`、`control-plane-controller`、`control-plane-routine-worker`、`memory-service`），`service.version` 是部署的版本（`AXP_VERSION`）。智能体和环境包服务不持有凭据，发到 `otel-collector`，由它带上凭据转发；Collector 过滤掉 Codex 每段流式输出的日志和 span（`k3s/infra/otel-collector.yaml`）。

记什么由服务自己决定：健康检查和前端轮询的成功 GET 不记；调用方自己的错（4xx）不记，上游和服务端的失败（424、5xx）记 WARN；循环里重复的失败在变化时记一次，持续时每 10 分钟再记一次（`telemetry.Repeats`）。
