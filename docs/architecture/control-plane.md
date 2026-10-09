# 控制面

控制面（`apps/control-plane`，Go）保存智能体的状态，并操作它们的 runtime。agent runtime（`apps/agent-runtime`）是被编排的服务：控制面决定什么时候为哪个智能体启动、替换、停止一个 runtime 容器，runtime 自己从队列取工作、执行并汇报。两者之间只有下面这份契约，runtime 用什么语言、用哪个 Codex SDK 实现都不影响控制面。

## 与 runtime 的契约

| 方向             | 内容                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 控制面 → 容器    | 启动参数：`AXP_AGENT_ID`、`AXP_INSTANCE_ID`、`AXP_GENERATION`、`AXP_RUNTIME_TOKEN`、`AXP_GATEWAY_URL`、`AXP_NATS_URL`、`AXP_THREAD_ID`、`AXP_CODEX_SETTINGS`、`AXP_SNAPSHOT_URL` 等（`control/controller.go`） |
| 控制面 → runtime | NATS：`axp.agent.<id>.commands`（工作，runtime 经 consumer `agent-<id>` 自取）、`axp.agent.<id>.control`（中断、审批决定、插话），见[队列](queue.md)                                                           |
| runtime → 控制面 | 内部运行协议（HTTP，经 [runtime 网关](gateway.md)）：心跳、会话、事件批次、快照上传地址、runtime 身份                                                                                                          |

内部运行协议的 OpenAPI 文档在 `/internal/openapi.json`（开发时 `/internal/docs` 可浏览）。runtime 的令牌是 `HMAC(AXP_SECRET_KEY, runtime:<实例>:<代>)`，换代即失效。

## 进程与代码

一个二进制 `axp-control-plane`，按角色运行：

| 命令                       | 作用                                                                     |
| -------------------------- | ------------------------------------------------------------------------ |
| `api`                      | 浏览器的 API，`/api`（`AXP_API_ADDR`，默认 `:8000`）                     |
| `internal`                 | runtime 的 API，`/internal`（`AXP_INTERNAL_ADDR`，默认 `:8001`）         |
| `controller`               | 唯一持有 Docker socket 的进程；PostgreSQL advisory lock 保证同时只有一个 |
| `migrate`                  | 执行数据库迁移                                                           |
| `openapi public\|internal` | 输出 API 的 OpenAPI 文档，不需要数据库和队列                             |
| `ensure-runtime-network`   | 创建 runtime 的 Docker 网络（开发）                                      |

代码在 `internal/` 下：`chat`（产品状态：智能体、消息、交互、`ui_event`，以及把 runtime 事件投影成产品状态）、`control`（controller 与内部运行协议）、`tasks`（任务看板与远程电脑，见[任务与远程电脑](tasks.md)；它的 runner 在 controller 进程里单独循环）、`relay`（agenvo 中继的客户端）、`api`（HTTP：huma 跑在 chi 上）、`queue`（NATS）、`container`（Docker 官方 Go SDK）、`snapshots`（S3 预签名地址）、`store`（PostgreSQL 与 goose 迁移）、`config`（环境变量，caarlos0/env）。

## OpenAPI 与前端类型

两个 API 都用 [huma](https://huma.rocks) 以代码优先的方式定义：请求和响应是 Go 结构体，校验规则写在字段标签上，OpenAPI 3.1 文档由代码生成（`/api/openapi.json`，`/api/docs` 可浏览）。错误统一为 `{"error": {"code", "message", "request_id"}}`。

前端不手写控制面的类型：

1. `@axp/control-plane#openapi` 运行 `axp-control-plane openapi public`，写出 `apps/control-plane/out/openapi.json`；
2. `@axp/web#generate` 用 openapi-typescript 把它生成为 `apps/web/src/api/control-plane.gen.ts`；
3. `src/lib/api.ts` 的 `controlPlane`（openapi-fetch）按这份类型调用，路径、参数、请求体和响应都有类型；SSE 事件的载荷（`AgentUpdated` 等）也在文档里。

Web 的 `build`、`lint`、`test` 都依赖 `generate`，Turbo 按 Go 代码的变化决定是否重新生成；生成的文件不入库。改了 Go 里的结构体，前端的类型检查立即反映出来。

## 数据库

迁移由 [goose](https://github.com/pressly/goose) 执行，SQL 文件在 `internal/store/migrations/`，编译进二进制，记录在表 `goose_db_version`，执行时持有 PostgreSQL 会话锁。1 号迁移是 Django 版控制面最后的表结构（`internal/store/django.sql`）：已经由 Django 迁移过的数据库只记录它、不执行。

## 测试

`go test ./...` 连开发用的 PostgreSQL（`DATABASE_URL`，默认 `axp-dev-postgres`），每个测试二进制建一个自己的数据库，结束时删除；NATS、Docker、S3 和 LLM 网关由假实现代替。真实 NATS 的测试需要 `AXP_TEST_NATS_URL`（见 `internal/queue/queue_test.go`）。
