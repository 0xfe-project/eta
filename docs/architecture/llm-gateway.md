# LLM 网关

LLM 网关让主 node 能用模型**订阅**（ChatGPT Codex、Grok）和 **Google AI Studio 的 API key** 直接生成，并看到账号状态和订阅额度。它和上游的 API key provider 是同一个模型层里的两种来源：provider 来自 `config.json`，网关的模型来自它连着的账号。

## 组成

```text
Bun 进程（host）  apps/eta/src/llm/                         子进程
  runtime.ts   启动、/llm/v1 转发、智能体 key ─ HTTP 127.0.0.1:N /v1 ─────────▶  CLIProxyAPI v8.0.43
  cpa.ts       经 @cpajs/cpa 启动并看管 CPA ─── HTTP 127.0.0.1:N /v8/management ▶  （@cpajs/<平台> 的二进制）
  gateway.ts   账号、目录、额度、登录
  state.ts     由 CPA 的冷却视图推导状态
  codex.ts xai.ts gemini.ts   接入方式
  models.ts    GatewayModels（llm 提供商）
  plugin.ts    llm target（accounts models quota）
```

- **子进程**：CPA 是官方二进制，由 [`@cpajs/cpa`](https://github.com/akarachen/cpajs)（`0.1.0-rc.7`，内置 CLIProxyAPI **v8.0.43**）以 `optionalDependencies` 按平台安装，`bun install` 即可，不需要 Go。`startServer` 写配置、选空闲端口、等 `/healthz`；CPA 经 cpajs 的 launcher 启动，Linux 上 `PR_SET_PDEATHSIG`，其他 POSIX 上由 launcher 看管，**host 被 SIGKILL 或崩溃时 CPA 也退出**。
- **自愈**：CPA 自己退出（崩溃、被杀）时，`cpa.ts` 等一会儿后用 `startServer` 再启一个（cpajs 只管启动和停止，不自动重启）。新进程在任意空闲端口上：`cpa.client` 和 `cpa.baseUrl` 换成新进程的，`runtime.ts` 收到 `onRestarted` 后把 `llm` 提供商重新登记到新地址（不去抢原端口：不管端口变没变都重新登记，比“先试原端口”简单）。等待从 0.25 s 起，进程一分钟内又死就翻倍（到 30 s），活过一分钟就回到最短；没有次数上限，不会放弃。退出时把 CPA 最后 20 行输出写进警告。首次启动失败不重试：host 照常启动、没有网关并提示一行。
- **起不来**：CPA 启动失败时 host 照常启动并提示一行，没有 `llm` 插件，网页里没有“订阅与密钥”一节，其余不变。`--no-llm` 则不启动。

### 与 CPA 的边界

只用 CPA 的 HTTP 接口：`/v1`（模型流量）和 v8 管理 API（`/v8/management`，经 cpajs 的类型化客户端），不依赖它的内部包或 SDK。

- **配置**：`<状态目录>/config.yaml` 在每次启动前由 `config` 函数重写：host 的设置（回环、`/v1` 的 key、关闭控制面板与请求日志、`request-retry: 1`）加上一次运行留在配置里的 `api-keys`（运行时经管理 API 改动的就是这一段），测试再合并 `cpaExtra`。所以 API key 的唯一真源是 CPA 的配置。改 key 时（`connectors.ts` 的 `updateKeys`）读 `api-keys/<provider>` 节点和它的 ETag，去掉读时注入的 `auth_index`，带 `If-Match` 写回，412 时重读重改（最多 3 次）；不加进程内锁，并发靠 ETag。CPA 写配置不是原子的，读恰好落在重写中间会得到 500 `invalid_config`：这里不重试，每 5 秒的同步下一轮就好，用户操作则报一次 `gateway_unavailable`。
- **鉴权**：CPA 的 `/v1` 只认一个每次启动随机生成、不出 host 进程的 key；host 自己的模型层直接用它调 CPA。智能体 key `etak.<智能体 id>.<HMAC-SHA256(host key, id)>` 在 host 里校验（`keys.ts`，常量时间比较，id 只允许字母数字下划线连字符），通过后换成 CPA 的 key 转发。会话（本机的和 daemon 上的）一律经 host 端口上的 `/llm/v1/*`，只放行智能体 key 和 `/v1`。key 是派生的所以不存表，吊销记在内存里，host 重启即全部失效。环境包经它用订阅账号，见[环境包](bundles.md#llm-网关的-key)。
- **管理 API**：管理密钥由 cpajs 每次启动随机生成，只有 bcrypt 哈希（cost 4）进配置，明文留在 `server.client()` 里，host 不经手；远程管理关闭。CPA 每个管理请求都校验一次哈希，cost 4 下约 1 ms（cost 10 时约 65 ms CPU，而网关每几秒就要读几次）。
- **日志**：CPA 每个请求都打 info 日志；转给 host stderr（前缀 `[cpa]`）的只有 warn 及以上（按 cpajs 解析出的 `LogLine.level` 过滤），和 stderr 上不带级别的行（例如 panic），stdout 上不带级别的启动横幅不转。完整的近期输出在 cpajs 的 `recentLogs` 里，CPA 意外退出时会附在警告里。

## 账号与目录

接入方式（Connector）只负责“凭据怎么进来”；账号的列表、启停、删除统一在 `gateway.ts`：列表是 `GET /credentials`（凭据文件）加 `GET /config/api-keys`（配置里的 key，带 `auth_index`；key 或组的 `excluded-models` 含 `*` 即停用）。凭据文件按文件名走 `PATCH /credentials/status`、`DELETE /credentials`，配置里的 key 由 eta 改 `api-keys.<provider>`（停用即加上 `excluded-models: ["*"]`，与 CPA 自己的做法相同；删除即从组里去掉，组空了一并去掉）。账号的 id 是 CPA 的 `auth_index`（由凭据派生，重启不变）。

- **Codex**：OpenAI 的设备码流程（`/api/accounts/deviceauth/usercode` → 轮询 `/deviceauth/token` → `/oauth/token`），不依赖 localhost 回调。CPA 的管理 API 里 Codex 只有 localhost 回调的流程，所以设备码协议在 `codex.ts` 里实现，得到的 token 按 CPA 的 codex 凭据文件格式经 `POST /credentials` 交给 CPA。
- **Grok（xAI）**：调用管理 API 的 `oauth/auth-url`（`provider: xai`，设备码）/ `oauth/status` / `oauth/session`，CPA 自己保存凭据。
- **Google AI Studio**：填 API key。提交时先用 `GET /v1beta/models` 向 Google 校验，重复的 key 报错；key 写进 CPA 配置的 `api-keys.gemini`，热生效。无效的 key 判 `needs_login`（原因码 `invalid_api_key`）。Go 网关留下的 `providers.json` 在第一次启动时并入配置（停用的保持停用），然后删除。

上游 eta 自带的 Codex 登录（`providers` 插件，pi-ai 的 OAuth）仍然在，两者互不依赖：那条是上游 provider `openai-codex`，这条是经 CPA 的订阅账号，模型 id 以 `llm:` 开头。

### 状态

状态以 CPA 实际怎么路由为准，读时派生（`state.ts`），网关不另存状态、不跑定时任务：`active`、`disabled`、`needs_login`、`rate_limited`、`error`、`degraded`，附原因码（见下）和恢复时间，不含 token。

- 凭据文件的状态来自 `GET /credentials`：`status`、`status_message` 和**冷却视图**（`cooldowns`：作用于整个凭据或某个模型，带原因 `credential_quota`/`quota`/`unauthorized`/`invalid_grant`/`payment_required`/`not_found`/`transient_error`… 和恢复时间，由 CPA 的 `CooldownSnapshotForAuth` 按它自己的路由规则算出）。
- CPA 把请求失败记在模型上，之后只有该模型被冷却，其他模型照常路由到这个账号。所以只有关于凭据本身的失败才影响整个账号：任一冷却的原因是 `unauthorized`/`invalid_grant`，或 `status: error` 且消息像登录失效（`needs_login`）；凭据级冷却（`credential_quota` → `rate_limited`/`quota_exhausted`，`quota` → `rate_limited`，`payment_required` → `error`，其余 → `degraded`）。
- **API key 没有运行时状态**：CPA 的 v8 管理 API 不列出配置里的 key（`/credentials` 只列凭据文件），也就看不到它们的冷却。key 的状态只有停用与否，以及网关自己的检查（见“额度”）：Google 拒绝 key 时判 `needs_login`。一个 key 的 429 或模型冷却不会显示在界面上，CPA 照样按冷却路由。
- 瞬时失败（超时、5xx）由 CPA 冷却约 1 分钟，期间同一账号同一模型的下一次请求也会被拒；冷却到期即恢复。
- 模型的状态是 `available`、`degraded`（冷却中，请求仍放行）、`unavailable`（未绑定、停用、登录失效、无权、不存在、额度用尽，附原因）。同一模型由多个账号提供时取最好的那个。见过的模型持久化在 `models.json`，账号失效或被移除后模型仍在目录里，智能体保留原来的选择，重新绑定后自动恢复。图像、视频等非对话模型被过滤。
- 目录：凭据文件服务哪些模型来自 `GET /credentials/models`；配置里的 key 服务它配置的模型（按 alias，key 自己的优先于组的），没有配置就是该 channel 的全部模型。`excluded-models` 只认 `*`（停用）：停用的 key 由账号状态让它的模型不可用，其他排除规则 eta 不写，也就不读。每个模型的上下文长度、思考档（`reasoning_levels`）和是否读图来自 `GET /routing/model-definitions/<channel>`（CPA 内置的静态定义，随二进制固定，每个 channel 读一次缓存到进程结束，失败下次再读），配置里给的值优先；connector 的 provider 就是它的 channel。Codex 的 channel 定义是 Pro 套餐那张表；其他套餐的模型是它的子集，按 id 取详情。

### 额度

订阅的额度窗口（Codex 的 5 小时与每周，Grok 的周期额度）向提供商读：Codex 读 `chatgpt.com/backend-api/wham/usage`，Grok 读 `cli-chat-proxy.grok.com/v1/billing`，经管理 API 的 `POST /requests/api-call`（`auth_index` 加 `Authorization: Bearer $TOKEN$`，令牌由 CPA 填入，**不出 CPA**），不消耗额度。一次读同时是账号的健康检查：上游拒绝令牌（401）时先用 `POST /credentials/refresh` 刷新一次，仍被拒绝才判 `needs_login`；网络或上游故障只在账号上记 `check_error`，不改变可用性。`refresh` 并发调用共享同一轮检查。API key 没有订阅窗口，返回空的窗口列表（Google AI Studio 的检查是列一次模型）。

## 与 host 的接缝

- **`llm` 提供商**：`GatewayModels` 把网关的 `/v1` 登记成模型层里的一个 provider，id `llm`，模型 id 为 `llm:<CPA 模型 id>`（`kind: openai-compatible`，Chat Completions；CPA 负责协议转换）。目录变化时重建这个 provider；其余 provider 的模型仍由配置建成的模型层回答。接缝是 `assembleServer` 的 `overlayModels` 选项。配置里不要再用 `llm` 作 provider id（网关的优先）。
- **daemon 不变**：daemon 要生成时仍把请求交给主 node，主 node 的模型层（含 `llm`）解析并调用网关，**订阅凭据只在主 node**，见[机器与 daemon](machines.md)。
- **`llm` target**（`apps/eta/src/llm`，eager）：

| section    | 内容                                                                 |
| ---------- | -------------------------------------------------------------------- |
| `accounts` | `ready`、连接方式（`connectors`）、账号（`connections`）及状态       |
| `models`   | 目录与每个模型当前的可用性和原因                                     |
| `quota`    | 每个账号的订阅窗口（`kind`：`5h`/`weekly`/`monthly`，`used` 百分比） |

action：`refresh`（检查所有账号并读额度）、`loginStart`、`loginPoll`、`loginSubmit`（API key）、`loginCancel`、`setEnabled`、`remove`。账号与模型每 5 秒读一次（几个回环管理请求），有变化才推送；额度在启动时、登录成功后、`refresh` 和每 10 分钟读一次。失败和不可用的原因都是**码加参数**，不是句子：`LLM_CODES`（`packages/client-contracts/src/llm.ts`）是封闭的码表，每个码的含义和参数写在 `apps/eta/src/llm/problems.ts`。网关给出 `{code, message, params}`，`message` 是只给日志看的英文诊断，`params` 是 `provider`（显示名）和 `status`（HTTP 状态）。`llm` 插件原样透传（失败的回复帧带 `problem: {code, params}`；网关没解释的失败报 `gateway_unavailable`），不翻译；网页在 `llm:problems.*` 里把每个码翻成中英文，遇到不认识的码就显示码和诊断。连接方式的登录说明（原先的 `hint`）也不再由网关给出，网页按连接方式 id 取文案。

- **用量**：每次调用的 token 数沿用 `usage` 表：会话的 `turn:end` 里带着 `provider: "llm"`、模型和 token，按智能体记账；旧网关另外的“按主体账本”（`usage.json`）不再保留。订阅的额度窗口属于上面的 `quota` section。
- **界面**：设置 → 模型服务里，“订阅与密钥”一节按连接方式分组列出账号（状态、套餐、额度条，重新登录、停用/启用、移除），Codex 和 Grok 用设备码弹窗（验证码、授权链接、倒计时、每 1.5 秒轮询），Google AI Studio 用填 key 的弹窗；“刷新状态”按钮调用 `refresh`。需要处理的账号会让设置按钮显示红点。网关的模型进入各处的模型选择器，按连接方式分组，不可用的置灰并给出原因。host 没有网关时整节隐藏。

## 状态目录

`<数据目录>/llm/`：`auths/`（CPA 的凭据文件，格式与 Go 网关时相同，直接沿用）、`models.json`（见过的模型，格式沿用）、`config.yaml`（每次启动重写，其中 `api-keys` 是 API key 的唯一真源，勿手改）。

## 构建与测试

不需要构建：`bun install` 装上 `@cpajs/cpa` 和当前平台的 CPA 二进制。升级 CPA 即升级 `apps/eta/package.json` 里 `@cpajs/cpa` 的版本（它固定内置一个 CPA 版本），升级后跑下面的测试。

- **状态推导**（`apps/eta/test/llm-state.test.ts`，纯函数）：冷却视图到账号状态与模型状态的映射、智能体 key 的派生校验吊销、Codex 凭据文件格式与套餐名。
- **网关对真实 CPA**（`apps/eta/test/llm-gateway.test.ts`，假的 Google 与 OpenAI 登录）：Google AI Studio key 的校验（空、无效、重复）、写入配置后出现账号与模型、检查、停用与启用、重启后仍在、移除后模型保留为不可用；Go 网关的 `providers.json` 迁入配置；Codex 设备码登录成为 CPA 的凭据文件、模型上线、停用与删除；CPA 被 SIGKILL 后重新启动并通知，`/v1` 的 key 和管理客户端在新进程上可用。
- **host 测试**（`apps/eta/test/llm.test.ts`、`bundles-gateway.test.ts`，真实 CPA，假上游）：`llm` target 与模型上线，经 `host.server.models` 流式生成并拿到 token，用量记录得到提供商 `llm`，中途停止取消上游，上游 500/429 只让那次生成失败；环境包在本机和 daemon 上拿到网关地址和智能体 key，`/llm` 只为智能体 key 转发 `/v1`，智能体删除后 key 失效。
