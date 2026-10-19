# MCP

智能体经 MCP 使用外部工具。库在 `packages/eta-mcp`（`@eta/mcp`，架构取自 pi-mcp-adapter，不依赖任何 harness）；`apps/daemon/src/mcp-host.ts` 的 `McpHost` 把它接到会话上，主 node 和每个 daemon 各用一个，所以 MCP 进程总起在会话所在的那台机器上。

## 会话拿到什么

- **一个 `mcp` 代理工具**（约 200 token）：状态、列出某服务器的工具、搜索、描述、`instructions`、调用、连接。没有任何配置的服务器时，会话一个 MCP 工具都不带。
- **直接工具**：配置里写 `directTools`（`true` 或工具名列表）的服务器，其工具以 `mcp__<server>__<tool>` 直接出现在工具列表里。定义取自元数据缓存，不连服务器；还没缓存的服务器在会话打开后台预热一次（同一智能体的预热一个接一个），读完把直接工具补进正在运行的会话。
- 服务器**懒连接**（第一次调用才连，空闲 10 分钟断开），打开会话从不等它们。

## 配置来源

后面的盖住前面的同名服务器：

| 来源              | 位置                            | 说明                                         |
| ----------------- | ------------------------------- | -------------------------------------------- |
| `bundle:<名>`     | 智能体载入的环境包的 `mcp.json` | 可写 `directTools` 等，`${变量}` 由包展开    |
| `~/.eta/mcp.json` | 这台机器的用户目录              | 对这台机器上的所有智能体                     |
| `.mcp.json`       | 会话工作目录                    | 直接加载，不需要批准（它在用户自己的项目里） |

格式是常见的 `{ "mcpServers": { ... } }`，另有 `lifecycle`（`lazy` / `keep-alive` / `lazy-keep-alive`）、`directTools`、`approveTools`、`auth`（`oauth` / `bearer`）、`includeTools` / `excludeTools` 等，见库的 `McpServerEntry`。会话打开时读一次这些文件；改了之后新开的会话生效。

元数据缓存、`npx`/`bunx`/`uvx` 的解析结果和超长输出的落盘目录在各机器自己的状态目录的 `mcp/` 下（主 node 是数据目录，daemon 是它自己的）。

## 隔离与共享

连接按（智能体，服务器名）划分：同一智能体在这台机器上的所有会话共享连接，两个智能体永远不共享。一个智能体在这台机器上的最后一个会话关掉后，它的连接再留一分钟才关，宿主关闭时全部关掉。

## 接进会话的钩子

- **审批**：`approveTools`（`true`、工具名或通配、`"destructive"`）命中时，在会话的 ask 通道里问（选项 `allow` / `deny`），也就是收件箱里的一张卡片，不管会话在哪台机器上。
- **表单（elicitation）**：服务器中途要输入时，扁平表单按字段逐个提问：枚举是选项，布尔是 yes/no，文本和数字是自由输入（可选字段回答 `-` 跳过）。用户拒绝是 `decline`；嵌套、多选、URL 模式的表单取消，并在这次调用的结果里追加一句原因，让模型知道。
- **akhook**：经代理或直接工具发起的每次调用，都以 `mcp__<server>__<tool>` 和工具参数交给 akhook 的工具调用中间件，所以 `on: tool_call` 的规则（`tools: ["mcp__github__*"]`）、`ask` 规则和审批名单都能命中底层的 MCP 工具；被拦下的调用把规则的话返回给模型，服务器不会收到请求。

## OAuth

远端 HTTP 服务器写 `"auth": "oauth"`。

- **凭据**在主 node 的 `credential` 表（迁移 0033，`integration = 'mcp'`），每个值是 JSON，用数据目录里的 `secret.key`（同环境包的配置）做 AES-256-GCM 加密，随机 12 字节 IV，存 `iv | tag | 密文`；篡改或换了密钥读不出来，按没登录处理。存的是 `tokens`、`clientInformation`、`discoveryState` 和登录进行中的 `codeVerifier`。
- **服务器键**是服务器 URL（去掉 fragment）的 SHA-256：与智能体和配置来源无关，所以一次登录对所有智能体、所有机器都有效。
- 连接时用 connect 模式的 provider（从不自己注册客户端或跳转，缺登录就报“需要登录”），并发刷新同一个 refresh token 合并成一次请求。
- **登录**：`mcp.login` 返回 `{ pendingId, authorizationUrl }`，浏览器去授权；授权方把浏览器送回 `GET /mcp/oauth/callback?code&state`（免令牌门，见[访问控制](access.md)），宿主按 `state` 找到自己在等的登录并完成，回一页“可以关闭这个标签页”。宿主不在浏览器能回到的地址上（无头、远程）时，用户把授权方最后停在的地址粘贴进 `mcp.completeLogin`。登录完成后，等着这次登录的服务器立刻重连。
- **重定向地址**是 `<origin>/mcp/oauth/callback`。origin 取启动参数 `--public-url`（或环境变量 `ETA_PUBLIC_URL`），没有就用 web 客户端在 `login` 里报来的 `location.origin`：那一定是用户的浏览器打得开的地址，也是页面本来就信任的地址；两者都没有，登录报错并提示设置 `--public-url`。授权方注册的客户端记着重定向地址，换了地址下次登录会重新注册。
- **daemon 不存凭据。** 它的 provider 的存取经 `svc` 的 `mcp.credential` 问主 node：`get` / `set` / `delete`，只放行 `tokens`、`clientInformation`、`discoveryState`（不含登录的 `codeVerifier`），键必须是 64 位十六进制（URL 的哈希，所以 daemon 只能碰它知道 URL 的服务器）。daemon 刷新令牌后新的令牌就存在主 node，下一个会话（在哪台机器上）都读得到。登录只发生在主 node：daemon 上需要登录的服务器报“需要登录”，在设置里登录后重连。

## wire：`mcp` target

`list` 一个 section，每项（`McpServerView`）：`agentId`、`agentName`、`server`、`source`、`transport`（`stdio` | `http` | `sse`）、`lifecycle`、`state`（`connected` | `cached` | `not-connected` | `failed` | `needs-auth` | `disabled`）、`toolCount`、`error`、`auth`（`none` | `signed_in` | `needs_login`）。内容是每个智能体按“环境包 + 用户文件”能得到的服务器，加上正在运行的会话从项目 `.mcp.json` 读到的。目前只列主 node 上的配置；daemon 上项目独有的服务器不在列表里。

| 动作            | 说明                                                                            |
| --------------- | ------------------------------------------------------------------------------- |
| `connect`       | `{ agentId, server }`：现在连接，回 `{ ok, message }`                           |
| `reconnect`     | 同上，先断开并清掉失败记忆                                                      |
| `login`         | `{ agentId, server, redirectOrigin? }` → `{ pendingId, authorizationUrl }`      |
| `completeLogin` | `{ pendingId, callbackUrl }`：用重定向 URL 完成登录，`state` 不对时什么都不改变 |
| `logout`        | `{ agentId, server }`：忘掉这个 URL 的全部凭据（所有智能体都会失去登录）        |

## 界面

设置 → MCP 服务器：按智能体、再按来源分组，每个服务器一行：名字、传输和生命周期、状态、工具数、最近一次错误；OAuth 服务器有登录 / 退出登录。登录在新标签页打开授权方，同时弹出一个可以粘贴重定向 URL 的对话框；回调把服务器登录好后对话框自己关闭。

## 旧实现

`apps/daemon/src/mcp.ts`（每个会话各连各的、一次性读工具列表、表单一律取消、工具名 `server__tool`、引擎要等 `settled`）已删除。工具名变成了代理工具的 `tool` 参数或 `mcp__<server>__<tool>` 的直接工具；会话打开不再等服务器；连接在同一智能体的会话间共享，会话关掉不再杀进程。
