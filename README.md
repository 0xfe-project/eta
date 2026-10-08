# AXP

Monorepo：Bun workspaces 管理 Web，uv 管理 Python 项目，`go.work` 管理 Go 服务。

```text
apps/
  gateway/         Go：统一入口网关，浏览器访问的唯一同源地址
  control-plane/   Go：产品 API、内部运行协议、controller；操作 agent runtime
  llm-gateway/     Go：LLM 连接与模型目录（嵌入 CLIProxyAPI）
  web/             TanStack Start + React + Vite + TypeScript
  agent-runtime/   每个 Agent 一个容器的运行时，基于官方 Codex Python SDK；plugins/ 是所有 Agent 都装的 Codex plugin
  memory-service/  Python：Agent 的长期记忆（mem0 + pgvector），memory plugin 的后端
  forge-service/   Go：代码托管（用户自己的 GitHub App），agent 的 git、gh 凭据与 open_pull_request
```

设计见 [RFC #1](https://github.com/akarachen/axp/issues/1)，实现说明见 [控制面](docs/architecture/control-plane.md)、[聊天与运行时架构](docs/architecture/chat-runtime.md)、[统一入口网关](docs/architecture/gateway.md)、[LLM 网关](docs/architecture/llm-gateway.md)、[记忆](docs/architecture/memory.md)、[代码托管（GitHub）](docs/architecture/forge.md) 与 [工具调用规则与用户确认](docs/architecture/agent-hooks.md)。

## 环境与初始化

需要 Node.js 24、Bun 1.3.14、uv 和 Go（`go.work` 要求 1.26，较旧的 go 会自动下载对应工具链）。Python 项目使用 3.13，uv 会按 `.python-version` 自动获取。还需要 Docker。

runtime 镜像里的 hook 规则引擎 [akhook](https://github.com/aghub-app/akhook) 以 submodule 放在 `vendor/akhook`，构建镜像时如果还没拉取会自动初始化；也可以直接 `git clone --recurse-submodules`。

在仓库根目录执行：

```sh
bun run setup
bun run dev
```

打开脚本输出的 Web 地址（默认 http://localhost:3000 ），新建智能体后即可对话。AXP 是单用户服务。对话区顶部显示当前智能体，点击可切换、新建或进入管理；每个智能体有名称、模型和指令（注入其上下文的系统提示），可在编辑器或设置的“智能体”中修改和删除。

模型来自 llm-gateway：在设置的“模型服务”中用设备码绑定 Codex（ChatGPT）或 Grok（xAI）账号，每个服务可以绑定多个账号并自动轮换。账号登录失效、额度用尽等状态会显示在那里；智能体的模型不可用时不能发送消息，绑定或重新登录后自动恢复。详见 [LLM 网关](docs/architecture/llm-gateway.md)。

`bun run dev` 启动网关、控制面（公共 API、内部运行协议服务、controller）、llm-gateway 和 Web，与生产相同。controller 为每个 Agent 启动一个 runtime 容器，容器内的 Codex 把所有模型请求发给 llm-gateway，不持有任何账号凭据。runtime 镜像在每次启动时自动重建（没有变化时约 1 秒）。不想消耗模型额度时，可设 `AXP_CODEX_LAUNCH="python -m axp_runtime.testing.fake_app_server"` 用脚本化 app-server 跑通整条链路。

智能体要选一个可用的模型才能对话：首次使用在“模型服务”中绑定账号（开发凭据保存在仓库根目录的 `var/llm-gateway`）。`bun run dev` 需要 Docker：它在本机启动一组所有实例共享、名为 `axp-dev-*` 的容器（数据库、日志、工作区存储），与生产的容器、卷和网络互不相干。

`bun run dev` 每个实例占用七个连续端口：网关 `P`（浏览器打开的地址）、API `P+1`、内部运行协议 `P+2`、Web `P+3`、llm-gateway `P+4`、runtime 网关 `P+5`（监听 runtime 网络的网关地址 `172.30.0.1`，其余都只监听 loopback）、memory-service `P+6`，默认 `P=3000`。被占用时（其他 checkout、worktree 或 agent 已在运行）自动顺延到下一个空闲端口块（3010、3020……），并用文件锁避免并行启动抢到同一端口，因此可以同时运行任意多个实例。用 `bun run dev --port 4000`（或 `AXP_DEV_PORT=4000`）指定端口，被占用或与生产端口（`deploy/ports.env`）重叠时直接报错。新的 worktree 首次运行会自动安装依赖并执行 migrations。

`setup` 安装 JS/Python/Go 依赖并执行数据库迁移。锁文件（`bun.lock`、两个 `uv.lock`、`go.sum`）应一起提交。

开发无需任何环境文件：所有服务地址由 `bun run dev` 设定，其余都是代码里的固定值。

访问（默认端口块）：

- Web：http://localhost:3000
- API 健康检查：http://localhost:3000/api/health
- 公共 OpenAPI 文档：http://localhost:3000/api/docs
- 内部运行协议文档：http://127.0.0.1:3002/internal/docs
- runtime 的入口（内部运行协议与 OpenAI 兼容接口）：http://172.30.0.1:3005

浏览器只访问网关，runtime 只访问 runtime 网关（`apps/gateway`，Caddy 配置），开发和生产使用同一套路由：`/api/llm/` → llm-gateway，`/api/` → control-plane，其余 → Web。服务之间没有共享密钥，信任边界由网络划定：服务只监听 loopback（生产中不在 runtime 网络上），runtime 网关替所有服务认证 runtime。详见[网关](docs/architecture/gateway.md)。

Web 已配置 Query、nuqs、Phosphor Icons、表单校验、通知、Markdown 和 Tailwind，使用方式见 [Web 开发说明](apps/web/README.md)。

## 命令

| 根目录命令                   | 用途                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `bun run dev`                | 启动开发环境，任一进程退出时关闭所有进程                     |
| `bun run deploy`             | 用 Kamal 把工作区部署到本机（见 `deploy/README.md`）         |
| `bun run dev:llm-gateway`    | 单独启动 llm-gateway                                         |
| `bun run dev:control-plane`  | 单独启动控制面的公共 API                                     |
| `bun run dev:internal`       | 单独启动内部运行协议服务                                     |
| `bun run dev:controller`     | 单独启动 runtime controller（需要 Docker）                   |
| `bun run dev:web`            | 单独启动 Web                                                 |
| `bun run runtime:build`      | 构建本机架构的 runtime 镜像 `axp-agent-runtime:dev`          |
| `bun run db:migrate`         | 执行数据库迁移                                               |
| `bun run build`              | 用 Turbo 构建 Web 与各平台的镜像产物（见下文）               |
| `bun run check`              | 格式检查，再构建、类型检查、lint 与全部测试                  |
| `bun run lint`               | ESLint、Ruff 与 Go 检查                                      |
| `bun run test`               | 全部测试（Web 用 Rstest，Python 用 pytest，Go 用 `go test`） |
| `bun run test:control-plane` | 运行 control plane 测试                                      |
| `bun run test:agent-runtime` | 运行 runtime 测试（使用脚本化 app-server，无需凭据）         |
| `bun run format`             | 用 dprint 格式化整个仓库（`format:check` 只检查）            |

TanStack 的 `src/routeTree.gen.ts` 由 `dev` 或 `build` 自动生成；控制面的类型 `src/api/control-plane.gen.ts` 由 `generate` 从控制面的 OpenAPI 文档生成，而这份文档由控制面的 Go 代码生成（见[控制面](docs/architecture/control-plane.md)）。两者都不入库；`check` 会先执行构建，因此可在全新安装后直接执行。

构建、检查和测试都通过 [Turborepo](https://turborepo.com) 运行，结果缓存在 `.turbo/cache`，输入没变的任务直接复用。镜像所需的产物在 Docker 之外构建，输出到各应用的 `out/`：

- Web：`out/server.js`（打包了全部依赖的 SSR 服务）和 `out/dist/client`，与平台无关。
- Go：`out/<平台>/` 下的静态二进制，交叉编译。
- Python：`out/<平台>/site-packages`，只用目标平台的 wheel 安装锁定的依赖。

目标平台写在任务名里（`build:linux-amd64`、`build:linux-arm64`），在哪台机器上构建都得到同一份缓存。Dockerfile 只复制这些产物，产物逐字节不变时 Docker 复用对应的层。镜像构建需要 `docker buildx`。

## 格式化、lint 与提交检查

`dprint.json` 统一格式化整个仓库：JS/TS/CSS 用 Biome，Python 用 Ruff，Go 用 gofmt，JSON、Markdown、TOML、YAML 和 Dockerfile 用 dprint 自带插件。lint 由各自的工具负责：Web 用 `@antfu/eslint-config`（格式类规则关闭，交给 dprint），Python 用 Ruff（配置在根目录 `ruff.toml`），Go 暂时只有 `gofmt` 检查和 `go vet`。

`bun install` 会通过 Lefthook 安装 pre-commit 钩子（`lefthook.yml`），提交前依次：

1. ESLint 和 Ruff 对暂存的文件应用安全修复并重新暂存；修不掉的问题（包括只有不安全修复的）会拦下提交。
2. dprint 格式化暂存的文件并重新暂存。
3. Turbo 运行构建、类型检查、lint 和测试，没变的部分直接用缓存。

## 日志

三种语言的服务都走 OpenTelemetry：Go 用 `log/slog`（`packages/telemetry-go`），Python 用标准库 `logging`（`packages/telemetry-py`），Web 服务端用 LogTape（`apps/web/src/server/telemetry.ts`）。llm-gateway 内嵌的 CLIProxyAPI 会自己打印到 stdout，这些行也被逐行转成日志（`library=cliproxy`）。每条日志同时：

- 在 stderr 输出一行可读格式 `15:04:05.000 INFO  消息 key=value`（UTC，`INFO` 及以上）；
- 通过 OTLP 发往 [OpenObserve](https://openobserve.ai)。

`bun run dev` 会在本机启动一个共享的 OpenObserve（容器 `axp-dev-openobserve`，经网关在 `/observe/` 打开，账号见启动输出），所有实例的日志都发到这里，`axp.dev.port` 区分不同实例。生产见 `deploy/README.md`。

agent runtime 容器运行智能体执行的代码、不持有凭据，它们把 OTLP 发给 runtime 网络里的 OpenTelemetry Collector（`deploy/otel-collector.yaml`，别名 `otel-collector`），由 Collector 带上凭据转发；controller 给每个 runtime 附上 `axp.agent.id` 等资源属性。runtime 自己的日志和 Codex 原生的 OpenTelemetry（日志事件含 prompt、trace、指标）都走这条路。开发时这个 Collector 是 `axp-dev-otel-collector`。

浏览器端通过 `POST /telemetry/logs` 上报（`apps/web/src/lib/report.ts`）：未捕获的错误和未处理的 Promise rejection 自动上报，其他内容调用 `reportLog()`；每分钟最多 30 条，服务端以 `web.browser` 记录。

导出地址与资源属性使用 OpenTelemetry 的标准环境变量（`OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES`、`OTEL_EXPORTER_OTLP_*`），由 `bun run dev` 和部署配置设定。

## 数据库与存储

数据库是 PostgreSQL，由 `DATABASE_URL` 指定。开发和测试默认连本机共享的 `axp-dev-postgres` 容器（`127.0.0.1:15432`，`scripts/dev-postgres.sh` 启动它，`bun run dev`、`db:migrate` 和控制面测试会自动调用）；生产用 Kamal accessory `postgres`。

每个 Agent 的全部状态（工作区和 Codex 会话）是 [SeaweedFS](https://github.com/seaweedfs/seaweedfs) 里的一个快照对象：runtime 容器启动时下载并解开它，每个 turn 结束后上传新的快照，用的都是控制面签发的预签名 URL，容器不挂载任何卷、不持有存储凭据。开发用本机共享的 `axp-dev-s3` 容器，生产用 Kamal accessory `s3`，两者的数据卷与网络完全分开。详见 [对话与运行时](docs/architecture/chat-runtime.md)。

## 生产部署

Kamal 配置和部署脚本都在 [`deploy/`](deploy/README.md)。在任意一台满足条件的 Linux 机器上克隆仓库后执行 `deploy/deploy.sh`（或 `bun run deploy`），即可把已提交的 HEAD 部署到这台机器。

配置参考：[TanStack Start 官方初始化指南](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)、[huma](https://huma.rocks)、[Codex Python SDK](https://github.com/openai/codex/tree/main/sdk/python)。
