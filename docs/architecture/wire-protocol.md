# 线协议与 target

浏览器与 host 之间只有一条 WebSocket（`/ws`），说上游的管道协议（`packages/client-wire-proto`）。服务端是一根管子：进来的是调用，出去的是回复、状态和事件。服务端不认识任何功能名，能调什么由当时注册的内容决定，并在 `hello` 里公布。

## 帧

| 方向 | 帧                                             | 含义                                                                                               |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 进   | `call { target, action, args?, requestId? }`   | 调用 `target.action`；有 `requestId` 才有回复，没有则不回（便宜的 fire-and-forget）                |
| 进   | `subscribe { target, filter? }`                | 订阅某 target 的状态与事件；`filter` 只过滤事件名（子串），状态永远是整份                          |
| 进   | `unsubscribe { target }`                       | 取消订阅                                                                                           |
| 进   | `native`                                       | 桌面壳的回环，eta 不使用                                                                           |
| 出   | `hello { ops, mounted, state }`                | 连接后的第一帧（重连后再来一次）：所有可调用的 op 及其契约、已挂载的插件、所有 eager target 的状态 |
| 出   | `reply { requestId, ok, result \| error }`     | 结算一次调用                                                                                       |
| 出   | `state { target, version, snapshot \| patch }` | 某 target 的状态：整份，或只有 revision 变了的 section                                             |
| 出   | `event { target, name, data }`                 | 发生了什么（瞬时，不是状态）                                                                       |
| 出   | `error { message }`                            | 一帧完全读不懂                                                                                     |

规则：

- 同一连接的帧**严格按到达顺序**处理（先 `prompt` 后 `abort` 不会反过来）。
- 坏帧只回 `error`，不断开。
- 状态按 **section** 携带 **revision**；没变的 section 不发。产品 target 的 revision 是 section 内容的哈希（`wire.ts` 的 `publish`），写入方只需说"这个 target 动了"（`wire.pushNow`），线上会算出真正变了什么。
- 有**帧率预算**：推送只是"标记"，真正发出的是此刻最新的状态，大帧换来更长的静默，流式输出不会把一个标签页淹没；最后一个状态一定会送到。
- 每个 target 有一个**事件回放环**（512 条）：晚订阅者在快照之后补到最近的事件。重启后环是空的。
- 断线重连后新连接从零开始：浏览器重新订阅每个仍在使用的 target，host 回整份快照；等不到回复的调用以"未知结果"失败，不重放。

## target 与 action

名字是平的 `target.action`。`hello.ops` 给出每个 op 的 schema 与说明，类型在 `packages/client-contracts` 里，Web 与 host 共用。

上游地板提供（bundled 插件）：

| target                      | 内容                                                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sessions`、`sessions.<id>` | 会话列表；一个会话的视图（prompt 分段、工具、用量、goal、模型与思考档、待回答的问题）与 `prompt`、`abort`、`answer` 等 action |
| `providers`                 | 模型服务与凭据，含 Codex 的设备码登录与模型发现                                                                               |
| `settings`、`personas`      | 全局设置；persona 卡                                                                                                          |

产品插件（`apps/eta`，都是 cordis 插件，注入 `wire` 与 `sessions`）：

| 插件          | target                                | action                                                                                              |
| ------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| agents        | `agents`（eager）                     | `create` `update` `delete` `direct`                                                                 |
| machines      | `machines`（eager）                   | `enroll` `approve` `revoke` `rename`                                                                |
| projects      | `projects`（eager）                   | `create` `update` `setSteward` `files`（归档经 `update`）                                           |
| conversations | `conversations`、`conversations.<id>` | `create` `update` `invite` `remove` `setSteward` `send` `stop` `read` `history` `attach` `unattach` |
| inbox         | `inbox`                               | `answer` `setApprovals`                                                                             |
| usage         | `usage`                               | 只读                                                                                                |
| tasks         | `tasks`、`tasks.<id>`                 | `create` `update` `comment` `delete` `link` `confirmDraft`                                          |
| artifacts     | `artifacts`                           | `share` `unshare` `delete` `preview`                                                                |
| routines      | `routines`、`routines.<id>`           | `create` `update` `delete` `run` `seen` `feedback` `restoreBrief`                                   |
| memory        | `memory`（仅有边车时挂载）            | `list` `remember` `forget`                                                                          |

eager 的 target 随 `hello` 到达，页面不用先订阅就能画出来。

## 附件怎么上传

附件走同一条 WebSocket，不另开 HTTP 路由：`conversations.attach` 一次带一块（至多 384 KiB 文件内容的 base64），`index` 从 0 起严格递增，`last` 标记最后一块，回复在最后一块时带上附件。上传 id（`uploadId`，客户端生成的 uuid）就是附件的 id，所以丢了回复后重发同一块是同一次上传。选这个而不是 HTTP 上传：访问控制、重连与超时已经在这条连接上，界面也不必再认第二种认证；代价是文件上限 20 MB 要拆成最多 54 次调用，对人手粘贴的文件够用。`conversations.send` 的 `attachments` 列出已上传的附件 id（至多 10 个，文本可以为空），消息认领它们后不能再撤回（`unattach` 只撤回未发送的）。

## 界面如何用

`apps/web/src/lib/wire.ts` 是页面唯一的连接：处理 hello、reply、state、event 与断线重连（间隔递增）；`queries/wire.ts` 把它接成 React hooks（`useTarget`、调用用的 mutation）。`hello.mounted` 里没有的插件，对应入口隐藏（例如没配记忆边车就没有记忆页）。开发时 vite 把 `/ws` 代理给 host，生产页与 host 同源。

## 不在线上的 HTTP

`staticRoutes` 之外只有这些：`/up`（健康）、`/version`（构建 id，页面用它提示"有新版本"）、静态页（路径不是文件时回落到 `index.html`）、artifact 的 `/preview/…`、`/share/…`、`/artifacts/<id>/<version>/archive.zip`，以及 daemon 的两个入口 `/machines/enroll`、`/machines/connect`。没有 REST，没有 OpenAPI。
