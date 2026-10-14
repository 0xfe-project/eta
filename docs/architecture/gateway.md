# 网关

本文说明 [#3](https://github.com/akarachen/axp/issues/3) 的实现。`apps/gateway` 只有 [Caddy](https://caddyserver.com) 配置：两个站点，生产中各是一个 Kamal 角色，开发时由同一个 Caddy 进程提供。

| 站点            | 调用方       | 生产角色与地址                                                 | 开发地址         |
| --------------- | ------------ | -------------------------------------------------------------- | ---------------- |
| `public.caddy`  | 浏览器       | `gateway`，kamal-proxy 之后的 `:8080`                          | `127.0.0.1:P`    |
| `runtime.caddy` | agent 运行时 | `runtime-gateway`，runtime 网络上的 `axp-runtime-gateway:8090` | `172.30.0.1:P+5` |

## 信任边界由网络划定

服务之间不共享密钥，各服务也不校验调用方，因为能连到它的只有该连的调用方：

- web、control-plane（公共 API 和内部 API，同一进程的两个 listener）、llm-gateway 都不在 runtime 网络上（开发时只监听 loopback，容器连不到）。浏览器只能经 `gateway` 访问它们，runtime 只能经 `runtime-gateway`。
- `gateway` 不在 runtime 网络上，因此 runtime 碰不到公共 API；`runtime-gateway` 只加载 runtime 站点。
- 控制面的路由按 listener 分开：信任 `X-AXP-Agent-Id` 的 runtime 路由（`/internal`、`/forge`、`/routines/mcp` 等）只在内部 listener（`:8001`）上，`gateway` 只转发到公共 listener（`:8000`），所以浏览器那一侧到不了它们（`apps/control-plane/main_test.go` 检查两个 listener 各自的路由）。
- runtime 网络上还有 NATS（runtime 把事件发到这里，见[命令与事件](queue.md)）、OpenTelemetry Collector（无凭据的 OTLP 入口）和 controller：它是唯一在 runtime 网络上的控制面进程，经各 runtime 的控制接口交付工作，那个接口只认 controller 持有的按智能体派生的令牌，所以同一网络上的 runtime 之间互相连得到端口，也调不动对方。

生产的鉴权在更外层（Cloudflare Access）；网关不做 CORS（同源）和限流，但拒绝跨站请求（见下）。Access 放行的只有 `/remote/`（远程电脑，每个接口自己鉴权：安装码或电脑的令牌，见[任务与远程电脑](tasks.md)）和 Artifact 的 `/share/artifacts/`、`/preview/artifacts/`（分享令牌或短时预览能力，见 [Artifact](artifacts.md#路由矩阵)）。

## 浏览器站点

按最长前缀匹配，不改写路径，保留浏览器的 `Host`：

| 前缀                                          | 上游                                                        |
| --------------------------------------------- | ----------------------------------------------------------- |
| `/api/llm/`                                   | llm-gateway                                                 |
| `/api/memory/`                                | memory-service                                              |
| `/observe/`                                   | OpenObserve                                                 |
| `/api/`（含 `/api/forge/`、`/api/routines/`） | control-plane                                               |
| `/remote/`                                    | control-plane                                               |
| `/share/artifacts/`、`/preview/artifacts/`    | control-plane（[Artifact](artifacts.md)的公开页与私有预览） |
| `/`                                           | web                                                         |

- 删除客户端发来的所有 `X-AXP-*` 头。
- 跨站请求（`Sec-Fetch-Site` 为 `cross-site`/`same-site`，或 `Origin: null`）返回 403 `CROSS_SITE_FORBIDDEN`，只放过 GET/HEAD 的顶层导航和 Artifact 的 `/share/artifacts/`、`/preview/artifacts/`：AXP 没有自己的登录，这样同域的沙箱页面和其他站点都不能借浏览器的 Cookie 操作 AXP（见 [Artifact](artifacts.md#同域与-csrf)）。
- 每个请求生成新的 `X-Request-Id`，转发给上游并写回响应；control-plane 的错误体 `request_id` 与之一致。
- `/api/` 和 llm 的流式响应逐条转发（`flush_interval -1`），WebSocket 原样透传。
- 请求体上限 32 MiB，远程电脑上传 Artifact 的 `/remote/v1/artifacts` 是 100 MB（413 `PAYLOAD_TOO_LARGE`），上游不可达返回 503 `UPSTREAM_UNAVAILABLE`（不用 502：Cloudflare 会把源站的 502 和 504 换成它自己的错误页，错误体到不了浏览器；控制面对外部依赖的失败同样用 424 而不是 502），错误体与 control-plane 相同：`{"error": {"code", "message", "request_id"}}`。
- `/up` 由网关自己应答，供 kamal-proxy 健康检查。
- 访问日志为 JSON；页面、静态资源、OpenObserve 与 `/up` 不记录。

## runtime 站点

- 每个路由先用 `forward_auth` 问内部 API `GET /internal/v1/runtime-auth`：智能体的 key 是 `<智能体 ID>.<HMAC(AXP_SECRET_KEY, agent:<智能体 ID>)>`，智能体存在时返回 204 和 `X-AXP-Agent-Id`。网关用这个值替换请求里的同名头（runtime 自己设的会被覆盖），删掉 `Authorization` 后转发；无效时把 403 原样返回给 runtime。runtime 不经这里向控制面汇报（它们走 NATS），所以 runtime 站点不转发 `/internal/*`。
- 插件的路由在问的时候带上插件名（`?plugin=`），这个智能体的环境包没有带来该插件时返回 403 `PLUGIN_NOT_ENABLED`，所以去掉插件也收回了它的能力，而不只是隐藏工具：

  | 路由                                                | 上游           | 需要的插件  |
  | --------------------------------------------------- | -------------- | ----------- |
  | `/v1/*`（模型请求）                                 | llm-gateway    | —           |
  | `/memory/*`（MCP 与记忆 hook）                      | memory-service | `memory`    |
  | `/tasks/*`（MCP，见[任务](tasks.md)）               | 内部 API       | `tasks`     |
  | `/routines/*`（MCP，见[定时任务](routines.md)）     | 内部 API       | `routines`  |
  | `/artifacts/*`（上传，见 [Artifact](artifacts.md)） | 内部 API       | `artifacts` |
  | `/forge/mcp`（`open_pull_request`）                 | 内部 API       | `github`    |
  | `/forge/*`（git 与 gh 的凭据）                      | 内部 API       | —           |

  `/forge/credentials` 每个 runtime 启动时都会取（git 和 gh 用），不属于插件。
- 后面的服务只读 `X-AXP-Agent-Id`，自己不持有任何凭据；新增一个给 runtime 用的服务只是在 `runtime.caddy` 里加一条路由。

## 配置与检查

所有地址都有生产默认值（Kamal 网络别名），`scripts/dev.sh` 用环境变量覆盖：`AXP_GATEWAY_BIND`/`PORT`、`AXP_RUNTIME_GATEWAY_BIND`/`PORT`、`AXP_UPSTREAM_{WEB,API,LLM,MEMORY,OBSERVE,INTERNAL}`（`API` 和 `INTERNAL` 是控制面同一进程的两个 listener，生产为 `axp-api:8000` 与 `axp-api:8001`）；`AXP_GATEWAY_SITES` 选择加载的站点（默认全部）。Caddy 的版本在 `deploy/Dockerfile`、`scripts/dev.sh` 和 `apps/gateway/package.json` 中保持一致。`bun run lint` 用这个版本检查格式（`caddy fmt`）并校验配置（`caddy validate`）。
