# 新增一个服务

本文是 [#60](https://github.com/AkaraChen/axp/issues/60) 的清单：新增一个后端服务（例如 `apps/forge-service`、`apps/routine-service`）时要改的地方。漏改的地方往往到部署时才暴露，所以逐项核对。

## 代码与构建

Go 服务建在 [Go 服务框架](service-framework.md)上，按它的结构组织（`main.go`、`migrations/`、`internal/<领域>`、`internal/api`）。

- [ ] `apps/<service>/package.json`：`build:linux-amd64`、`build:linux-arm64`（`scripts/build/go.sh <二进制> linux <arch>`）、`lint`、`test`；浏览器要调用它的 API 时加 `openapi`（`go run . openapi > out/openapi.json`）。
- [ ] `apps/<service>/turbo.json`：构建任务的 `inputs`（含它用到的 `packages/*`），`test` 用到的环境变量。
- [ ] Go 服务：`go.mod` 的 `go` 指令与其他模块一致；依赖 `packages/service-go`（以及用到的其他 `packages/*`，含它们间接依赖的本地包），并 `replace` 到本地目录。仓库不用 `go.work`，每个模块都能单独构建，`go.mod` 就是构建时实际用到的版本；改完在模块目录运行 `go mod tidy`。
- [ ] 根 `package.json`：`dev:<service>`、`setup:go`、`test:<service>`、`check:go`。
- [ ] 根 `turbo.json`：`//#image:linux-amd64` 和 `//#image:linux-arm64` 依赖它的构建任务。

## 网关与 web

- [ ] `apps/gateway/public.caddy`：浏览器访问的 `/api/<service>/*`，并更新文件头的路由说明；runtime 要访问时还有 `runtime.caddy`（经 `as_agent` 认证）。
- [ ] `docs/architecture/gateway.md`：路由表（浏览器站点和 runtime 站点）与 `AXP_UPSTREAM_*` 环境变量列表；`apps/gateway/Caddyfile` 文件头的站点说明。
- [ ] 有 OpenAPI 时：`apps/web/redocly.yaml` 加一项，`apps/web/turbo.json` 的 `generate` 依赖它的 `openapi`，`apps/web/src/lib/api.ts` 用 `typedClient` 加一个客户端；`.gitignore` 已忽略 `src/api/*.gen.ts`，`knip.config.ts` 的 `ignoreUnresolved` 加上生成的模块。

## 开发环境

- [ ] `scripts/dev.sh`：端口（`PORT+N`，同时调整 `BLOCK_SIZE` 和文件头说明）、`AXP_<SERVICE>_ADDR`、`AXP_UPSTREAM_<SERVICE>`，网关容器的环境变量列表，`concurrently` 的 `--names`、`--prefix-colors` 和命令。
- [ ] `deploy/ports.env` 里开发端口范围的说明。
- [ ] `README.md`：服务列表与端口说明，以及命令表（新增的 `bun run` 脚本）。

## 生产

- [ ] `deploy/Dockerfile`：复制二进制（`out/${TARGETOS}-${TARGETARCH}/`），`EXPOSE` 端口，文件头的角色列表。
- [ ] `deploy/Dockerfile.dockerignore`：放行它的 `out/`。
- [ ] `deploy/deploy.yml`：角色（`cmd`、`env`、`network-alias`、健康检查），需要卷时加 `volume`；文件里的路由说明。
- [ ] `deploy/README.md`：角色表、日志的 `OTEL_SERVICE_NAME` 列表。
- [ ] 需要数据库时：自己的库，`pg.Setup` 在启动时建库并迁移（如 routine-service）；或用 `service.Migrate` 命令，在 `deploy/deploy.sh` 的 `migrate` 里执行（如控制面）。

## 文档

- [ ] `docs/architecture/<service>.md`，并在 `README.md` 的实现说明里链接。
