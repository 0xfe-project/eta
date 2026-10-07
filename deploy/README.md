# 生产部署

用 [Kamal](https://kamal-deploy.org) 把**已提交的 HEAD** 部署到运行脚本的这台机器。Kamal 相关文件都在本目录，任何一台满足条件的机器克隆仓库后都能直接拉起：

| 文件                      | 作用                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| `deploy.yml`              | Kamal 配置（角色、kamal-proxy、Postgres accessory、镜像仓库）       |
| `deploy.sh`               | 入口：检查环境、准备 SSH/仓库/网络/runtime 镜像，再以容器运行 Kamal |
| `ports.env`               | 生产保留端口，所有机器一致                                          |
| `secrets`                 | Kamal secrets 映射，只引用环境变量，不含密钥                        |
| `Dockerfile`              | 应用镜像（构建上下文是仓库根目录）                                  |
| `Dockerfile.dockerignore` | 该 Dockerfile 专用的 ignore 规则                                    |

## 新机器上拉起

要求：Linux（amd64 或 arm64）、当前用户无需 sudo 即可使用 Docker、git、openssl，以及本机运行着接受公钥登录的 sshd（Kamal 通过 SSH 回到本机）。不需要安装 Ruby 或 Kamal。

```sh
git clone <repo> axp && cd axp
deploy/deploy.sh          # 首次执行 kamal setup
```

首次运行会：

- 生成 `~/.config/axp/production.env`（Django 密钥、Postgres 密码等，每台机器独立，不入库）。填写 `OPENAI_API_KEY` 或 `AXP_CODEX_AUTH_FILE` 后重新部署，智能体才能调用模型。
- 生成 `~/.config/axp/kamal_ed25519` 并加入 `~/.ssh/authorized_keys`，限制为只能从 `127.0.0.1`/`::1` 登录。sshd 不在 22 端口时在 `production.env` 设 `AXP_SSH_PORT`。
- 启动本地镜像仓库 `axp-registry`，创建 runtime 网络 `axp-prod-runtime`（子网由 Docker 选空闲的；需要固定时设 `AXP_RUNTIME_SUBNET`），并从 HEAD 构建 `axp-agent-runtime:production`。
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

| 角色         | 进程                             | 说明                                                                             |
| ------------ | -------------------------------- | -------------------------------------------------------------------------------- |
| `web`        | Bun 运行 `apps/web/server.js`    | SSR 与静态资源                                                                   |
| `api`        | gunicorn（gthread）              | 公共 API；启动前执行 migrations；kamal-proxy 将 `/api` 路由到这里                |
| `internal`   | gunicorn，`config.internal_urls` | 不对外；runtime 在 `axp-prod-runtime` 网络上通过 `http://axp-internal:8001` 访问 |
| `controller` | `run_controller`                 | 挂载 Docker socket；用 PostgreSQL advisory lock 保证同一时刻只有一个在运行       |

数据库是 Kamal accessory `axp-postgres`（卷 `axp-postgres`），检查点存放在卷 `axp-objects`。数据都在本机卷里，换机器不会自动迁移。

## 端口与访问

生产端口固定在 `ports.env`：kamal-proxy HTTP `24180`、HTTPS `24143`，镜像仓库 `24150`。它们不在 dev 的 3000–3992 范围、Linux 临时端口范围（32768+）和常用服务端口内；`production.env` 不能覆盖，`bun run dev --port` 也会拒绝。

kamal-proxy 默认只监听 `127.0.0.1:24180`。AXP 没有登录，**不要直接暴露到公网**：在 Caddy 或隧道后面加访问控制再反代到该地址。可在 `production.env` 中用 `AXP_PUBLIC_HOST`、`AXP_PROXY_BIND` 调整。
