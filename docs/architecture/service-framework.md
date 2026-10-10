# Go 服务框架

`packages/service-go` 是 AXP 的 Go 业务服务框架：控制面和定时任务服务都建在它上面，新的服务也应该如此。它解决每个服务都要做、又不该各写一份的事（配置、数据库、迁移、HTTP API、错误、幂等、进程生命周期），并规定服务的代码怎么分层，让每个服务的结构一眼就能看懂。

它不是依赖注入容器，也不接管业务：服务在 `main.go` 里显式地组装自己，框架只提供组装用的零件和约定。

## 分层

框架内的包自下而上，每个包只依赖它上面的那些：

| 包            | 负责                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apierr`      | 产品错误：HTTP 状态、稳定的错误码、给人看的消息。领域代码对调用方可见的一切失败都用它表达                                                        |
| `jsontime`    | API 的时间戳：UTC、毫秒、定长，浏览器可以按字符串排序                                                                                            |
| `config`      | 从环境变量读配置。字段用 tag 声明变量名和默认值：`default`，以及开发（`dev`，`AXP_DEV=true`）和生产（`prod`）各自的默认值                        |
| `pg`          | PostgreSQL：连接池、服务自己的库（不存在就建）、goose 迁移、事务（`InTx`、`InTxValue`）、按 `db` tag 映射行（`One`、`All`、`Exists`）、ID 与时间 |
| `pg/pgtest`   | 测试用：每个测试二进制一个新库，迁移一次，每个测试前清空                                                                                         |
| `httpapi`     | HTTP API：chi 上的 huma，代码生成 OpenAPI；统一的错误信封、请求 ID、操作定义（`Op`、`Body[T]`）、健康检查、带排空时间的 `Serve`                  |
| `idempotency` | POST 的 `Idempotency-Key`：同一个 key 重试拿到第一次的响应。表 `api_idempotency` 由 `pg.Migrate` 建在每个服务的库里，`Prune` 删除 7 天前的记录   |
| `service`     | 一个二进制、多个命令（`serve`、`migrate`、`openapi`…）：选择命令、遥测（`packages/telemetry-go`）、SIGINT/SIGTERM                                |

几条约定由这些包保证：

- **错误只有一种形状。** 不管错误来自业务、huma 的校验还是路由，响应都是 `{"error": {"code", "message", "request_id"}}`。错误链上有 `*apierr.Error` 就用它的状态和消息；其他错误记日志并回 500。上游失败用 424，不用 502/504（Cloudflare 会换掉源站的 502/504 页面，错误体到不了浏览器）。
- **请求可追踪。** 网关给的 `X-Request-Id` 一路带到错误体和日志；没有就生成一个。
- **每个服务有自己的库。** `pg.Setup` 在库不存在时建库、迁移，然后返回连接池；服务的迁移和框架的迁移各用自己的版本表（`goose_db_version`、`service_framework_version`），框架的在后，只建服务 schema 里没有的表。
- **写操作可以安全重试。** 创建类的 POST 用 `idempotency.Do`：操作在记录 key 的同一个事务里运行，存下的响应一定对应已提交的副作用。同一个 key 的请求在事务开头按 key 加锁（`pg_advisory_xact_lock`）排队，后到的在锁后查到前一个的响应直接返回，所以并发重试也只执行一次。操作一旦开始就做完：它可能已经做了数据库回滚不了的事（比如把命令发布到队列），所以 `fn` 拿到的 context 保留请求的值、但不随客户端断开而取消（上限 `idempotency.Timeout`），事务照样提交。`fn` 里一律用它给的 `ctx`。

## 一个服务的结构

```
apps/<service>/
  main.go             组装根：读配置、连数据库和依赖、注册命令
  migrations/         schema（goose 的 SQL 格式）和嵌入它的 migrations.go
  internal/<领域>/     业务：规则和 SQL，不碰 HTTP
  internal/api/       传输层：huma 操作，把请求翻译成领域调用
```

各层之间的规则：

- **领域包**（如 `internal/routines`、`internal/chat`）持有业务规则和 SQL。读操作接受任意 `pg.DB`（连接池或事务），写操作接受调用方的事务（`pgx.Tx`），由调用方决定事务边界，因此同一个写操作既能单独提交，也能被 `idempotency.Do` 包住。对调用方可见的失败返回 `*apierr.Error`。领域包不导入 `httpapi`。
- **API 包**只做传输：定义输入输出类型（OpenAPI 和前端类型由它们生成），开事务或用 `idempotency.Do`，调用领域，把结果放进 `httpapi.Body[T]`。它不写 SQL，不含业务判断。
- **`main.go`** 是唯一知道所有部件的地方：`config.Load[Config]()` 读配置，`pg.Setup` 打开数据库，连接 NATS、LLM 网关等依赖，构造领域服务和 API，然后交给 `service.Main`：

```go
func main() {
	service.Main("routine-service",
		service.Command{Name: "serve", Default: true, Run: serve},
		service.Migrate(databaseURL, migrations.All, true),
		service.OpenAPI(map[string]func() huma.API{
			"public": func() huma.API { return api.New(&api.Deps{}).API },
		}),
	)
}
```

`openapi` 命令只构造 API、不连接任何东西，Turbo 的 `openapi` 任务用它产出文档，web 的 `generate` 再从文档生成类型（`apps/web/redocly.yaml`）。

## 两个服务

| 服务                               | 命令                                                                            | 库                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 控制面（`apps/control-plane`）     | `api`、`internal`、`controller`、`migrate`、`openapi`、`ensure-runtime-network` | `axp`；迁移 1 是 Django 留下的 schema（Go 迁移），其余是 SQL |
| 定时任务（`apps/routine-service`） | `serve`（默认）、`migrate`、`openapi`                                           | `axp_routines`，启动时自建并迁移                             |

forge-service 和 llm-gateway 没有用这个框架：前者没有数据库、API 很小，后者是嵌入的 CLIProxyAPI（gin）。它们以后若需要数据库或生成 OpenAPI，应当迁过来，而不是各自再写一份。

## 测试

框架自己的测试覆盖错误信封（各种来源）、请求 ID、配置的默认值顺序、幂等的重放与冲突、命令选择。服务的测试用 `pgtest.Main(m, migrations)` 拿到自己的库，`pgtest.DB(t)` 在每个测试前清空；需要 NATS 的测试用 `AXP_TEST_NATS_URL` 打开。
