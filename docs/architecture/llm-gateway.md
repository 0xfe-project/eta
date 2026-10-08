# LLM 网关

本文说明 [#5](https://github.com/akarachen/axp/issues/5)（llm-gateway 与模型选择）、[#4](https://github.com/akarachen/axp/issues/4)（OAuth 登录）和 [#6](https://github.com/akarachen/axp/issues/6)（前端）的实现。

## 组成

`apps/llm-gateway` 是一个 Go 进程，按 CLIProxyAPI（CPA）的 [SDK 用法](https://github.com/router-for-me/CLIProxyAPI/blob/main/docs/sdk-usage.md) 嵌入 `cliproxy.Service`，并在 CPA 的 gin 引擎上挂载 AXP 自己的路由：

| 路径               | 调用方                                        | 鉴权                                         |
| ------------------ | --------------------------------------------- | -------------------------------------------- |
| `/api/llm/v1/*`    | 浏览器（经 `gateway`）、control-plane（直连） | 无：只有这两者连得到（见[网关](gateway.md)） |
| `/v1/*`            | runtime 中的 Codex（经 `runtime-gateway`）    | 网关注入的 `X-AXP-Agent-Id`                  |
| `/v0/management/*` | 仅进程内回环调用                              | 每次启动随机生成的管理密码                   |

CPA 负责 token 刷新、按模型名在账号间轮换、协议转换。凭据只存在 llm-gateway 的状态目录（工作目录下的 `var/llm-gateway/auths`，生产为卷 `axp-llm`）；runtime 容器只拿到 runtime 网关的地址和自己的实例令牌。

### runtime 鉴权

runtime 用 `<实例 ID>.<令牌>`（control-plane 签发，换代即失效）作为调用 `/v1` 的 API key。runtime 网关逐个请求向内部运行协议确认这个 key，再以 `X-AXP-Agent-Id` 把所属 Agent 交给 llm-gateway；被替换的实例立即无法再调用模型。llm-gateway 向 CPA 注册的唯一访问提供者只读这个头（`cpa.AgentHeader`），没有它的请求一律 401。

### 与 CPA 的边界

只使用 SDK 导出的包（`sdk/cliproxy`、`sdk/cliproxy/auth`、`sdk/access`、`sdk/api`、`sdk/config`、`sdk/translator/builtin`）和 CPA 的管理 HTTP API，不导入 `internal/`。`config.yaml` 在每次启动时生成。管理 API 通过 `MANAGEMENT_PASSWORD` 开启、`allow-remote: false`，并由 `cpa.Proxy.Management()` 在进程内直接调用 gin 引擎，不经过网络。

`contract_test.go` 守住依赖的 CPA 行为：`/v1` 只接受访问提供者认可的 key，通过管理 API 上传 CPA 格式的 codex 凭据后，auth manager 能列出它、模型进入注册表和 `/v1/models`，停用和删除生效。升级 CPA 时必须通过。

## 接入方式（Connector）

```go
type Connector interface {
    Info() ConnectorInfo
    StartLogin(ctx) (*LoginSession, error)
    PollLogin(ctx, id) (*LoginSession, error)
    CancelLogin(ctx, id) error
}
```

Connector 只负责“凭据怎么进来”；连接列表、启停、删除统一走 `coreauth.Manager` 和管理 API，模型统一来自 CPA 的模型注册表。

- **Grok（xAI）**：回环调用管理 API 的 `xai-auth-url` / `get-auth-status` / `oauth-session`，CPA 自己保存凭据。
- **Codex**：OpenAI 的设备码流程（`/api/accounts/deviceauth/usercode` → 轮询 `/deviceauth/token` → `/oauth/token`，`redirect_uri` 为 OpenAI 自己的 `deviceauth/callback`），不依赖 localhost 回调。CPA 只在 CLI 中实现了这一流程（验证码打印到标准输出），因此在 Connector 中实现协议，得到的 token 按 CPA 的 codex 凭据文件格式通过 `POST /v0/management/auth-files` 交给 CPA。
- 两者都是设备码流程，登录不需要用户输入。以后接入 raw API key 时再给 Connector 加上提交输入的方法，在其中注册 Auth（或经管理 API 写入 `codex-api-key` / `openai-compatibility`），数据面和 control-plane 不用改。

## 状态与模型目录

`GET /api/llm/v1/connections` 把 CPA 的凭据状态归一化为 `active`、`disabled`、`needs_login`、`rate_limited`、`error`，附中文说明和恢复时间，不返回 token。CPA 把请求失败记在每个模型上（`ModelStates`），所以任一模型收到 401 即视为账号需要重新登录；所有模型都在冷却中才视为账号被限流。

`GET /api/llm/v1/models` 返回模型目录。见过的模型持久化在 `models.json`，账号失效或被移除后模型仍在目录中（`available: false` 并附原因），智能体保留原来的选择，重新绑定后自动恢复。图像、视频等非对话模型和 `codex-auto-review` 被过滤。

## control-plane 与 runtime

- `Agent.model` 存目录中的模型 ID；创建、修改时校验存在性，修改模型与修改指令一样递增 `config_version`，空闲时重启 runtime。
- `POST /chat/messages` 在加锁前检查模型：未设置返回 409 `MODEL_NOT_SET`，不可用（或网关不可达）返回 409 `MODEL_UNAVAILABLE`。目录在进程内缓存 10 秒。
- controller 给 runtime 注入网关的 `/v1` 地址（`AXP_LLM_BASE_URL`）和模型的上下文窗口。
- runtime 给 Codex 加上 `model_provider = "axp"` 及 `model_providers.axp.{base_url, wire_api = "responses", env_key = "AXP_RUNTIME_LLM_KEY"}`，并在需要时设置 `model_context_window`；Codex 进程的 `AXP_RUNTIME_LLM_KEY` 就是上面的实例 key。

## 前端

- 设置 → “模型服务”：按 Connector 列出账号、状态和错误，提供重新登录、停用/启用、移除；设备码弹窗显示验证码、授权链接和倒计时，每 2 秒轮询。账号需要处理时，设置按钮和菜单显示红点。
- 账号和模型目录每 30 秒刷新一次；发送收到 `MODEL_*` 错误时立即刷新。
- 智能体编辑器有模型下拉框（按服务分组，不可用的模型禁用），新建时默认选上次用过的模型。模型未设置或不可用时，聊天输入框禁用并给出“选择模型”“前往模型服务”“更换模型”入口。
