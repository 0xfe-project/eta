# 统一入口网关

本文说明 [#3](https://github.com/akarachen/axp/issues/3) 的实现。

## 路由

浏览器只访问 `apps/gateway`。路由表固定，按最长前缀匹配，不改写路径；开发与生产只有上游地址不同：

| 前缀        | 上游          | 环境变量                   |
| ----------- | ------------- | -------------------------- |
| `/api/llm/` | llm-gateway   | `AXP_GATEWAY_UPSTREAM_LLM` |
| `/api/`     | control-plane | `AXP_GATEWAY_UPSTREAM_API` |
| `/`         | web           | `AXP_GATEWAY_UPSTREAM_WEB` |

未配置的上游不注册路由。`/up` 由网关自己应答，供 kamal-proxy 健康检查。

服务之间的调用不经过网关：runtime 直连内部运行协议和 llm-gateway 的数据面，control-plane 直连 llm-gateway 的管理面。

## 网关做的事

- **流式**：`FlushInterval: -1`，SSE 逐条转发；WebSocket 升级原样透传（开发时的 Vite HMR、Codex 的 responses WebSocket 不经过这里）。服务端不设读写超时，只设请求头超时。
- **请求标识**：沿用客户端传入的合法 `X-Request-Id`（8–128 位 `[A-Za-z0-9._-]`），否则生成一个；转发给上游并写回响应。control-plane 的错误体 `request_id` 与之一致。
- **访问日志**：每个请求一行 JSON（方法、路径、上游、状态、字节数、耗时、request id）。
- **edge secret**：删除客户端发来的所有 `X-AXP-*` 头，再加上 `X-AXP-Edge-Secret`。control-plane（`EdgeSecretMiddleware`）和 llm-gateway 对公开接口校验该头，`/api/health`、`/api/llm/health` 除外；内部运行协议服务不校验。密钥为空时不校验（测试与临时运行）。
- **错误**：上游不可达返回 502 `UPSTREAM_UNAVAILABLE`，请求体超过 32 MiB 返回 413 `PAYLOAD_TOO_LARGE`，未匹配返回 404；错误体与 control-plane 相同：`{"error": {"code", "message", "request_id"}}`。
- **转发头**：保留浏览器的 `Host`，设置 `X-Forwarded-For/Host/Proto`。

不做鉴权（生产由 Cloudflare Access 负责）、CORS（同源）和限流。

## 部署

`deploy/deploy.yml` 中只有 `gateway` 角色由 kamal-proxy 代理（`primary_role`），SSE 相关的超时与缓冲设置也在这里。`web`、`api`、`llm` 通过 kamal 网络别名 `axp-web`、`axp-api`、`axp-llm` 被网关访问。
