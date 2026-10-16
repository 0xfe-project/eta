# 网关

本文说明 [#3](https://github.com/akarachen/axp/issues/3) 的实现。`apps/gateway` 只有 [Caddy](https://caddyserver.com) 配置：两个站点，生产中各是 job `axp` 的一个 task（`deploy/nomad/axp.nomad.hcl`），开发时由同一个 Caddy 进程提供（`scripts/dev-gateway.nomad.hcl`）。环境包的服务按 Nomad 的服务发现路由：网关的 task 用 template 把命名空间里的服务渲染成一张名字到地址的表（`bundles.caddy`），服务变了就给 Caddy 发 SIGUSR1 热重载。

| 站点            | 调用方                         | 生产                                                         | 开发地址                      |
| --------------- | ------------------------------ | ------------------------------------------------------------ | ----------------------------- |
| `public.caddy`  | 浏览器                         | `gateway`，宿主网络上的 `127.0.0.1:24180`（宿主 Caddy 反代） | `127.0.0.1:P`（HTTPS：`P+8`） |
| `runtime.caddy` | 智能体的 runtime、环境包的服务 | 宿主网络上的 `0.0.0.0:24090`，容器从 `172.26.64.1` 连        | `172.26.64.1:P+5`             |

## 信任边界

服务之间不共享密钥，各服务也不校验调用方。k3s 时期由 NetworkPolicy 保证只有该连的调用方连得到；换到 Nomad 后没有网络策略，bridge 网络上的容器连得到宿主网络上的所有端口（见 `deploy/README.md`），这是一笔明知的债，应由内部 listener 和基础设施改为凭密钥认证来还。现在仍然成立的是：

- 智能体（`<ns>-agents`）和环境包的服务（`<ns>`）该连的只有 `runtime-gateway` 和 NATS（runtime 把事件发到这里，见[命令与事件](queue.md)），环境包的服务另外连自己的数据库。AXP 的进程监听 loopback，`runtime-gateway` 监听所有地址。
- 浏览器只经浏览器站点，runtime 和环境包的服务只经 runtime 站点；两个站点在同一个 Caddy 进程里，各自监听自己的地址。
- 控制面的路由按 listener 分开：信任 `X-AXP-Agent-Id` 的路由（`/internal`、`/forge`、`/routines/mcp`、模型的 `/v1` 等）只在内部 listener（`127.0.0.1:24001`）上，浏览器站点只转发到公共 listener（`127.0.0.1:24000`），所以浏览器那一侧到不了它们（`apps/control-plane/main_test.go` 检查两个 listener 各自的路由）。
- controller 经各 runtime 的控制接口交付工作，那个接口只认 controller 持有的按智能体派生的令牌，所以 runtime 之间连得到端口，也调不动对方。智能体的 job 不带 Nomad 的工作负载身份。

生产的鉴权在更外层（Cloudflare Access）；网关不做 CORS（同源）和限流，但拒绝跨站请求（见下）。Access 放行的只有 `/remote/`（远程电脑，每个接口自己鉴权：安装码或电脑的令牌，见[任务与远程电脑](tasks.md)）和 Artifact 的 `/share/artifacts/`、`/preview/artifacts/`（分享令牌或短时预览能力，见 [Artifact](artifacts.md#路由矩阵)）。

## 浏览器站点

按最长前缀匹配，不改写路径，保留浏览器的 `Host`：

| 前缀                                                       | 上游                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `/api/bundles/<name>/`                                     | 环境包 `<name>` 的服务，路径改成 `/api/<name>/`              |
| `/sentry/api/<项目>/envelope/`（只有这一种路径）           | Rustrak，去掉 `/sentry`（浏览器的错误上报）                  |
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
- 访问日志为 JSON；页面、静态资源、`/sentry` 与 `/up` 不记录。

## runtime 站点

- 每个路由先用 `forward_auth` 问内部 API `GET /internal/v1/runtime-auth`：智能体的 key 是 `<智能体 ID>.<HMAC(AXP_SECRET_KEY, agent:<智能体 ID>)>`，智能体存在时返回 204 和 `X-AXP-Agent-Id`。网关用这个值替换请求里的同名头（runtime 自己设的会被覆盖），删掉 `Authorization` 后转发；无效时把 403 原样返回给 runtime。runtime 不经这里向控制面汇报（它们走 NATS），所以 runtime 站点不转发 `/internal/*`。
- 插件的路由在问的时候带上插件名（`?plugin=`），这个智能体的环境包没有带来该插件时返回 403 `PLUGIN_NOT_ENABLED`，所以去掉插件也收回了它的能力，而不只是隐藏工具：

  | 路由                                                  | 上游                       | 需要                   |
  | ----------------------------------------------------- | -------------------------- | ---------------------- |
  | `/v1/*`（模型请求）                                   | 内部 API（嵌入的模型网关） | —（服务：`uses: llm`） |
  | `/bundles/<name>/*`（环境包的服务，改成 `/<name>/*`） | 环境包 `<name>` 的服务     | 载入了环境包 `<name>`  |
  | `/tasks/*`（MCP，见[任务](tasks.md)）                 | 内部 API                   | 插件 `tasks`           |
  | `/routines/*`（MCP，见[定时任务](routines.md)）       | 内部 API                   | 插件 `routines`        |
  | `/artifacts/*`（上传，见 [Artifact](artifacts.md)）   | 内部 API                   | 插件 `artifacts`       |
  | `/forge/mcp`（`open_pull_request`）                   | 内部 API                   | 插件 `github`          |
  | `/forge/*`（git 与 gh 的凭据）                        | 内部 API                   | —                      |

  `/forge/credentials` 每个 runtime 启动时都会取（git 和 gh 用），不属于插件。
- `/sentry/api/<项目>/envelope/` 不鉴权，转给 Rustrak：环境包服务的 `SENTRY_DSN` 指向这里（控制面从自己的 DSN 推出，只有公钥）。Rustrak 的其他接口和界面不经任何网关。
- 环境包的服务用自己的令牌（`bundle.<名字>.<HMAC>`，在它的环境变量 `AXP_BUNDLE_TOKEN` 里）调用，只能用它在 `bundle.json` 的 `uses` 里声明的：`llm`（`/v1`，这时它在 `X-AXP-Agent-Id` 里说明用量记在哪个智能体名下）和其他环境包的服务（这时它的身份是 `bundle-<名字>`）。它碰不到插件路由和 `/forge`。网关另外带上 `X-AXP-Bundle`，并删掉调用方发来的 `X-AXP-Group-Id`、`X-AXP-Bundle`。
- 后面的服务只读这些头，自己不持有任何凭据。新增一个给智能体用的服务就是写一个带服务的环境包（[环境包](bundles.md#服务)），网关不用改：`/bundles/<name>/` 和 `/api/bundles/<name>/` 用路径里的名字在 Nomad 的服务发现里找它。

## 配置与检查

所有地址都有生产默认值（宿主 loopback 上的固定端口），开发的网关 job（`scripts/dev-gateway.nomad.hcl`）用环境变量覆盖：`AXP_GATEWAY_BIND`/`PORT`、`AXP_RUNTIME_GATEWAY_BIND`/`PORT`、`AXP_UPSTREAM_{WEB,API,SENTRY,INTERNAL}`（`API` 和 `INTERNAL` 是控制面同一进程的两个 listener，生产为 `127.0.0.1:24000` 与 `127.0.0.1:24001`）。Caddyfile 加载同目录下所有 `*.caddy`，开发时多一个 HTTPS 站点；环境包服务的路由表在 `/local/bundles.caddy`，由网关 task 的 template 渲染，还没渲染时（以及 lint 时）没有任何环境包的地址。Caddy 的版本在 `deploy/Dockerfile`、`scripts/dev.sh` 和 `apps/gateway/package.json` 中保持一致。`bun run lint` 用这个版本检查格式（`caddy fmt`）并校验配置（`caddy validate`）。
