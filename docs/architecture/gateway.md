# 网关

本文说明 [#3](https://github.com/akarachen/axp/issues/3) 的实现。`apps/gateway` 只有 [Caddy](https://caddyserver.com) 配置：两个站点，生产中各是一个 Kamal 角色，开发时由同一个 Caddy 进程提供。

| 站点            | 调用方       | 生产角色与地址                                                 | 开发地址         |
| --------------- | ------------ | -------------------------------------------------------------- | ---------------- |
| `public.caddy`  | 浏览器       | `gateway`，kamal-proxy 之后的 `:8080`                          | `127.0.0.1:P`    |
| `runtime.caddy` | agent 运行时 | `runtime-gateway`，runtime 网络上的 `axp-runtime-gateway:8090` | `172.30.0.1:P+5` |

## 信任边界由网络划定

服务之间不共享密钥，各服务也不校验调用方，因为能连到它的只有该连的调用方：

- web、control-plane（公共 API）、llm-gateway 和内部运行协议都不在 runtime 网络上（开发时只监听 loopback，容器连不到）。浏览器只能经 `gateway` 访问它们，runtime 只能经 `runtime-gateway`。
- `gateway` 不在 runtime 网络上，因此 runtime 碰不到公共 API；`runtime-gateway` 只加载 runtime 站点。
- runtime 网络上还有 S3（只认预签名地址）、NATS（runtime 从这里取命令，见[队列](queue.md)）和 OpenTelemetry Collector（无凭据的 OTLP 入口）。S3 只有 8333 端口可达：SeaweedFS 除 S3 外还在其他端口提供不鉴权的 filer、master、volume、WebDAV 和管理接口（直接读写任何智能体的快照），所以它本身不在 runtime 网络上（[#67](https://github.com/akarachen/axp/issues/67)）。
  - 生产：SeaweedFS（accessory `s3`）只在 Kamal 网络上（别名 `axp-s3`、`axp-seaweedfs`）；runtime 网络上的 `axp-s3` 是 accessory `s3-proxy`，一个只监听 8333 的 Caddy（`caddy reverse-proxy`），转发到 `axp-seaweedfs:8333`。它原样保留 `Host`，预签名地址（`http://axp-s3:8333/...`，签名包含 Host）在 runtime 和控制面两侧都有效。上游不能写 `axp-s3`：代理同时在两个网络上，这个名字也指向它自己。
  - 开发：`axp-dev-s3` 不在 `axp-runtime` 网络上，只把 8333 发布到 runtime 网络的网关地址 `172.30.0.1:8333`，宿主机进程与 runtime 用同一地址；其他端口不发布，runtime 连不到。

生产的鉴权在更外层（Cloudflare Access）；网关不做 CORS（同源）和限流。唯一的例外是 `/remote/`：远程电脑访问它，Access 对这个路径放行，其中每个接口自己鉴权（安装码或电脑的令牌，见[任务与远程电脑](tasks.md)）。

## 浏览器站点

按最长前缀匹配，不改写路径，保留浏览器的 `Host`：

| 前缀             | 上游            |
| ---------------- | --------------- |
| `/api/llm/`      | llm-gateway     |
| `/api/memory/`   | memory-service  |
| `/api/forge/`    | forge-service   |
| `/api/routines/` | routine-service |
| `/observe/`      | OpenObserve     |
| `/api/`          | control-plane   |
| `/remote/`       | control-plane   |
| `/`              | web             |

- 删除客户端发来的所有 `X-AXP-*` 头。
- 每个请求生成新的 `X-Request-Id`，转发给上游并写回响应；control-plane 的错误体 `request_id` 与之一致。
- `/api/` 和 llm 的流式响应逐条转发（`flush_interval -1`），WebSocket 原样透传。
- 请求体上限 32 MiB（413 `PAYLOAD_TOO_LARGE`），上游不可达返回 503 `UPSTREAM_UNAVAILABLE`（不用 502：Cloudflare 会把源站的 502 和 504 换成它自己的错误页，错误体到不了浏览器；控制面对外部依赖的失败同样用 424 而不是 502），错误体与 control-plane 相同：`{"error": {"code", "message", "request_id"}}`。
- `/up` 由网关自己应答，供 kamal-proxy 健康检查。
- 访问日志为 JSON；页面、静态资源、OpenObserve 与 `/up` 不记录。

## runtime 站点

- `/internal/*` 原样转发给内部运行协议，由它自己认证 runtime：令牌由它签发，换代后的旧实例也由它拒绝（`409 STALE_GENERATION`）。
- 其余路由先用 `forward_auth` 问内部运行协议 `GET /internal/v1/runtime-auth`：runtime 的 key 是 `<实例 ID>.<令牌>`，有效时返回 204 和 `X-AXP-Agent-Id`。网关用这个值替换请求里的同名头（runtime 自己设的会被覆盖），删掉 `Authorization` 后转发；无效时把 403/409 原样返回给 runtime。
- 插件的路由在问的时候带上插件名（`?plugin=`），这个智能体没有启用该插件时返回 403 `PLUGIN_NOT_ENABLED`，所以关掉插件也收回了它的能力，而不只是隐藏工具：

  | 路由                                  | 上游             | 需要的插件 |
  | ------------------------------------- | ---------------- | ---------- |
  | `/v1/*`（模型请求）                   | llm-gateway      | —          |
  | `/memory/*`（MCP 与记忆 hook）        | memory-service   | `memory`   |
  | `/tasks/*`（MCP，见[任务](tasks.md)） | 内部运行协议服务 | `tasks`    |
  | `/forge/mcp`（`open_pull_request`）   | forge-service    | `github`   |
  | `/forge/*`（git 与 gh 的凭据）        | forge-service    | —          |

  `/forge/credentials` 每个 runtime 启动时都会取（git 和 gh 用），不属于插件。
- 后面的服务只读 `X-AXP-Agent-Id`，自己不持有任何凭据；新增一个给 runtime 用的服务只是在 `runtime.caddy` 里加一条路由。

## 配置与检查

所有地址都有生产默认值（Kamal 网络别名），`scripts/dev.sh` 用环境变量覆盖：`AXP_GATEWAY_BIND`/`PORT`、`AXP_RUNTIME_GATEWAY_BIND`/`PORT`、`AXP_UPSTREAM_{WEB,API,LLM,MEMORY,FORGE,ROUTINES,OBSERVE,INTERNAL}`；`AXP_GATEWAY_SITES` 选择加载的站点（默认全部）。Caddy 的版本在 `deploy/Dockerfile`、`deploy/deploy.yml`（`s3-proxy`）、`scripts/dev.sh` 和 `apps/gateway/package.json` 中保持一致。`bun run lint` 用这个版本检查格式（`caddy fmt`）并校验配置（`caddy validate`）。
