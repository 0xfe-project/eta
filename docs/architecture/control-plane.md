# 控制面

控制面（`apps/control-plane`，Go）保存智能体的状态，并操作它们的 runtime。agent runtime（`apps/agent-runtime`）是被编排的服务：控制面为每个智能体构建镜像、运行一个常驻容器，并把工作交给它；runtime 执行并汇报。两者之间只有下面这份契约，runtime 用什么语言、怎样驱动 Codex 都不影响控制面。

## 与 runtime 的契约

| 方向             | 内容                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 控制面 → 容器    | 镜像（由[环境包](bundles.md)构建）、卷 `/agent`、启动参数 `AXP_AGENT_ID`、`AXP_AGENT_KEY`、`AXP_CONTROL_TOKEN`、`AXP_LLM_BASE_URL`、`AXP_LLM_API_KEY`、`AXP_MODEL` 等（`control.spec`） |
| 控制面 → runtime | runtime 的控制接口（HTTP，`:8080`，只有 controller 连得到并持有令牌）：`/prompt`、`/steer`、`/abort`，见[聊天与运行时架构](chat-runtime.md#runtime)                                     |
| runtime → 控制面 | NATS JetStream 的事件（`axp.agent.<id>.events`），见[命令与事件](queue.md)                                                                                                              |

runtime 访问 AXP 的服务时用智能体的 key（`<agent>.<HMAC(AXP_SECRET_KEY, agent:<agent>)>`），runtime 网关向内部 API 问它属于谁（`/internal/v1/runtime-auth`）；智能体删除后 key 即失效。

## 进程与代码

一个二进制 `axp-control-plane`，按角色运行：

| 命令                       | 作用                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `api`                      | 浏览器的 API，`/api`（`AXP_API_ADDR`，默认 `:8000`）                                                                                 |
| `internal`                 | runtime 网关的 API，`/internal`（`AXP_INTERNAL_ADDR`，默认 `:8001`）                                                                 |
| `controller`               | 唯一持有 Docker socket、唯一连得到 runtime 的进程：构建镜像、运行容器、交付工作、导入事件；PostgreSQL advisory lock 保证同时只有一个 |
| `migrate`                  | 执行数据库迁移                                                                                                                       |
| `openapi public\|internal` | 输出 API 的 OpenAPI 文档，不需要数据库和队列                                                                                         |
| `ensure-runtime-network`   | 创建 runtime 的 Docker 网络（开发）                                                                                                  |

代码在 `internal/` 下：`chat`（产品状态：智能体、消息、`ui_event`，以及把 runtime 事件投影成产品状态）、`bundles`（环境包目录）、`control`（controller：容器、镜像、交付、事件导入，以及 runtime 网关的认证）、`tasks`（任务看板与远程电脑，见[任务与远程电脑](tasks.md)；它的 runner 在 controller 进程里单独循环）、`relay`（agenvo 中继的客户端）、`api`（HTTP 传输层）、`container`（Docker 官方 Go SDK，镜像用 `docker build`）、`store`（schema 与迁移）、`config`（配置项）。命令、配置读取、数据库、错误信封、幂等和 HTTP 的通用部分来自 [Go 服务框架](service-framework.md)。

## OpenAPI 与前端类型

两个 API 都用 [huma](https://huma.rocks) 以代码优先的方式定义：请求和响应是 Go 结构体，校验规则写在字段标签上，OpenAPI 3.1 文档由代码生成（`/api/openapi.json`，`/api/docs` 可浏览）。错误统一为 `{"error": {"code", "message", "request_id"}}`。

前端不手写控制面的类型：

1. `@axp/control-plane#openapi` 运行 `axp-control-plane openapi public`，写出 `apps/control-plane/out/openapi.json`；
2. `@axp/web#generate` 用 openapi-typescript 把它生成为 `apps/web/src/api/control-plane.gen.ts`；
3. `src/lib/api.ts` 的 `controlPlane`（openapi-fetch）按这份类型调用，路径、参数、请求体和响应都有类型；SSE 事件的载荷（`AgentUpdated` 等）也在文档里。

Web 的 `build`、`lint`、`test` 都依赖 `generate`，Turbo 按 Go 代码的变化决定是否重新生成；生成的文件不入库。改了 Go 里的结构体，前端的类型检查立即反映出来。

## 数据库

迁移由框架的 `pg.Migrate`（[goose](https://github.com/pressly/goose)）执行，SQL 文件在 `internal/store/migrations/`，编译进二进制，记录在表 `goose_db_version`，执行时持有 PostgreSQL 会话锁；框架自己的表（`api_idempotency`，已由 1 号迁移建好）记录在 `service_framework_version`。1 号迁移是 Django 版控制面最后的表结构（`internal/store/django.sql`）：已经由 Django 迁移过的数据库只记录它、不执行。

## 测试

`go test ./...` 连开发用的 PostgreSQL（`DATABASE_URL`，默认 `axp-dev-postgres`），每个测试二进制建一个自己的数据库，结束时删除；Docker、runtime 的控制接口和 LLM 网关由假实现代替。真实 NATS 的测试需要 `AXP_TEST_NATS_URL`（`internal/control/events_test.go`），真实 Docker 的需要 `AXP_TEST_DOCKER=1`（`internal/container`）。
