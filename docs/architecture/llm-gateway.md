# LLM 网关

本文说明 [#5](https://github.com/akarachen/axp/issues/5)（LLM 网关与模型选择）、[#4](https://github.com/akarachen/axp/issues/4)（OAuth 登录）、[#6](https://github.com/akarachen/axp/issues/6)（前端）和 [#245](https://github.com/akarachen/axp/issues/245)（合入控制面）的实现。

## 组成

LLM 网关是控制面的模块（`apps/control-plane/internal/llm`），运行在提供 API 的 `axp-control-plane serve` 进程里，不是单独的服务或部署角色（#245 之前是 `apps/llm-gateway` 和 `llm` 角色）。它按 CLIProxyAPI（CPA）的 [SDK 用法](https://github.com/router-for-me/CLIProxyAPI/blob/main/docs/sdk-usage.md) 嵌入 `cliproxy.Service`：

- `llm.Module`：打开状态目录、运行 CPA 和用量账本，给出两个 listener 的路由和进程内的模型目录（`llm.Catalog`）。
- `llm/gateway`：与供应商无关的一层（连接、登录、目录、用量，以及 `/api/llm` 的 handler）；`gateway/connectors`（Codex、Grok）、`gateway/cpa`（嵌入 CPA）、`gateway/usage`（按主体记账）。
- `llm.Remote`：控制面的其他进程（controller、routine worker）经 internal listener 读目录的 HTTP client，带缓存和“读不到时沿用上次”。

| 路径               | listener             | 调用方                                                                            | 鉴权                                                        |
| ------------------ | -------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `/api/llm/v1/*`    | 公共（`24000`）      | 浏览器（经 `gateway`）                                                            | 与公共 API 相同：只有公开网关连得到（见[网关](gateway.md)） |
| `/v1/*`            | 内部（`24001`）      | runtime 中的 Codex 和环境包的服务（经 `runtime-gateway`）、routine worker（直连） | 调用方给出的 `X-AXP-Agent-Id`                               |
| `/v1/embeddings`   | 内部（`24001`）      | 记忆服务（经 `runtime-gateway`），见下面的 Embedding                              | 调用方给出的 `X-AXP-Agent-Id`                               |
| `/llm/v1/models`   | 内部（`24001`）      | controller、routine worker（`llm.Remote`）                                        | 无：只读目录                                                |
| `/v0/management/*` | 不在任何 listener 上 | 仅进程内调用（`cpa.Proxy.Management()`）                                          | 每次启动随机生成的管理密钥                                  |

提供 API 的进程直接调用模块读目录（聊天的模型校验、发送前检查、定时任务的模型校验），不经 HTTP。CPA 负责 token 刷新、按模型名在账号间轮换、协议转换。凭据只存在模块的状态目录（`AXP_LLM_STATE_DIR`，默认工作目录下的 `var/llm-gateway`：开发时是 `apps/control-plane/var/llm-gateway`，生产是 `api` 上的卷 `llm`）；runtime 只拿到 runtime 网关的地址和自己的实例令牌。

### runtime 鉴权

runtime 用 `<实例 ID>.<令牌>`（control-plane 签发，换代即失效）作为调用 `/v1` 的 API key。runtime 网关逐个请求向内部运行协议确认这个 key，再以 `X-AXP-Agent-Id` 把所属 Agent 交给 internal listener 上的 `/v1`；被替换的实例立即无法再调用模型。模块向 CPA 注册的唯一访问提供者只读这个头（`cpa.AgentHeader`），没有它的请求一律 401。

### Bundle 服务

环境包的服务（[环境包](bundles.md#服务)）在 `bundle.json` 的 `uses` 里声明 `llm` 后，用 AXP 发给它的令牌（环境变量 `AXP_BUNDLE_TOKEN`）经 `runtime-gateway` 调用 `/v1`：`forward_auth`（`/internal/v1/runtime-auth?use=llm`）校验令牌，它在 `X-AXP-Agent-Id` 里写明这次请求是替哪个智能体做的，用量记在那个智能体名下，网关另带上 `X-AXP-Bundle`。令牌碰不到插件路由、`/forge`、`/attachments`。记忆服务的抽取就走这条路。

### 与 CPA 的边界

只使用 SDK 导出的包（`sdk/cliproxy`、`sdk/cliproxy/auth`、`sdk/access`、`sdk/api`、`sdk/config`、`sdk/translator/builtin`）和 CPA 的管理 HTTP API，不导入 `internal/`。CPA 嵌进控制面主进程后的边界：

- 监听：SDK 的 `Service.Run` 一定会自己 `net.Listen`，无法关闭，所以让它监听 `127.0.0.1:0`（随机端口，没有任何路由指向它）。CPA 的 gin 引擎由 `RouterConfigurator` 交出来，作为 `http.Handler` 挂到控制面自己的 internal listener 的 `/v1/` 下；客户端断开即取消请求上下文（CPA 随之取消上游请求），流式响应逐段写到 net/http 的 `ResponseWriter`（背压就是 TCP 背压，不经缓冲）。CPA 的 `OnAfterStart` 之后（凭据已加载、路由已注册完）才算就绪：之前 `/v1` 返回 503，`serve` 也要等它就绪才打开两个 listener，所以 readiness 通过时模型目录已可读。
- 全局状态：CPA 的 logrus、模型注册表、访问提供者、用量插件、gin 模式都是进程级的，所以只有 `serve` 打开模块，controller 和 routine worker 不加载 CPA。
- 日志：CPA 用 logrus。模块把 logrus 的输出丢弃，改用 hook 把每条记录（级别、字段）交给 slog（`library=cliproxy`），走控制面同一套 Sentry 日志和错误追踪；不再接管整个进程的 stdout。CPA 启动和重载配置时各有一行 `fmt.Printf` 写到 stdout，只进容器日志。
- 管理 API：`config.yaml` 在每次启动时生成，管理密钥是每次启动随机生成的 `secret-key`（不放进环境变量，否则会被这个进程启动的命令继承），`allow-remote: false`；`cpa.Proxy.Management()` 在进程内直接调用 gin 引擎，不经过网络。
- 停机与故障：`serve` 的 SIGTERM 同时结束两个 listener 和 CPA（CPA 停 watcher、自动刷新，账本退出时写盘）。CPA 启动失败会让 `serve` 整体退出重启；上游的任何失败只体现在单个请求和账号/模型的状态上，不影响 readiness。

`contract_test.go` 用真实的模块和两个 listener 守住依赖的 CPA 行为，升级 CPA 时必须通过：通过管理 API 上传 CPA 格式的 codex 凭据后，auth manager 能列出它、模型进入注册表、目录（公共、internal 与进程内三种读法）和 `/v1/models`，`/v1` 只接受带 `X-AXP-Agent-Id` 的请求，停用和删除（含凭据文件）生效，用量按主体记账；再把一个 Codex API key 指向本地的假上游，验证非流式 chat completions、流式 responses（逐段到达）、客户端断开后上游请求被取消、上游 500/429 只影响该请求。

## 接入方式（Connector）

```go
type Connector interface {
    Info() ConnectorInfo
    StartLogin(ctx, LoginInput) (*LoginSession, error)
    PollLogin(ctx, id) (*LoginSession, error)
    SubmitLogin(ctx, id, LoginInput) error
    CancelLogin(ctx, id) error
}
```

Connector 只负责“凭据怎么进来”；连接列表、启停、删除统一走 `coreauth.Manager` 和管理 API，模型统一来自 CPA 的模型注册表。

- **Grok（xAI）**：回环调用管理 API 的 `xai-auth-url` / `get-auth-status` / `oauth-session`，CPA 自己保存凭据。
- **Codex**：OpenAI 的设备码流程（`/api/accounts/deviceauth/usercode` → 轮询 `/deviceauth/token` → `/oauth/token`，`redirect_uri` 为 OpenAI 自己的 `deviceauth/callback`），不依赖 localhost 回调。CPA 只在 CLI 中实现了这一流程（验证码打印到标准输出），因此在 Connector 中实现协议，得到的 token 按 CPA 的 codex 凭据文件格式通过 `POST /v0/management/auth-files` 交给 CPA。
- 以后的 raw API key：新增 Connector，在 `SubmitLogin` 中注册 Auth（或经管理 API 写入 `codex-api-key` / `openai-compatibility`），数据面和 control-plane 不用改。

## 状态与模型目录

`GET /api/llm/v1/connections` 把 CPA 的凭据状态归一化为 `active`、`disabled`、`needs_login`、`rate_limited`、`error`、`degraded`，附中文说明和恢复时间，不返回 token。状态以 CPA 实际怎么路由为准（`selector.isAuthBlockedForModel`），读时派生，网关不另存状态、不跑定时任务：

- CPA 把请求失败记在模型上（`ModelStates`），之后只有该模型被冷却，其他模型照常路由到这个账号。所以只有关于凭据本身的失败才影响整个账号：任一模型收到 401（`needs_login`）、凭据级额度（`credential_quota`）、尚未有模型状态时的账号级失败（429 → `rate_limited`，402/403 → `error`，其余 → `degraded`）。
- CPA 在失败后把凭据留在 `StatusError` 和最后一次错误上，直到有请求成功；聚合出的 `Quota.Exceeded` 也可能只来自一个模型的 429。网关不据此判整个账号不可用；冷却到期即恢复，不需要一次成功请求来解锁（#89：一次 502 曾因此让全部模型一直不可用）。
- 瞬时失败（超时、5xx、无状态码）由 CPA 冷却约 1 分钟（上游给了 Retry-After 时按它），之后的失败只延长仍在进行的冷却，不会叠加。

`GET /api/llm/v1/models` 返回模型目录和每个模型的 `status`：`available`、`degraded`（瞬时故障，冷却中，请求仍放行，附 `retry_at`）、`unavailable`（明确错误：未绑定、停用、登录失效、无权（402/403）、模型不存在（404）、额度用尽；附 `reason`）。同一模型由多个账号提供时取最好的那个。`available` 即 `status != unavailable`。见过的模型持久化在 `models.json`，账号失效或被移除后模型仍在目录中，智能体保留原来的选择，重新绑定后自动恢复。图像、视频等非对话模型和 `codex-auto-review` 被过滤。

`POST /api/llm/v1/refresh` 立即重新检查：对每个启用的账号读一次用量（`GET /usage` 也是同一操作）——带账号令牌的上游请求，不消耗额度，也不重放任何会话或消息。上游拒绝令牌（401）时先用 CPA 的 `ForceRefreshAuth` 刷新一次再读，仍被拒绝才判 `needs_login`；网络或上游故障只在账号上记 `check_error`，不改变可用性。并发调用共享同一轮检查；检查结果按开始时间新者为准，CPA 在检查之后又有请求结果时以请求结果为准。返回 `{connections, models, usage}`。检查只能证明账号和上游可达，不能证明某个模型的推理已恢复，模型的瞬时故障仍由冷却到期解除。

### 服务直连

控制面自己的其他进程（routine worker）直接调用 internal listener 的 `/v1`（`AXP_LLM_GATEWAY_URL`，生产 `http://127.0.0.1:24001`），不带 key，自己在 `X-AXP-Agent-Id` 里写明用量记在谁名下：智能体和环境包的服务应经 runtime 网关，而 runtime 网关总会改写这个头。[定时任务](routines.md)的 worker 用 ADK 的 `openaimodel`（Chat Completions）调用 `/v1`，以 `routine-<id>` 记账；Codex 和 Grok 两类模型的多轮工具调用都经它验证过（[#57](https://github.com/AkaraChen/axp/issues/57)）。

### Embedding

CPA 没有 `/v1/embeddings`，网关自己实现（`gateway/embeddings.go`，[#273](https://github.com/0xfe-project/eta/issues/273)），挂在 internal listener 的 `POST /v1/embeddings`，比 CPA 的 `/v1/` 更具体所以优先。对外是 OpenAI 的格式：请求 `{"model", "input": string | string[], "dimensions"?, "encoding_format"?: "float"}`，响应 `{"object": "list", "data": [{"object": "embedding", "index", "embedding"}], "model", "usage": {"prompt_tokens", "total_tokens"}}`，`index` 与 `input` 顺序一致；只支持 `float`，`dimensions` 在 128 到 3072 之间，其他返回 400。错误是 OpenAI 的 `{"error": {"message", "type", "code"}}`。

上游是 Google AI Studio 的 API key（CPA 的 `gemini` 凭据，见 #272），走 Google 原生的 `models/<model>:batchEmbedContents`（每批最多 100 条，`dimensions` 映射为 `outputDimensionality`），不走 Google 的 OpenAI 兼容端点：文档没说那里的 `dimensions` 是否生效，而维度是记忆向量表的硬约束。模型只有 `gemini-embedding-001` 和 `gemini-embedding-2-preview`。网关按 CPA 的状态挑一个启用、未冷却的账号（健康的优先，再按创建时间），401/403 和 429 经 `MarkResult` 记到账号上并换下一个账号；都不行时没有账号返回 503 `no_account`，被限流返回 429，上游故障返回 502，请求本身的 400/404 原样返回 400。每次上游请求都记进用量（主体是 `X-AXP-Agent-Id`，账号、模型、token；Google 不返回 token 数时按每 4 字节一个估算）。

`GET /api/llm/v1/embedding-models` 列出这两个模型和状态，由 Google AI Studio 账号派生，规则与对话模型的目录相同；没有账号时 `unavailable`，原因 `NO_CONNECTION`。

### 用量

账号的订阅窗口（`GET /api/llm/v1/usage`）只说明一个账号用了多少，不说明是谁用的。网关另外按“谁”记账（#101）：每个 `/v1` 请求的主体就是上面的 `X-AXP-Agent-Id`——聊天智能体的 id（记忆抽取经 memory-service 调用时也带这个智能体的 id，所以算在它头上）或 `routine-<id>`。CLIProxyAPI 对每个上游请求都把一条用量记录交给注册的用量插件（`sdk/cliproxy/usage`，与它自己的 `usage-statistics-enabled` 开关无关，配置里仍然关着它）；网关的插件（`gateway/usage`）按小时累计（主体、账号、模型）的请求数、失败数和 token，存在状态目录的 `usage.json`，每分钟和退出时写一次，保留 30 天。

`GET /api/llm/v1/usage/agents` 返回每个主体近 5 小时、24 小时、7 天的合计，以及近 7 天按模型、按账号的分布。Web 在智能体的设置里和定时任务的详情里各显示一行。

## control-plane 与 runtime

- `Agent.model` 存目录中的模型 ID；创建、修改时校验存在性，修改模型与修改指令一样递增 `config_version`，空闲时重启 runtime。
- `POST /chat/messages` 在加锁前检查模型：未设置返回 409 `MODEL_NOT_SET`，`unavailable` 返回 409 `MODEL_UNAVAILABLE`；`degraded` 放行。API 进程直接读模块的目录；controller 经 `llm.Remote` 读，缓存 10 秒，读不到时沿用上次读到的目录，从未读到过才算不可用。
- controller 给 runtime 注入 runtime 网关的地址（`AXP_GATEWAY_URL`）和模型的上下文窗口；runtime 自己在后面加上 `/v1`。
- runtime 给 Codex 加上 `model_provider = "axp"` 及 `model_providers.axp.{base_url, wire_api = "responses", env_key = "AXP_RUNTIME_LLM_KEY"}`，并在需要时设置 `model_context_window`；Codex 进程的 `AXP_RUNTIME_LLM_KEY` 就是上面的实例 key。

## 前端

- 设置 → “模型服务”：按 Connector 列出账号、状态和错误，提供重新登录、停用/启用、移除；设备码弹窗显示验证码、授权链接和倒计时，每 2 秒轮询。账号需要处理时，设置按钮和菜单显示红点。“刷新状态”按钮（模型服务和连接里都有）调用 `POST /refresh`，显示检查中、结果和失败；失败时保留原来的状态。
- 设置 → “模型服务”的“记忆 embedding”：见[记忆](memory.md#embedding-模型)。
- 账号和模型目录每 30 秒刷新一次；发送收到 `MODEL_*` 错误时立即刷新。手动刷新开始和返回时都取消进行中的轮询，避免旧结果覆盖新结果。
- 智能体编辑器有模型下拉框（按服务分组，`unavailable` 的模型禁用，`degraded` 标注“暂时故障”），新建时默认选上次用过的模型。模型未设置或 `unavailable` 时，聊天输入框禁用并给出“选择模型”“前往模型服务”“更换模型”入口；`degraded` 只提示，不禁用；模型目录读取失败时不据旧数据禁用，交给服务端判断。
