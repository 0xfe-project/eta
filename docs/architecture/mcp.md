# MCP

智能体的 MCP 服务器来自它启用的[插件](plugins.md)的 `mcp.json`，没有别的来源。外部运行时的会话把 server 交给运行时自己启动；自带内核的会话走这里说的路径。

客户端在 `packages/eta-mcp`（`@eta/mcp`），不依赖 harness：`McpServers` 是一个会话的全部 server。接进 realm 的部分在 `apps/daemon/src/plugin-mcp.ts`，主 node 和 daemon 共用，所以 server 总是跑在会话所在的机器上。

## 只进 realm

MCP 工具不进模型的工具列表，脚本这样调用：

```js
import eta from "eta";
await eta.platform.mcp.hello_plugin_hello.say_hello({ name: "Ada" });
```

- server 名是 `<插件>-<server>` 里非单词字符换成 `_`，重名时加序号。工具名不是合法标识符时用方括号：`eta.platform.mcp.oma_context7["resolve-library-id"](input)`。
- 工具解析成它的 `structuredContent`，没有就是文本。图片等二进制写到会话目录的 `mcp-output/`，文本里带路径。
- 工具报错、server 崩溃、启动失败都让调用 reject，错误带 `failure` 和 server 的 stderr 结尾。会话和其他 server 不受影响。
- 工具名在 server 启动前不一定知道，所以 `eta.platform.mcp.<server>` 是按属性读取解析的对象（`Realm.lazy`），调用不需要先列工具。

每次调用都是 `realm.binding`，所以进 effect ledger，出现在 `esmrun` 的结果和工具卡片里。authorize 的调用点也在这里：host 给 `Hooks.authorize` 后，它会收到 `eta.platform.mcp.<server>.<tool>` 这个名字和输入。现在没有接，不做审批。

## `esmrun` 描述

server 的类型写进 `esmrun` 描述里的 d.ts，总量不超过 6000 字符（`DTS_CHARS`）。每个 server 有三档详细程度：工具数量、工具名（最多 40 个）、完整签名。所有 server 从最低一档开始，占用小的先升档，所以一个有几百个工具的 server 不会挤掉小 server 的签名。server 多到放不下时只写还剩几个，脚本用 `Object.keys(eta.platform.mcp)` 列全。

详情按需读取：`eta.platform.mcp.<server>.$tools({ tool? })`。

server 懒启动，第一次开会话时还不知道工具，d.ts 只写 server 名，`$tools()` 才会启动它。读到的列表缓存在 `<dataDir>/plugin-runtime/mcp-tools/`，键是插件内容哈希加 server 名，不含配置值，所以之后的会话不用启动就有签名。缓存只是提示，连接时用实时列表覆盖。列表第一次读到时 `esmrun` 描述会变一次，这一轮的 prompt 缓存失效。

## 生命周期

server 在第一次用到时启动，随会话关闭。

- 进程退出后，下一次调用重新启动。不自动重试失败的调用，工具不一定幂等。
- 启动失败后 5 秒内不再尝试，同样的错误直接返回，脚本循环调用不会一次起一个进程。
- 启动上限 90 秒（`npx` 可能在下载），调用上限 5 分钟，收到进度通知时重新计时。
- 脚本的工具调用被取消时，进行中的 MCP 请求一起取消。
- 关闭会话时：stdio 依次关 stdin、SIGTERM、SIGKILL；远程 server 发 `DELETE` 结束会话。

stdio server 只继承 `HOME`、`PATH` 等 SDK 默认的几个环境变量，加上配置注入的值，拿不到 host 进程自己的环境。

## secret

server 说的一切（结果、错误、stderr、工具列表）在离开 `McpServers` 之前都过一遍 `clean`，把这个会话不能看到的 secret 换掉，再交给脚本。这比 `redactionMiddleware` 更早：工具结果的中间件只管 `esmrun` 的返回值，而脚本能把值写进 `eta.state` 或文件。缓存到磁盘的工具列表也是清过的。

和其他脱敏一样，这只防意外，见[插件的安全边界](plugins.md#安全边界)。

## OAuth

不支持。需要登录的远程 server 这样处理：

- 主 node 在读插件时向没有配置凭据的远程 server 发一次 `initialize`（不带任何配置值）。回 401 的，设置页和智能体编辑器的 server 列表显示不支持。
- 脚本调用时也会得到 `needs_oauth` 的错误。配了 header 还回 401 的是 `start_failed`，说明凭据被拒绝。
- 探测在主 node 上跑。只有 daemon 能访问的 server，主 node 探测不到，只有脚本调用时才知道。

`sse` 传输不支持，和外部运行时一样跳过。
