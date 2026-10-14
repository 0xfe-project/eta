# 网关

本文说明 [#3](https://github.com/akarachen/axp/issues/3) 的实现。`apps/gateway` 只有 [Caddy](https://caddyserver.com) 配置：两个站点，生产中各是一个 Deployment（`deploy/k3s/app/gateways.yaml`），开发时由同一个 Caddy 进程提供。

| 站点            | 调用方                         | 生产                                                         | 开发地址                      |
| --------------- | ------------------------------ | ------------------------------------------------------------ | ----------------------------- |
| `public.caddy`  | 浏览器                         | `gateway`，节点网络上的 `127.0.0.1:24180`（宿主 Caddy 反代） | `127.0.0.1:P`（HTTPS：`P+8`） |
| `runtime.caddy` | 智能体的 runtime、环境包的服务 | `runtime-gateway`，Service `runtime-gateway:8090`            | `10.42.0.1:P+5`               |

## 信任边界由网络划定

服务之间不共享密钥，各服务也不校验调用方，因为能连到它的只有该连的调用方（NetworkPolicy，`deploy/k3s`）：

- AXP 自己的命名空间（生产 `axp`）只接受本命名空间里的连接。智能体（`<ns>-agents`）和环境包的服务（`<ns>-bundles`）只连得到 `runtime-gateway`、NATS（runtime 把事件发到这里，见[命令与事件](queue.md)）和 OpenTelemetry Collector（无凭据的 OTLP 入口），环境包的服务另外连得到自己的数据库。开发时 AXP 的进程跑在宿主上，只监听 loopback，Pod 连不到；`runtime-gateway` 监听节点在 Pod 网络上的地址。
- 浏览器只能经 `gateway`，runtime 和环境包的服务只能经 `runtime-gateway`；`runtime-gateway` 只加载 runtime 站点。
- 控制面的路由按 listener 分开：信任 `X-AXP-Agent-Id` 的路由（`/internal`、`/forge`、`/routines/mcp`、模型的 `/v1` 等）只在内部 listener（`:8001`）上，`gateway` 只转发到公共 listener（`:8000`），所以浏览器那一侧到不了它们（`apps/control-plane/main_test.go` 检查两个 listener 各自的路由）。
- controller 经各 runtime 的控制接口交付工作，那个接口只认 controller 持有的按智能体派生的令牌，所以同一命名空间里的 runtime 之间连得到端口，也调不动对方。智能体的 Pod 不挂 Kubernetes 的令牌。

生产的鉴权在更外层（Cloudflare Access）；网关不做 CORS（同源）和限流，但拒绝跨站请求（见下）。Access 放行的只有 `/remote/`（远程电脑，每个接口自己鉴权：安装码或电脑的令牌，见[任务与远程电脑](tasks.md)）和 Artifact 的 `/share/artifacts/`、`/preview/artifacts/`（分享令牌或短时预览能力，见 [Artifact](artifacts.md#路由矩阵)）。

## 浏览器站点

按最长前缀匹配，不改写路径，保留浏览器的 `Host`：

| 前缀                                                       | 上游                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `/api/bundles/<name>/`                                     | 环境包 `<name>` 的服务，路径改成 `/api/<name>/`              |
| `/observe/`                                                | OpenObserve                                                  |
| `/api/`（含 `/api/forge/`、`/api/routines/`、`/api/llm/`） | control-plane                                                |
| `/remote/relay/`                                           | 中继（环境包 `agenvo` 的服务，见[任务与远程电脑](tasks.md)） |
| `/remote/`                                                 | control-plane                                                |
| `/share/artifacts/`、`/preview/artifacts/`                 | control-plane（[Artifact](artifacts.md)的公开页与私有预览）  |
| `/`                                                        | web                                                          |

- 删除客户端发来的所有 `X-AXP-*` 头。
- 跨站请求（`Sec-Fetch-Site` 为 `cross-site`/`same-site`，或 `Origin: null`）返回 403 `CROSS_SITE_FORBIDDEN`，只放过 GET/HEAD 的顶层导航和 Artifact 的 `/share/artifacts/`、`/preview/artifacts/`：AXP 没有自己的登录，这样同域的沙箱页面和其他站点都不能借浏览器的 Cookie 操作 AXP（见 [Artifact](artifacts.md#同域与-csrf)）。
- 每个请求生成新的 `X-Request-Id`，转发给上游并写回响应；control-plane 的错误体 `request_id` 与之一致。
- `/api/` 和 llm 的流式响应逐条转发（`flush_interval -1`），WebSocket 原样透传。
- 请求体上限 32 MiB，远程电脑上传 Artifact 的 `/remote/v1/artifacts` 是 100 MB（413 `PAYLOAD_TOO_LARGE`），上游不可达返回 503 `UPSTREAM_UNAVAILABLE`（不用 502：Cloudflare 会把源站的 502 和 504 换成它自己的错误页，错误体到不了浏览器；控制面对外部依赖的失败同样用 424 而不是 502），错误体与 control-plane 相同：`{"error": {"code", "message", "request_id"}}`。
- `/up` 由网关自己应答，供健康检查。
- 访问日志为 JSON；页面、静态资源、OpenObserve 与 `/up` 不记录。

## runtime 站点

- 每个路由先用 `forward_auth` 问内部 API `GET /internal/v1/runtime-auth`：智能体的 key 是 `<智能体 ID>.<HMAC(AXP_SECRET_KEY, agent:<智能体 ID>)>`，智能体存在时返回 204 和 `X-AXP-Agent-Id`。网关用这个值替换请求里的同名头（runtime 自己设的会被覆盖），删掉 `Authorization` 后转发；无效时把 403 原样返回给 runtime。runtime 不经这里向控制面汇报（它们走 NATS），所以 runtime 站点不转发 `/internal/*`。
- 插件的路由在问的时候带上插件名（`?plugin=`），这个智能体的环境包没有带来该插件时返回 403 `PLUGIN_NOT_ENABLED`，所以去掉插件也收回了它的能力，而不只是隐藏工具：

  | 路由                                                  | 上游                       | 需要                   |
  | ----------------------------------------------------- | -------------------------- | ---------------------- |
  | `/v1/*`（模型请求）                                   | 内部 API（嵌入的模型网关） | —（服务：`uses: llm`） |
  | `/bundles/<name>/*`（环境包的服务，改成 `/<name>/*`） | Service `<name>`           | 载入了环境包 `<name>`  |
  | `/tasks/*`（MCP，见[任务](tasks.md)）                 | 内部 API                   | 插件 `tasks`           |
  | `/routines/*`（MCP，见[定时任务](routines.md)）       | 内部 API                   | 插件 `routines`        |
  | `/artifacts/*`（上传，见 [Artifact](artifacts.md)）   | 内部 API                   | 插件 `artifacts`       |
  | `/forge/mcp`（`open_pull_request`）                   | 内部 API                   | 插件 `github`          |
  | `/forge/*`（git 与 gh 的凭据）                        | 内部 API                   | —                      |

  `/forge/credentials` 每个 runtime 启动时都会取（git 和 gh 用），不属于插件。
- 环境包的服务用自己的令牌（`bundle.<名字>.<HMAC>`，在 Secret `axp-<名字>` 里）调用，只能用它在 `bundle.json` 的 `uses` 里声明的：`llm`（`/v1`，这时它在 `X-AXP-Agent-Id` 里说明用量记在哪个智能体名下）和其他环境包的服务（这时它的身份是 `bundle-<名字>`）。它碰不到插件路由和 `/forge`。网关另外带上 `X-AXP-Bundle`，并删掉调用方发来的 `X-AXP-Group-Id`、`X-AXP-Bundle`。
- 后面的服务只读这些头，自己不持有任何凭据。新增一个给智能体用的服务就是写一个带服务的环境包（[环境包](bundles.md#服务)），网关不用改：`/bundles/<name>/` 和 `/api/bundles/<name>/` 用路径里的名字找集群里的 Service。

## 配置与检查

所有地址都有生产默认值（命名空间 `axp` 里的 Service），`scripts/dev.sh` 用环境变量覆盖：`AXP_GATEWAY_BIND`/`PORT`、`AXP_RUNTIME_GATEWAY_BIND`/`PORT`、`AXP_UPSTREAM_{WEB,API,OBSERVE,INTERNAL}`（`API` 和 `INTERNAL` 是控制面同一进程的两个 listener，生产为 `api:8000` 与 `api:8001`）、`AXP_BUNDLES_NAMESPACE`（环境包服务所在的命名空间）和 `AXP_CLUSTER_DNS`（找它们用的集群 DNS）；`AXP_GATEWAY_SITES` 选择加载的站点（默认全部）。Caddy 的版本在 `deploy/Dockerfile`、`scripts/dev.sh` 和 `apps/gateway/package.json` 中保持一致。`bun run lint` 用这个版本检查格式（`caddy fmt`）并校验配置（`caddy validate`）。
