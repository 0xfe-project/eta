# AXP

Monorepo 初始配置：Bun workspaces 管理 JavaScript 项目，uv 管理 Python 项目。

```text
apps/
  control-plane/   Django 5.2 + Django Ninja，SQLite 本地数据库
  web/             TanStack Start + React + Vite + TypeScript
  agent-runtime/   Node.js + TypeScript 空包
```

## 环境与初始化

需要 Node.js 24、Bun 1.3.14 和 uv。control plane 使用 Python 3.13，uv 会按 `.python-version` 自动获取。

在仓库根目录执行：

```sh
bun run setup
bun run dev
```

`bun run dev` 调用 `scripts/dev.sh`，也可以直接执行 `./scripts/dev.sh`。脚本会自动定位仓库根目录，检查依赖，并为三个进程显示带名称的日志。按 Ctrl+C 或任意进程退出时，会关闭其他进程。agent runtime 当前为空包，启动的是 Node.js watch 进程，没有 HTTP 服务。

`setup` 会安装 JS/Python 依赖并执行 Django migrations。仓库已生成 `bun.lock` 和 `apps/control-plane/uv.lock`，应一起提交到版本控制。

默认开发配置无需复制环境文件。需要自定义时：

```sh
cp apps/control-plane/.env.example apps/control-plane/.env
cp apps/web/.env.example apps/web/.env
```

访问：

- Web：http://localhost:3000
- API 健康检查：http://127.0.0.1:8000/api/health
- OpenAPI 文档：http://127.0.0.1:8000/api/docs
- Django Admin：http://127.0.0.1:8000/admin/

Web 开发服务器将浏览器的 `/api` 请求代理到 `CONTROL_PLANE_URL`（默认 `http://127.0.0.1:8000`），可用 `fetch('/api/health')` 调用后端。该代理仅用于开发；生产环境需要反向代理配置。SSR 服务端调用后端时使用绝对 URL。

Web 已配置 Query、nuqs、Phosphor Icons、表单校验、通知、Markdown 和 Tailwind，使用方式见 [Web 开发说明](apps/web/README.md)。

## 命令

| 根目录命令                  | 用途                                                      |
| --------------------------- | --------------------------------------------------------- |
| `bun run dev`               | 同时启动 Django、Web 和 agent runtime，退出时关闭所有进程 |
| `bun run dev:control-plane` | 单独启动 Django                                           |
| `bun run dev:web`           | 单独启动 Web                                              |
| `bun run dev:agent-runtime` | 使用 Node.js watch 执行空 runtime 入口                    |
| `bun run db:migrate`        | 执行数据库迁移                                            |
| `bun run build`             | 构建 Web 和 runtime                                       |
| `bun run check`             | 构建、TS 类型检查、Django 系统检查、Ruff lint             |
| `bun run format`            | Prettier 格式化 JS/TS/JSON/Markdown，Ruff 格式化 Python   |

TanStack 的 `src/routeTree.gen.ts` 由 `dev` 或 `build` 自动生成；`check` 会先执行构建，因此可在全新安装后直接执行。

创建 Django 管理员：

```sh
uv run --project apps/control-plane python apps/control-plane/manage.py createsuperuser
```

Agent runtime 目前只有 `src/index.ts` 空入口和 TypeScript 构建配置，没有业务逻辑或运行时依赖。构建后可用 `bun run --cwd apps/agent-runtime start` 执行。

生产环境应设置 `DJANGO_DEBUG=false`、独立的 `DJANGO_SECRET_KEY` 和 `DJANGO_ALLOWED_HOSTS`，并配置数据库、静态资源和 ASGI/WSGI 服务。当前 SQLite 和 `runserver` 配置面向本地开发。

## 当前验证状态

依赖已安装，两个锁文件已生成，Django migrations 已执行。Web 与 runtime 构建、TypeScript 类型检查、Django 系统检查、Ruff lint，以及 API 健康检查与 OpenAPI schema 验证均已通过。

配置参考：[TanStack Start 官方初始化指南](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)、[Django Ninja 官方教程](https://django-ninja.dev/tutorial/)。
