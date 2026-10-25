# LLM 网关

LLM 网关让主 node 能用模型**订阅**（ChatGPT Codex、Grok）和 **Google AI Studio 的 API key** 直接生成，并看到账号状态和订阅额度。它和上游的 API key provider 是同一个模型层里的两种来源：provider 来自 `config.json`，网关的模型来自它连着的账号。

## 组成

```text
Bun 进程（host）                                    同一个进程里的 Go 运行时（c-shared）
  apps/eta/src/llm/                                   packages/llm-gateway/
    runtime.ts  startGateway ── bun:ffi ──────────▶     ffi/        LlmStart  LlmStop  LlmFree
    client.ts   GatewayClient ─ HTTP 127.0.0.1:N ─▶     module/     回环 listener：/v1  /api/llm
    models.ts   GatewayModels（llm 提供商）              gateway/    连接、登录、目录、额度
    plugin.ts   llm target（accounts models quota）      cpa/        嵌入 CLIProxyAPI v8
```

- **嵌入方式**：Go 代码（嵌入 CLIProxyAPI 的 `sdk/cliproxy`）编成 `-buildmode=c-shared`，host 用 `bun:ffi` 加载。FFI 只导出三个函数：`LlmStart(配置 JSON)` 绑定回环 listener 并返回端口，`LlmStop()` 关闭，`LlmFree` 释放 `LlmStart` 返回的字符串。三个调用都立即返回。
- **流量走回环 HTTP**：模型流量（`/v1`）和账号 API（`/api/llm/v1/*`）都是进程内 Go 监听的 `127.0.0.1` 随机端口上的 HTTP，用 host 每次启动随机生成的 key 做 bearer 鉴权，不经 FFI 回调。所以 Go 线程不会回调 JS；一次慢上游（登录、读额度要访问外部服务）也不会卡住 Bun 的事件循环。这是与 [#289](https://github.com/0xfe-project/eta/issues/289) 里“导出启动、停止、管理调用三个函数”的唯一出入：管理调用（`Call`）若走 FFI 就是同步阻塞主线程，所以改成同一个 listener 上的 HTTP，导出的第三个函数是 `LlmFree`。
- **一个进程一次**：CPA 有进程级状态（logrus、模型注册表、访问提供者），库拒绝第二次 `LlmStart`。
- **可以改成子进程**：`packages/llm-gateway/cmd/standalone` 是同一份 `module` 的独立可执行文件（`ETA_LLM_STATE_DIR`、`ETA_LLM_ACCESS_KEY`、`ETA_LLM_ADDR`），因为 host 只通过回环 HTTP 访问网关，换成子进程只需要改 `runtime.ts` 里启动的方式。
- **没有 Go 的机器**：库没构建时 host 照常启动并提示一行，没有 `llm` 插件，网页里没有“订阅与密钥”一节，其余不变。有 Go 的机器上 `bun run setup` 会构建库；CI 和 `turbo run test` 把它当依赖（`test` 依赖 `build`）。

### 与 CPA 的边界

只使用 SDK 导出的包（`sdk/cliproxy`、`sdk/cliproxy/auth`、`sdk/access`、`sdk/api`、`sdk/config`、`sdk/translator/builtin`）和 CPA 的管理 HTTP API，不导入 `internal/`。当前版本 **v8.0.33**（模块路径 `github.com/router-for-me/CLIProxyAPI/v8`；CPA 仓库的 `docs/sdk-usage.md` 写的仍是 `/v6`，实现以 v8 的代码为准）。

- **监听**：SDK 的 `Service.Run` 一定会自己 `net.Listen`，无法关闭，所以让它监听 `127.0.0.1:0`（没有任何路由指向它）。CPA 的 gin 引擎由 `RouterConfigurator` 交出来，作为 `http.Handler` 挂到网关自己的 listener 的 `/v1/` 下；客户端断开即取消请求上下文（CPA 随之取消上游请求），流式响应逐段写到 `ResponseWriter`。`OnAfterStart` 之后（凭据已加载、路由已注册）才算就绪：之前 `/v1` 返回 503，`GET /api/llm/ready` 返回 503。
- **鉴权**：唯一的访问提供者 `eta-host`（`gateway/cpa/keys.go`）认两种 bearer：host 的 key，和由它派生的**智能体 key** `etak.<智能体 id>.<HMAC-SHA256(host key, id)>`（常量时间比较，id 只允许字母数字下划线连字符，没有或错误一律 401）。智能体 key 只开 `/v1`；账号 API 和吊销（`DELETE /api/llm/v1/keys/<id>`）只认 host 的 key。key 是派生的所以不存表，吊销记在内存里（host 重启网关即换 host key，旧 key 全部失效）。环境包经它用订阅账号，见[环境包](bundles.md#llm-网关的-key)；主 node 在自己端口上的 `/llm/v1/*` 把 daemon 的请求转给 `/v1`，只放行智能体 key。
- **管理 API**：`config.yaml` 在每次启动时生成，管理密钥是每次随机的 `secret-key`，`allow-remote: false`；`cpa.Proxy.Management()` 在进程内直接调用 gin 引擎，不经过网络。
- **日志**：CPA 用 logrus；网关把它的输出丢弃，用 hook 把每条记录（级别、字段）交给 `slog`（`library=cliproxy`，写到 stderr）。
- **信号**：CPA v8.0.33 的 SDK 依赖树（565 个包）里没有 `os/signal`；只有 CLI 入口注册了 SIGINT/SIGTERM，不在依赖树里。`pluginhost` 只有显式 `WithPluginHost` 才启用，我们不用。Go 运行时以 c-shared 加载时只为 SIGSEGV、SIGBUS、SIGFPE、SIGPIPE、SIGURG 装处理器，其余转交宿主。`test/ffi.test.ts` 把这点和下面两项做成了测试。
- **已知代价**：CPA 里一次未恢复的 panic 会带下整个 host。

## 账号与目录

接入方式（Connector）只负责“凭据怎么进来”；账号的列表、启停、删除统一走 `coreauth.Manager` 和管理 API，模型统一来自 CPA 的模型注册表。

- **Codex**：OpenAI 的设备码流程（`/api/accounts/deviceauth/usercode` → 轮询 `/deviceauth/token` → `/oauth/token`），不依赖 localhost 回调。CPA 只在 CLI 里实现了这一流程，所以协议在 Connector 里实现，得到的 token 按 CPA 的 codex 凭据文件格式经 `POST /v0/management/auth-files` 交给 CPA。
- **Grok（xAI）**：调用管理 API 的 `xai-auth-url` / `get-auth-status` / `oauth-session`，CPA 自己保存凭据。
- **Google AI Studio**：填 API key。提交时先用 `GET /v1beta/models` 向 Google 校验，重复的 key 报错；key 存在状态目录的 `providers.json`（0600，唯一真源），每次启动渲染进 CPA 的 `gemini-api-key`，运行时的增删和停用先写文件再经管理 API 热生效。无效的 key 判 `needs_login`（原因码 `invalid_api_key`）。

上游 eta 自带的 Codex 登录（`providers` 插件，pi-ai 的 OAuth）仍然在，两者互不依赖：那条是上游 provider `openai-codex`，这条是经 CPA 的订阅账号，模型 id 以 `llm:` 开头。

### 状态

状态以 CPA 实际怎么路由为准（`selector.isAuthBlockedForModel`），读时派生，网关不另存状态、不跑定时任务：`active`、`disabled`、`needs_login`、`rate_limited`、`error`、`degraded`，附原因码（见下）和恢复时间，不含 token。

- CPA 把请求失败记在模型上，之后只有该模型被冷却，其他模型照常路由到这个账号。所以只有关于凭据本身的失败才影响整个账号：任一模型收到 401（`needs_login`）、凭据级额度、尚未有模型状态时的账号级失败（429 → `rate_limited`，402/403 → `error`，其余 → `degraded`）。
- 瞬时失败（超时、5xx）由 CPA 冷却约 1 分钟，期间同一账号同一模型的下一次请求也会被拒；冷却到期即恢复。
- 模型的状态是 `available`、`degraded`（冷却中，请求仍放行）、`unavailable`（未绑定、停用、登录失效、无权、不存在、额度用尽，附原因）。同一模型由多个账号提供时取最好的那个。见过的模型持久化在 `models.json`，账号失效或被移除后模型仍在目录里，智能体保留原来的选择，重新绑定后自动恢复。图像、视频等非对话模型被过滤。
- 目录里的每个模型还带 CPA 声明的思考档（`reasoning_levels`）和是否读图，host 据此生成模型配置。

### 额度

订阅的额度窗口（Codex 的 5 小时与每周，Grok 的周期额度）由 `connectors/usage.go` 向提供商读：Codex 读 `chatgpt.com/backend-api/wham/usage`，Grok 读 `cli-chat-proxy.grok.com/v1/billing`，带账号令牌，不消耗额度。一次读同时是账号的健康检查：上游拒绝令牌（401）时先用 CPA 的 `ForceRefreshAuth` 刷新一次，仍被拒绝才判 `needs_login`；网络或上游故障只在账号上记 `check_error`，不改变可用性。`POST /api/llm/v1/refresh` 并发调用共享同一轮检查。API key 没有订阅窗口，返回空的窗口列表。

## 与 host 的接缝

- **`llm` 提供商**：`GatewayModels` 把网关的 `/v1` 登记成模型层里的一个 provider，id `llm`，模型 id 为 `llm:<CPA 模型 id>`（`kind: openai-compatible`，Chat Completions；CPA 负责协议转换）。目录变化时重建这个 provider；其余 provider 的模型仍由配置建成的模型层回答。接缝是 `assembleServer` 的 `overlayModels` 选项。配置里不要再用 `llm` 作 provider id（网关的优先）。
- **daemon 不变**：daemon 要生成时仍把请求交给主 node，主 node 的模型层（含 `llm`）解析并调用网关，**订阅凭据只在主 node**，见[机器与 daemon](machines.md)。
- **`llm` target**（`apps/eta/src/llm`，eager）：

| section    | 内容                                                                 |
| ---------- | -------------------------------------------------------------------- |
| `accounts` | `ready`、连接方式（`connectors`）、账号（`connections`）及状态       |
| `models`   | 目录与每个模型当前的可用性和原因                                     |
| `quota`    | 每个账号的订阅窗口（`kind`：`5h`/`weekly`/`monthly`，`used` 百分比） |

action：`refresh`（检查所有账号并读额度）、`loginStart`、`loginPoll`、`loginSubmit`（API key）、`loginCancel`、`setEnabled`、`remove`。账号与模型每 5 秒读一次（读的是同进程内存），有变化才推送；额度在启动时、登录成功后、`refresh` 和每 10 分钟读一次。失败和不可用的原因都是**码加参数**，不是句子：`packages/llm-gateway/gateway/codes.go` 是封闭的码表（`codes.json` 是同一份给 TypeScript 用，`LLM_CODES` 在 `packages/client-contracts/src/llm.ts`，两边各有测试保证一致）。网关返回 `{code, message, params}`，`message` 是只给日志看的英文诊断，`params` 是 `provider`（显示名）和 `status`（HTTP 状态）。host 的 `llm` 插件原样透传（失败的回复帧带 `problem: {code, params}`），不翻译；网页在 `llm:problems.*` 里把每个码翻成中英文，遇到不认识的码就显示码和诊断。连接方式的登录说明（原先的 `hint`）也不再由网关给出，网页按连接方式 id 取文案。

- **用量**：每次调用的 token 数沿用 `usage` 表：会话的 `turn:end` 里带着 `provider: "llm"`、模型和 token，按智能体记账；旧网关另外的“按主体账本”（`usage.json`）不再保留。订阅的额度窗口属于上面的 `quota` section。
- **界面**：设置 → 模型服务里，“订阅与密钥”一节按连接方式分组列出账号（状态、套餐、额度条，重新登录、停用/启用、移除），Codex 和 Grok 用设备码弹窗（验证码、授权链接、倒计时、每 1.5 秒轮询），Google AI Studio 用填 key 的弹窗；“刷新状态”按钮调用 `refresh`。需要处理的账号会让设置按钮显示红点。网关的模型进入各处的模型选择器，按连接方式分组，不可用的置灰并给出原因。host 没有网关时整节隐藏。

## 状态目录

`<数据目录>/llm/`：`auths/`（CPA 的凭据文件）、`models.json`（见过的模型）、`providers.json`（Google AI Studio 的 key，0600）、`config.yaml`（每次启动生成，勿手改）。

## 构建与测试

```sh
bun run --cwd packages/llm-gateway build      # go build -buildmode=c-shared → lib/libllm-gateway.{so,dylib,dll}
bun run --cwd packages/llm-gateway test       # go test ./... + vitest
```

需要 Go（`go.mod` 要求的版本，`GOTOOLCHAIN=auto` 会自动取）。首次构建要下载并编译 CPA，约两分钟。`ETA_LLM_LIB` 可以指向别处的库。Docker 镜像有单独的 Go 构建阶段。

测试分三层：

- **Go 契约测试**（`module/contract_test.go`，对假上游，CPA 升级时必须通过）：凭据上传后进入目录、模型进入注册表和 `/v1/models`；账号 API 与 `/v1` 只认 host 的 key；停用和删除（含凭据文件）生效；非流式 chat completions、流式 responses 逐段到达；客户端断开取消上游请求；上游 500/429 只影响该次请求；Google AI Studio 的 key 的校验、持久化、停用、失效、移除。`gateway/` 与 `connectors/` 的单元测试覆盖状态派生、登录、额度。
- **FFI 测试**（`packages/llm-gateway/test/ffi.test.ts`，每项在独立的 Bun 进程里，对真实的库和 CPA）：压力下的流式（并发流式请求加不停的分配与强制 GC，没有被截断的流）；中途断开（数百个客户端读到一段就挂断，上游全部被取消，之后请求照常完成）；加载后 Bun 的 SIGTERM、SIGINT 处理器照常触发。
- **host 测试**（`apps/eta/test/llm.test.ts`，真实的库，假上游）：`llm` target 与模型上线，经 `host.server.models` 流式生成并拿到 token，用量记录得到提供商 `llm`，中途停止取消上游，上游 500/429 只让那次生成失败。
