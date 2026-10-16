# 控制面

控制面（`apps/control-plane`，Go）保存智能体的状态，并操作它们的 runtime；智能体用的 GitHub App（[代码托管](forge.md)）和[定时任务](routines.md)也是它的模块（[#241](https://github.com/AkaraChen/axp/issues/241) 之前是两个独立服务）。agent runtime（`apps/agent-runtime`）是被编排的服务：控制面为每个智能体构建镜像、运行一个常驻容器，并把工作交给它；runtime 执行并汇报。两者之间只有下面这份契约，runtime 用什么语言、怎样驱动 Codex 都不影响控制面。

## 与 runtime 的契约

| 方向             | 内容                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 控制面 → 容器    | 镜像（由[环境包](bundles.md)构建）、卷 `/agent`、启动参数 `AXP_AGENT_ID`、`AXP_AGENT_KEY`、`AXP_CONTROL_TOKEN`、`AXP_LLM_BASE_URL`、`AXP_LLM_API_KEY`、`AXP_MODEL` 等（`control.spec`） |
| 控制面 → runtime | runtime 的控制接口（HTTP，`:8080`，只有 controller 连得到并持有令牌）：`/prompt`、`/steer`、`/abort`，见[聊天与运行时架构](chat-runtime.md#runtime)                                     |
| runtime → 控制面 | NATS JetStream 的事件（`axp.agent.<id>.events`），见[命令与事件](queue.md)                                                                                                              |

runtime 访问 AXP 的服务时用智能体的 key（`<agent>.<HMAC(AXP_SECRET_KEY, agent:<agent>)>`），runtime 网关向内部 API 问它属于谁（`/internal/v1/runtime-auth`）；智能体删除后 key 即失效。

## 进程与代码

一个二进制 `axp-control-plane`，按角色运行：

| 命令                                 | 作用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `serve`                              | 同一进程两个 listener，共用配置、连接池和 NATS 连接：浏览器的 API（`AXP_API_ADDR`，默认 `127.0.0.1:24000`：`/api`、`/api/forge`、`/api/routines`、`/api/llm`、`/remote`、`/share`、`/preview`）和 runtime 网关的 API（`AXP_INTERNAL_ADDR`，默认 `127.0.0.1:24001`：`/internal`、`/forge`、`/routines/mcp`、`/tasks`、`/groups`、`/agenvo`、`/artifacts`、`/attachments`，以及模型的 `/v1`）。信任 `X-AXP-Agent-Id` 的路由只在内部 listener 上，浏览器站点只连公共 listener；任一 listener 失败整个进程退出，SIGTERM 时两个一起停（最多等 1 秒，SSE 由浏览器带 `Last-Event-ID` 重连） |
| `controller`                         | 唯一管理 runtime 的容器、唯一连得到 runtime 的进程：用本机 Docker 构建镜像、在 Nomad 上运行 job、交付工作、导入事件；按环境包运行它们的服务（[环境包](bundles.md#服务)）；PostgreSQL advisory lock 保证同时只有一个                                                                                                                                                                                                                                                                                                                                                                  |
| `routine-worker`                     | 定时任务的执行：取 NATS 的触发、运行 ADK agent、按反馈修订要求、恢复与同步计划（见[定时任务](routines.md#谁做什么)）；advisory lock 保证同时只有一个                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `migrate`                            | 执行两个数据库的迁移：控制面的 `axp` 和定时任务自己的 `axp_routines`（不存在时创建）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `openapi public\|internal\|routines` | 输出 API 的 OpenAPI 文档，不需要数据库和队列                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

代码在 `internal/` 下：`chat`（产品状态：智能体、消息、`ui_event`，以及把 runtime 事件投影成产品状态）、`bundles`（环境包目录）、`control`（controller：容器、镜像、交付、事件导入，以及 runtime 网关的认证）、`tasks`（任务看板与远程电脑，见[任务与远程电脑](tasks.md)；它的 runner 在 controller 进程里单独循环）、`relay`（agenvo 中继的客户端）、`github` 与 `forge`（GitHub App 与它的路由，见[代码托管](forge.md)）、`routines` 与 `routineapi`（定时任务的领域与传输层，见[定时任务](routines.md)）、`api`（HTTP 传输层）、`container`（runtime 的 job 与卷，Nomad 的 API；镜像用本机的 `docker build`）、`bundlesvc`（环境包的服务）、`llm`（LLM 网关：嵌入的 CLIProxyAPI、模型账号、目录、用量，见 [LLM 网关](llm-gateway.md)）、`store`（schema 与迁移）、`config`（配置项）。命令、配置读取、数据库、错误信封、幂等和 HTTP 的通用部分来自 [Go 服务框架](service-framework.md)。

## OpenAPI 与前端类型

两个 API 都用 [huma](https://huma.rocks) 以代码优先的方式定义：请求和响应是 Go 结构体，校验规则写在字段标签上，OpenAPI 3.1 文档由代码生成（`/api/openapi.json`，`/api/docs` 可浏览）。错误统一为 `{"error": {"code", "message", "request_id"}}`。

前端不手写控制面的类型：

1. `@axp/control-plane#openapi` 运行 `axp-control-plane openapi public`，写出 `apps/control-plane/out/openapi.json`；
2. `@axp/web#generate` 用 openapi-typescript 把它生成为 `apps/web/src/api/control-plane.gen.ts`；
3. `src/lib/api.ts` 的 `controlPlane`（openapi-fetch）按这份类型调用，路径、参数、请求体和响应都有类型；SSE 事件的载荷（`AgentUpdated` 等）也在文档里。

Web 的 `build`、`lint`、`test` 都依赖 `generate`，Turbo 按 Go 代码的变化决定是否重新生成；生成的文件不入库。改了 Go 里的结构体，前端的类型检查立即反映出来。

## 数据库

迁移由框架的 `pg.Migrate`（[goose](https://github.com/pressly/goose)）执行，SQL 文件在 `internal/store/migrations/`，编译进二进制，记录在表 `goose_db_version`，执行时持有 PostgreSQL 会话锁；框架自己的表（`api_idempotency`）记录在 `service_framework_version`。`0015_schema.sql` 是到 15 号为止的完整表结构：空库只执行它，之前迁移过的数据库已记录 1–15 号，跳过它。之后的改动是它后面的新文件。routines 的库同样从 `00003_routines.sql` 开始。

## 测试

`go test ./...` 连测试用的 PostgreSQL（`scripts/test-postgres.sh` 启动的 `axp-dev-postgres`），每个测试二进制建一个自己的数据库，结束时删除；Nomad、runtime 的控制接口和模型目录由假实现代替。真实 NATS 的测试需要 `AXP_TEST_NATS_URL`（`internal/control/events_test.go`），用本机的 Nomad 和 Docker 构建并运行镜像的需要 `AXP_TEST_NOMAD=1`（`internal/container`）。
