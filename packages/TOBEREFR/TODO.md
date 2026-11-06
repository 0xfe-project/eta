# TOBEREFR：暂存的插件与被拆掉的接入点

这里的包等 ESM 重构（ESMMODE.md / ESMMODE-IMPL.md）稳定后再改写。它们不在 workspace 里
（`package.json` 只收 `apps/*`、`packages/*`），knip 也忽略这个目录，所以不参与构建、类型检查和测试。

为了让整仓编译，apps 里接这些包的地方已经删掉。被删的文件都可以从拆接入点之前的提交找回：

```sh
git show 2d4d160d:<path>        # 看原文件
git checkout 2d4d160d -- <path> # 取回原文件
```

## 暂存的包

| 包                  | 原来做什么                                                       | 改写方向（待定）                                                      |
| ------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| `eta-plugin-akhook` | 工具调用前后的规则（akhook.yml）、审批中间件、prompt_submit 钩子 | 审批并入 `binding()` 内的 authorize（#186、#285）；规则层看是否还需要 |
| `eta-plugin-git`    | git 工具插件                                                     | 未定                                                                  |
| `eta-plugin-ssh`    | SSH 执行环境插件                                                 | `ExecutionEnv` 已删除（#382），多半整包作废                           |

`packages/eta-mcp` 已经移回 workspace（#33）：MCP 不再是静态工具，而是 realm 模块，见下面「MCP 已接回的部分」。代理工具、直接工具和 output guard 已删除。

`packages/eta-ssh` 已经移回 workspace，只保留 transport（`LocalTransport`、SSH transport），task worktree 和远程机器仍要靠它跑 `sh`。`SshEnvironment`（`src/env.ts`）已删除。

## apps/daemon 被删的接入点

- `src/mcp-host.ts`、`src/mcp-auth.ts`、`test/mcp-host.test.ts`：整文件删除。daemon 不再启动 MCP 服务器，也不再向 primary 转发 OAuth 凭据。
- `src/node.ts`：
  - 删除了 `McpHost`、`AkhookSession`、`createLocalEnvironment`、`createRefreshDedupingFetch` 的引用。
  - `sessionTools` 只返回 `proxyTools`，不再拼 MCP 工具。
  - `toolMiddleware`、`sessionAttach`（akhook）和 `envFor` 被删掉。
  - 删掉的方法：`#akhook()`、`#needsApproval()`（`tool.gate` 的调用方）。
  - 删掉的选项：`DaemonNodeOptions.akhookUserConfig`、`DaemonNodeOptions.mcp`、`Opening.akhook`。
- `src/bundle.ts`：
  - 删掉了 `bundleMcpServers`、`bundleHookLayer`，以及 `SessionVars`、`expand`、`varsOf` 等变量展开逻辑。
  - `readBundle` 仍读 `mcp.json` 和 `akhook.yml`，只做形状检查（名字、mapping、command 或 url 必须有一个），读进来的值保留在 `Bundle.mcp` / `Bundle.hooks`，但没有人启动或应用它们。
  - 恢复时直接从 2d4d160d 取回这两个函数。
- `package.json`：去掉了 `@eta/mcp`、`@eta/plugin-akhook` 依赖。

## apps/eta 被删的接入点

- `src/mcp/`（`credentials.ts`、`path.ts`、`plugin.ts`、`service.ts`）、`src/akhook.ts`、`src/github/akhook.ts`：整文件删除。
- `src/product.ts`：
  - 删掉了 `McpService`、`mcpPlugin` 挂载、`mcp` wire target、`AkhookHost`、`AkhookOptions`、GitHub 的 akhook 规则层（`gh pr create` 改走 `open_pull_request` 的那条规则）。
  - `runHooks` 只剩 memory 一项。
  - 本机会话不再额外拿 MCP 工具，`sessionHooks` 等于 `later.hooks`。
- `src/host.ts`：删掉了 `HostOptions.mcp`、`HostOptions.akhook`。
- `src/access.ts`：去掉了 `MCP_CALLBACK_PATH`（`/mcp/oauth/callback`）这条免 token 路径。
- `src/machines/service.ts`：去掉了 `mcp.credential` 这个 link handler 和 `mcpCredential` 依赖。`tool.gate` handler 保留，但 daemon 侧已经没人调用。
- `src/machines/remote-place.ts`：远程会话 open 时不再带 `akhook` 层。
- `src/bundles/bundles.ts`：删掉了 `mcpSourcesFor`、`layersFor`，只剩 `skillDirsFor`。
- `package.json`：去掉了 `@eta/mcp`、`@eta/plugin-akhook` 依赖。

## MCP 已接回的部分（#33）

- realm：`import "mcp:<server>"` 的每个工具是一个 `binding()`（名字 `mcp.<server>.<tool>`，走 authorize、进 effect 账本）；`eta.mcp.servers/search/describe` 从元数据缓存发现。没有 sink 时一律报 `MCP not connected on this machine`。
- harness：`OpenSessionOptions.esm.mcp`（`McpSink`）；有 server 时 esmrun 的 d.ts 和 platform prompt 才出现 MCP 段。
- eta-server：`SessionManagerOptions.mcpFor` / `AssembleOptions.mcpFor`，会话打开时取 sink，关闭时 dispose。
- apps/eta：`src/mcp/host.ts` 的 `McpHost`，一个 host 一个 `McpManager`（文件在 `<dataDir>/mcp/`），按 agent 分 scope；来源是 `~/.eta/mcp.json` 再 `<cwd>/.mcp.json`，会话打开时读。`HostOptions.mcp: false` 关掉。测试：`apps/eta/test/mcp-realm.test.ts`（真 stdio 子进程）。

#37 接回的：

- OAuth：`src/mcp/credentials.ts`（凭据封存在数据库，按 server URL 的 sha256 存）、`src/mcp/service.ts` 的 `McpService`（登录/回调/登出，叠在 `McpHost` 上，`authProviderFor` 给 manager）、回调 `/mcp/oauth/callback`（`access.ts` 只对这一条 GET 免 token）。登录完成后重连等着它的 server。测试：`apps/eta/test/mcp-oauth.test.ts`（假授权服务器，login → callback → 存 token → connected → 会话 `import "mcp:remote"` 调用成功）。
- 设置页 MCP 状态：`src/mcp/plugin.ts` 的 `mcpPlugin` 实现 `mcp` wire target（list/connect/reconnect/login/completeLogin/logout），合约 `@eta/client-contracts` 未改，前端未改。
- 审批：删掉了 `@eta/mcp` 自己的门（`requiresApproval`、`McpHooks.approve`、`ApprovalRequest`），MCP 工具直接执行；realm `binding()` 的 authorize 不变。`mcp.json` 的 `approveTools` 照样解析不报错，但不再有任何效果。

还没接回的：

- bundle 的 `mcp.json`（`bundleMcpServers`、`mcpSourcesFor`）：没有作为来源。
- daemon / 远程会话：daemon 不建 `McpHost`，远程会话的 realm 报 not connected。

## 跟着变的测试

整文件删除：

- `apps/eta/test/akhook.test.ts`
- `apps/eta/test/mcp-oauth.test.ts`
- `apps/eta/test/credentials.test.ts`
- `apps/eta/test/remote-mcp.test.ts`
- `apps/daemon/test/mcp-host.test.ts`

还有 `apps/eta/test/approvals.test.ts` 末尾 `akhookMiddleware` 的单测，以及 `apps/daemon/test/bundle.test.ts` 里测 `bundleMcpServers` / `bundleHookLayer` 的用例。

用 `describe.skip` / `it.skip` 跳过、并标了 `// TOBEREFR: see packages/TOBEREFR/TODO.md` 的（能力回来后去掉 skip）：

- `approvals.test.ts`：审批列表会拦截工具。原来靠 akhook 中间件拦截，要等 authorize 接回来。
- `bundles.test.ts`、`bundles-remote.test.ts`、`bundles-gateway.test.ts`：bundle 的 MCP 工具、hook 规则、网关 key 下发。
- `task-runs.test.ts`：任务运行带上 bundle 的 MCP 工具和 hook 规则。
- `github-host.test.ts`：akhook 的 `gh pr create` 规则，以及 daemon shell 带 GitHub 登录（用的是 `bash` 工具）。
- `remote-conversations.test.ts`：daemon 上的 `bash` 工具、审批、`publish_artifact` 通过 link 读远端文件。

断言改成不再期望 `bash`/`read`/`mcp` 工具的：`remote-conversations.test.ts`、`replies.test.ts`、`task-runs.test.ts`。

删除的用例：`usage.test.ts` 里 subagent（`Agent` 工具）和 btw（`sessions.btwOpen`）两个计数用例，因为这两个系统已经决定永久删除（#281、#363），不会恢复。

## 已知不相关的失败

`apps/eta/test/llm-gateway.test.ts` 的「the CPA process is started again when it dies」在 main（392daa63）上同样失败，跟这次改动无关。

## 恢复时要回答的问题

1. ~~MCP 工具放在 realm 里还是保留成静态工具？~~ 已定：realm 模块（#33）。
2. 审批：`approvals` 列表（inbox `setApprovals`）怎样接到 `binding()` 的 authorize 上？daemon 上的会话还走 `tool.gate` 吗？
3. bundle 里的 `mcp.json` / `akhook.yml` 还保留吗？不保留的话 `readBundle` 的读取和 `Bundle.mcp`/`hooks` 字段一起删。
4. 远程会话的文件和 shell：`ExecutionEnv` 没了以后，daemon 上的 realm 直接用 node:fs 和 `$`，primary 侧的工具（如 `publish_artifact`）怎样读远端文件？
