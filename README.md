# AXP

Monorepo：Bun workspaces 管理 Web 和 agent runtime，uv 管理 Python 项目，Go 服务各自是独立的 Go 模块（本地包用 `replace` 引用）。

```text
apps/
  gateway/         Caddy：浏览器的入口网关，以及智能体和环境包服务的 runtime 网关
  control-plane/   Go：产品 API 与内部 API（同一进程两个 listener，内嵌 CLIProxyAPI 提供模型连接、目录与
                   OpenAI 兼容接口）、controller、routine worker；在 k3s 里构建并运行每个智能体的 Pod 和环境包的服务；
                   含代码托管（用户自己的 GitHub App，agent 的 git、gh 凭据与 open_pull_request）和定时任务
                   （每次运行是 worker 里的 ADK agent；自己的数据库，计划在 NATS）
  web/             Vite + React + React Compiler + TypeScript
  agent-runtime/   每个 Agent 一个常驻 Pod 的运行时（Node，直接驱动 Codex app-server）
  remote/          Go：远程电脑上的 axp（daemon 与给智能体用的 CLI）
  agenvo/          固定的 agenvo 提交，从源码构建中继（内置环境包 agenvo 的服务）和 connector
bundles/           内置环境包（不是核心代码）：每个一个目录（bundle.json、setup 脚本），有的带集群里的服务
                   （service/：Kubernetes 清单，memory 的还有它的 Python 代码，mem0 + pgvector）
plugins/           环境包带来的插件（MCP、skill、hook），聊天智能体和定时任务都用
packages/
  plugins-go/      插件标准：读取插件，编译到聊天智能体（Codex），加载进定时任务（ADK）
  service-go/      Go 服务框架：配置、数据库与迁移、HTTP API、错误、幂等、命令
  telemetry-go/    Go 服务共用的日志与 OpenTelemetry
```

设计见 [RFC #1](https://github.com/akarachen/axp/issues/1)，实现说明见 [控制面](docs/architecture/control-plane.md)、[聊天与运行时架构](docs/architecture/chat-runtime.md)、[统一入口网关](docs/architecture/gateway.md)、[LLM 网关](docs/architecture/llm-gateway.md)、[记忆](docs/architecture/memory.md)、[代码托管（GitHub）](docs/architecture/forge.md) 、[工具调用规则](docs/architecture/agent-hooks.md)、[环境包](docs/architecture/bundles.md)、[任务与远程电脑](docs/architecture/tasks.md)、[定时任务](docs/architecture/routines.md)、[插件](docs/architecture/plugins.md)、[Artifact](docs/architecture/artifacts.md)、[OOMOL](docs/architecture/oomol.md) 与 [Go 服务框架](docs/architecture/service-framework.md)；新增服务时按[清单](docs/architecture/services.md)核对。

## 环境与初始化

需要 Node.js 24、Bun 1.3.14、uv 和 Go（各 `go.mod` 统一要求 1.26.9，较旧的 go 会自动下载对应工具链）。Python 项目使用 3.13，uv 会按 `.python-version` 自动获取。还需要 Docker（开发网关和测试数据库）和本机的 k3s（见 [deploy/README.md](deploy/README.md#一台机器装好-k3s)）。

runtime 镜像里的 hook 规则引擎 [akhook](https://github.com/aghub-app/akhook) 以 submodule 放在 `vendor/akhook`，构建镜像时如果还没拉取会自动初始化；也可以直接 `git clone --recurse-submodules`。

在仓库根目录执行：

```sh
bun run setup
bun run dev
```

打开脚本输出的 Web 地址（默认 http://localhost:3000 ），新建智能体后即可对话。AXP 是单用户服务。对话区顶部显示当前智能体，点击可切换、新建或进入管理；每个智能体有名称、模型和指令（注入其上下文的系统提示），可在编辑器或设置的“智能体”中修改和删除。

模型来自控制面内嵌的模型网关：在设置的“模型服务”中用设备码绑定 Codex（ChatGPT）或 Grok（xAI）账号，每个服务可以绑定多个账号并自动轮换。账号登录失效、额度用尽等状态会显示在那里；智能体的模型不可用时不能发送消息，绑定或重新登录后自动恢复。详见 [LLM 网关](docs/architecture/llm-gateway.md)。

`bun run dev` 在本机启动网关、控制面（公共与内部 API、controller、routine worker）和 Web；需要 Kubernetes 的部分跑在本机的 k3s 里（安装见 [deploy/README.md](deploy/README.md#一台机器装好-k3s)），与生产相同：所有实例共享的基础设施在命名空间 `axp-dev`（数据库、NATS、S3、日志、镜像仓库和 BuildKit），智能体的 Pod 在 `dev-<库名>-agents`，环境包的服务（记忆、中继）在 `dev-<库名>-bundles`。controller 用每个 Agent 的环境包构建它的镜像，为它运行一个常驻 Pod（状态在它自己的卷上），Pod 里的 Codex 把所有模型请求经 runtime 网关发给控制面，不持有任何账号凭据。runtime 的基础镜像和环境包服务的镜像在每次启动时重建（没有变化时约 1 秒），每个 checkout 一个标签，worktree 之间互不覆盖。

智能体要选一个可用的模型才能对话：首次使用在“模型服务”中绑定账号（开发凭据保存在 `apps/control-plane/var/llm-gateway`）。

`bun run dev` 每个实例占用十个连续端口：网关 `P`（浏览器打开的地址）、控制面的 API `P+1` 与内部 API `P+2`（同一进程）、Web `P+3`、runtime 网关 `P+5`（监听节点在 Pod 网络上的地址 `10.42.0.1`，其余都只监听 loopback）、AXP 的 HTTPS 地址 `P+8`（自签证书，远程电脑和中继用，见[任务与远程电脑](docs/architecture/tasks.md)），其余空着，默认 `P=3000`。被占用时（其他 checkout、worktree 或 agent 已在运行）自动顺延到下一个空闲端口块（3010、3020……），并用文件锁避免并行启动抢到同一端口，因此可以同时运行任意多个实例。用 `bun run dev --port 4000`（或 `AXP_DEV_PORT=4000`）指定端口，被占用或是生产端口（24180）时直接报错。新的 worktree 首次运行会自动安装依赖并执行 migrations。

`setup` 安装 JS/Python/Go 依赖。锁文件（`bun.lock`、两个 `uv.lock`、`go.sum`）应一起提交。

开发无需任何环境文件：所有服务地址由 `bun run dev` 设定，其余都是代码里的固定值。

访问（默认端口块）：

- Web：http://localhost:3000
- API 健康检查：http://localhost:3000/api/health
- 公共 OpenAPI 文档：http://localhost:3000/api/docs
- 内部 API 文档：http://127.0.0.1:3002/internal/docs
- runtime 的入口（AXP 的服务与 OpenAI 兼容接口）：http://10.42.0.1:3005

浏览器只访问网关，runtime 和环境包的服务只访问 runtime 网关（`apps/gateway`，Caddy 配置），开发和生产使用同一套路由：`/api/bundles/<name>/` → 环境包的服务，`/api/` → control-plane，其余 → Web。服务之间没有共享密钥，信任边界由网络划定（生产是 NetworkPolicy），runtime 网关替所有服务认证调用方。详见[网关](docs/architecture/gateway.md)。

Web 已配置 Query、nuqs、Phosphor Icons、表单校验、通知、Markdown 和 Tailwind，使用方式见 [Web 开发说明](apps/web/README.md)。

## 命令

| 根目录命令                   | 用途                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `bun run dev`                | 启动开发环境，任一进程退出时关闭所有进程                                     |
| `bun run deploy`             | 把工作区部署到本机的 k3s（见 `deploy/README.md`）                            |
| `bun run dev:control-plane`  | 单独启动控制面的公共 API 与内部 API（同一进程）                              |
| `bun run dev:controller`     | 单独启动 runtime controller（需要 k3s）                                      |
| `bun run dev:routine-worker` | 单独启动定时任务的 worker                                                    |
| `bun run dev:web`            | 单独启动 Web                                                                 |
| `bun run db:migrate`         | 执行数据库迁移                                                               |
| `bun run build`              | 用 Turbo 构建 Web 与各平台的镜像产物（见下文）                               |
| `bun run check`              | 格式检查，再构建、类型检查、lint 与全部测试                                  |
| `bun run lint`               | ESLint、Ruff 与 Go 检查                                                      |
| `bun run test`               | 全部测试（Web 用 Rstest，runtime 用 Bun，Python 用 pytest，Go 用 `go test`） |
| `bun run test:control-plane` | 运行 control plane 测试                                                      |
| `bun run test:agent-runtime` | 运行 runtime 测试（脚本化的 app-server，无需凭据）                           |
| `bun run format`             | 用 dprint 格式化整个仓库（`format:check` 只检查）                            |

TanStack 的 `src/routeTree.gen.ts` 由 `dev` 或 `build` 自动生成；控制面的类型 `src/api/control-plane.gen.ts` 由 `generate` 从控制面的 OpenAPI 文档生成，而这份文档由控制面的 Go 代码生成（见[控制面](docs/architecture/control-plane.md)）。两者都不入库；`check` 会先执行构建，因此可在全新安装后直接执行。

构建、检查和测试都通过 [Turborepo](https://turborepo.com) 运行，结果缓存在 `.turbo/cache`，输入没变的任务直接复用。镜像所需的产物在 Docker 之外构建，输出到各应用的 `out/`：

- Web：`out/server.js`（打包了全部依赖的静态文件服务）和 `out/dist`（SPA 资源），与平台无关；agent runtime 同样是一个打包好的 `out/main.js`。
- Go：`out/<平台>/` 下的静态二进制，交叉编译。
- Python：`out/<平台>/site-packages`，只用目标平台的 wheel 安装锁定的依赖。

目标平台写在任务名里（`build:linux-amd64`、`build:linux-arm64`），在哪台机器上构建都得到同一份缓存。Dockerfile 只复制这些产物，产物逐字节不变时 Docker 复用对应的层。镜像构建需要 `docker buildx`。

## 格式化、lint 与提交检查

`dprint.json` 统一格式化整个仓库：JS/TS/CSS 用 Biome，Python 用 Ruff，Go 用 gofmt，JSON、Markdown、TOML、YAML 和 Dockerfile 用 dprint 自带插件。lint 由各自的工具负责：Web 用 `@antfu/eslint-config`（格式类规则关闭，交给 dprint），Python 用 Ruff（配置在根目录 `ruff.toml`），Go 暂时只有 `gofmt` 检查和 `go vet`。

`bun install` 会通过 Lefthook 安装 pre-commit 钩子（`lefthook.yml`），提交前依次：

1. ESLint 和 Ruff 对暂存的文件应用安全修复并重新暂存；修不掉的问题（包括只有不安全修复的）会拦下提交。
2. dprint 格式化暂存的文件并重新暂存。
3. Turbo 运行构建、类型检查、lint 和测试，没变的部分直接用缓存。

GitHub Actions（`.github/workflows/ci.yml`）在每个 PR 和推到 `main` 时跑 `bun run check`：squash 合并、`--no-verify` 和机器人推送都绕不过它。CI 里设了 `CI=1`（缺 akhook 等工具的测试失败而不是跳过）和 `AXP_TEST_NATS_URL`（真实 NATS 的测试也跑），PostgreSQL 仍由测试自己通过 `scripts/test-postgres.sh` 启动。

Turbo 用 Vercel Remote Cache（`turbo.json` 的 `remoteCache.teamId`），本机各个 checkout（包括 worktree）和 CI 共用：提交时 pre-commit 跑过的任务会上传，CI 大多直接复用。本机用 `bunx turbo login` 登录一次；CI 用 GitHub 的 OIDC token 换一个短期 token，这需要在 Vercel 团队的 Settings → Build and Deployment → OIDC Policies for CLI Access 里，为这个仓库添加一条 Turborepo CLI 策略。

## 日志

三种语言的服务都走 OpenTelemetry：Go 用 `log/slog`（`packages/telemetry-go`），Python 用标准库 `logging`（`packages/telemetry-py`），Web 服务端用 LogTape（`apps/web/src/server/telemetry.ts`）。控制面内嵌的 CLIProxyAPI 会自己打印到 stdout，这些行也被逐行转成日志（`library=cliproxy`）。每条日志同时：

- 在 stderr 输出一行可读格式 `15:04:05.000 INFO  消息 key=value`（UTC，`INFO` 及以上）；
- 通过 OTLP 发往 [OpenObserve](https://openobserve.ai)。

`bun run dev` 用开发基础设施里共享的 OpenObserve（经网关在 `/observe/` 打开，账号见启动输出），所有实例的日志都发到这里，`axp.dev.port` 区分不同实例。生产见 `deploy/README.md`。

agent runtime 和环境包的服务运行代码、不持有凭据，它们把 OTLP 发给集群里的 OpenTelemetry Collector（`deploy/k3s/infra/otel-collector.yaml`），由 Collector 带上凭据转发；controller 给每个 runtime 附上 `axp.agent.id` 等资源属性。runtime 自己的日志和 Codex 原生的 OpenTelemetry（日志事件含 prompt、trace、指标）都走这条路。

浏览器端通过 `POST /telemetry/logs` 上报（`apps/web/src/lib/report.ts`）：未捕获的错误和未处理的 Promise rejection 自动上报，其他内容调用 `reportLog()`；每分钟最多 30 条，服务端以 `web.browser` 记录。

导出地址与资源属性使用 OpenTelemetry 的标准环境变量（`OTEL_SERVICE_NAME`、`OTEL_RESOURCE_ATTRIBUTES`、`OTEL_EXPORTER_OTLP_*`），由 `bun run dev` 和部署配置设定。

## 数据库与存储

数据库是 PostgreSQL，由 `DATABASE_URL` 指定。开发默认连开发基础设施里的 `postgres.axp-dev`（库 `axp`；换一个库名也就换了一组 `dev-<库名>-*` 命名空间），生产连命名空间 `axp` 里的。测试连本机共享的 `axp-dev-postgres` 容器（`127.0.0.1:15432`，`scripts/test-postgres.sh` 启动它，控制面测试会自动调用）。

每个 Agent 的全部状态（工作区和 Codex 会话）在它自己的卷上（PVC `agent-<id>`），只挂进它自己的 Pod；Pod 重建时卷还在，runtime 从卷上恢复 thread。详见 [对话与运行时](docs/architecture/chat-runtime.md)。

## 生产部署

k3s 的清单和部署脚本都在 [`deploy/`](deploy/README.md)。在装好 k3s 的 Linux 机器上克隆仓库后执行 `deploy/k3s/deploy.sh`（或 `bun run deploy`），即可把工作区部署到这台机器。

配置参考：[Vite + React](https://vite.dev/guide/)、[TanStack Router](https://tanstack.com/router/latest/docs/framework/react/installation/with-vite)、[huma](https://huma.rocks)、[Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server)。
