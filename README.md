# AXP

Monorepo：Bun workspaces 管理 Web，uv 管理 Python 项目。

```text
apps/
  control-plane/   Django 5.2 + Django Ninja：产品 API、内部运行协议、controller
  web/             TanStack Start + React + Vite + TypeScript
  agent-runtime/   每个 Agent 一个容器的运行时，基于官方 Codex Python SDK
```

设计见 [RFC #1](https://github.com/akarachen/axp/issues/1)，实现说明见 [聊天与运行时架构](docs/architecture/chat-runtime.md)。

## 环境与初始化

需要 Node.js 24、Bun 1.3.14 和 uv。Python 项目使用 3.13，uv 会按 `.python-version` 自动获取。真实运行时还需要 Docker。

在仓库根目录执行：

```sh
bun run setup
bun run dev
```

打开脚本输出的 Web 地址（默认 http://localhost:3000 ），新建智能体后即可对话。AXP 是单用户服务。对话区顶部显示当前智能体，点击可切换、新建或进入管理；每个智能体有名称和指令（注入其上下文的系统提示），可在编辑器或设置的“智能体”中修改和删除。

`bun run dev` 有两种运行时模式：

- 默认 `fake`：启动 Django、Web 和开发用模拟 worker（`run_fake_runtime`）。不需要 Docker 和模型凭据，回复是固定文本；消息包含“确认”时会先发起一次确认。
- `AXP_RUNTIME_MODE=docker bun run dev`：启动 Django、内部运行协议服务、controller 和 Web。controller 为每个 Agent 启动一个 runtime 容器。首次使用先执行 `bun run runtime:build`，并提供 Codex 凭据：设置 `OPENAI_API_KEY`（默认转发进容器），或用 `AXP_CODEX_AUTH_FILE` 指向一个 `auth.json`（首次启动时复制进该 Agent 的状态卷）。不想消耗模型额度时，可设 `AXP_CODEX_LAUNCH="python -m axp_runtime.testing.fake_app_server"` 用脚本化 app-server 跑通整条链路。

`bun run dev` 每个实例占用三个连续端口：Web `P`、API `P+1`、内部运行协议 `P+2`，默认 `P=3000`。被占用时（其他 checkout、worktree 或 agent 已在运行）自动顺延到下一个空闲端口块（3010、3020……），并用文件锁避免并行启动抢到同一端口，因此可以同时运行任意多个实例。用 `bun run dev --port 4000`（或 `AXP_DEV_PORT=4000`）指定端口，被占用或与生产端口（`deploy/ports.env`）重叠时直接报错。新的 worktree 首次运行会自动安装依赖并执行 migrations。

`setup` 安装 JS/Python 依赖并执行 Django migrations。锁文件（`bun.lock`、两个 `uv.lock`）应一起提交。

默认开发配置无需复制环境文件。需要自定义时：

```sh
cp apps/control-plane/.env.example apps/control-plane/.env
cp apps/web/.env.example apps/web/.env
```

访问（默认端口块）：

- Web：http://localhost:3000
- API 健康检查：http://127.0.0.1:3001/api/health
- 公共 OpenAPI 文档：http://127.0.0.1:3001/api/docs
- 内部运行协议文档（docker 模式）：http://172.30.0.1:3002/internal/docs

Web 开发服务器将 `/api` 代理到 `CONTROL_PLANE_URL`（`bun run dev` 会按端口块设置）。该代理仅用于开发；生产环境由 kamal-proxy 按路径路由。

Web 已配置 Query、nuqs、Phosphor Icons、表单校验、通知、Markdown 和 Tailwind，使用方式见 [Web 开发说明](apps/web/README.md)。

## 命令

| 根目录命令                   | 用途                                                       |
| ---------------------------- | ---------------------------------------------------------- |
| `bun run dev`                | 启动开发环境（见上文两种模式），任一进程退出时关闭所有进程 |
| `bun run deploy`             | 用 Kamal 部署已提交的 HEAD 到本机（见 `deploy/README.md`） |
| `bun run dev:control-plane`  | 单独启动 Django（公共 API）                                |
| `bun run dev:fake-runtime`   | 单独启动开发用模拟 worker                                  |
| `bun run dev:internal`       | 单独启动内部运行协议服务（runtime 网络网关地址）           |
| `bun run dev:controller`     | 单独启动 runtime controller（需要 Docker）                 |
| `bun run dev:web`            | 单独启动 Web                                               |
| `bun run runtime:build`      | 构建 runtime 镜像 `axp-agent-runtime:dev`                  |
| `bun run db:migrate`         | 执行数据库迁移                                             |
| `bun run build`              | 构建 Web                                                   |
| `bun run check`              | 构建、类型检查、Django 系统检查、Ruff lint、全部后端测试   |
| `bun run test:control-plane` | 运行 control plane 测试                                    |
| `bun run test:agent-runtime` | 运行 runtime 测试（使用脚本化 app-server，无需凭据）       |
| `bun run format`             | Prettier 格式化 JS/TS/JSON/Markdown，Ruff 格式化 Python    |

TanStack 的 `src/routeTree.gen.ts` 由 `dev` 或 `build` 自动生成；`check` 会先执行构建，因此可在全新安装后直接执行。

## 数据库与存储

数据库默认使用 SQLite。设置 `DATABASE_URL=postgres://…` 后改用 PostgreSQL，这是 RFC 的目标数据库；复合外键只在 PostgreSQL 上创建，测试可在两者上运行。

工作区默认是每个 Agent 一个 Docker 卷。设置 `AXP_WORKSPACE_BACKEND=s3` 及 `AXP_S3_*` 后，runtime 容器用 rclone 把 S3 前缀挂载为工作区。检查点默认存放在 `apps/control-plane/var/objects`，设置 `AXP_OBJECT_STORE=s3` 后改用 S3 预签名 URL。全部配置项见 `apps/control-plane/config/settings.py` 末尾和 `.env.example`。

## 生产部署

Kamal 配置和部署脚本都在 [`deploy/`](deploy/README.md)。在任意一台满足条件的 Linux 机器上克隆仓库后执行 `deploy/deploy.sh`（或 `bun run deploy`），即可把已提交的 HEAD 部署到这台机器。

配置参考：[TanStack Start 官方初始化指南](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)、[Django Ninja 官方教程](https://django-ninja.dev/tutorial/)、[Codex Python SDK](https://github.com/openai/codex/tree/main/sdk/python)。
