# 新增一个服务

本文是 [#60](https://github.com/AkaraChen/axp/issues/60) 的清单：新增一个后端服务时要改的地方。

先考虑做成控制面的模块（[#241](https://github.com/AkaraChen/axp/issues/241) 合进了 forge 和 routines，[#245](https://github.com/AkaraChen/axp/issues/245) 合进了模型网关）：路由挂到公共或内部 listener 上，不新增进程和部署。

需要独立的运行时（如 Python 的记忆服务）时，做成一个带服务的环境包（[环境包](bundles.md#服务)）：网关、部署、权限、数据库、凭据都由这条通用路径提供，不用为它改网关或部署配置。

## 环境包的服务

- [ ] `bundles/<name>/bundle.json` 的 `service`（`protocol`、`uses`、`database`），`service/*.yaml` 里是它的 Kubernetes 对象：一个名为 `<name>`、端口名 `http` 的 Service，和提供它的 Deployment 等。凭据和地址从 Secret `axp-<name>` 读。
- [ ] 智能体的路由在 `/<name>/` 下，用户的在 `/api/<name>/` 下；写了 `protocol` 时提供 `/.well-known/axp-service`。
- [ ] 智能体要用它时，插件的 MCP、hook 等访问 `${AXP_GATEWAY_URL}/bundles/<name>/…`。

## 代码与镜像

服务的代码在仓库里时（如 `bundles/memory/service`），由 AXP 构建它的镜像 `axp-<x>`：

- [ ] `apps/<service>/Dockerfile`（和 `Dockerfile.dockerignore`），只复制 Turbo 构建的产物。
- [ ] `apps/<service>/package.json`：`build`/`build:linux-<arch>`、`image:linux-amd64`、`image:linux-arm64`（`scripts/build/image.sh <kind> linux <arch>`）、`lint`、`test`；`apps/<service>/turbo.json` 里 `image:*` 依赖它的构建任务。
- [ ] `scripts/build/image.sh` 加一个 `<kind>`。
- [ ] `deploy/k3s/deploy.sh` 和 `scripts/dev.sh` 各加一行构建它（`axp-<x>:<版本>`）。
- [ ] Go 服务建在 [Go 服务框架](service-framework.md)上；`go.mod` 的 `go` 指令与其他模块一致，依赖的 `packages/*` 用 `replace` 指向本地目录。根 `package.json` 的 `check:go` 加上它。
- [ ] 浏览器要调用它的 API 时：`apps/web/src/lib/api.ts` 加一个客户端（`/api/bundles/<name>/…`）；有 OpenAPI 时 `apps/web/redocly.yaml` 加一项。

## 文档

- [ ] `docs/architecture/<service>.md`，并在 `README.md` 的实现说明里链接。
