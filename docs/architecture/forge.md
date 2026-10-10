# 代码托管（GitHub）

本文说明 [#19](https://github.com/AkaraChen/axp/issues/19) 的实现：智能体经用户自己的 GitHub App 访问 GitHub，runtime 里的 `git` 和 `gh` 开箱即用。用户授权过 App 时，智能体在 GitHub 上以用户的名义操作，GitHub 显示为用户本人并带 App 的标识；否则以 `<app>[bot]` 的身份（见[身份](#身份)）。AXP 不在 GitHub 给的权限之外再加限制（[#47](https://github.com/AkaraChen/axp/issues/47)）。

## 组成

| 部分          | 位置                                                                                     | 作用                                                    |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| forge 服务    | `apps/forge-service`（Go，二进制 `axp-forge`，生产角色 `forge`，别名 `axp-forge:8330`）  | 保存 App 凭据，签发 gh 的 token，开 PR                  |
| 向导          | 设置 → 连接里的 GitHub，点开是分步向导（`connection-settings.tsx`、`github-wizard.tsx`） | 了解、创建 App、安装到仓库、完成                        |
| runtime       | `apps/agent-runtime/axp_runtime/runtime.py`（`_refresh_github`）                         | 启动时以 App 的身份登录 gh，过期前刷新                  |
| git 配置      | `apps/agent-runtime/git/gitconfig` → `/etc/gitconfig`                                    | GitHub 走 HTTPS，凭据来自 gh，commit 身份               |
| `github` 插件 | `apps/agent-runtime/plugins/github`                                                      | `open_pull_request`（forge 服务的 MCP）与使用说明 skill |

| 路径              | 调用方                          | 鉴权                        |
| ----------------- | ------------------------------- | --------------------------- |
| `/api/forge/v1/*` | 浏览器（经 `gateway`）          | 无：只有网关连得到          |
| `/forge/*`        | runtime（经 `runtime-gateway`） | 网关注入的 `X-AXP-Agent-Id` |

一个 provider 只有一个连接，始终是用户自己的 App。App 是私有的，GitHub 只允许把它安装到拥有它的账号上；不保存 installation，用到时从 `GET /app/installations` 查（缓存 30 秒）。凭据只在 forge 服务的状态目录（开发为仓库根目录的 `var/forge`，生产为卷 `axp-forge`）：`github.json`、私钥 `github.pem` 和 client secret `github.secret`，用户的授权在 `user.json`（后三者 0600）。没有数据库，也不接收 webhook。

git 和 gh 的凭据、commit 身份是镜像级的，对每个 agent 都生效；`github` 插件只带来 `open_pull_request` 和使用说明，可以在智能体编辑器里关掉。

## 连接 GitHub

设置的“连接”分区里，GitHub 和 Grok 各是一张卡片；点开 GitHub 卡片是一个四步向导（了解、创建 App、安装到仓库、完成），步骤由服务端状态决定，从 GitHub 回来时自动重新打开在当前步骤。

1. **创建 App**：浏览器把服务生成的 [manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) 表单提交给 GitHub（个人账号或组织）。用户在 GitHub 上确认后，GitHub 带着一次性的 `code` 回到 `/api/forge/v1/github/manifest/callback`，服务用 `POST /app-manifests/{code}/conversions` 换回 App ID、slug、私钥、client ID 和 client secret，再把浏览器送回 `/?settings=connections`（设置弹层打开在“连接”）。`state` 一小时内有效、只能用一次。
2. **安装**：向导链接到 `https://github.com/apps/<slug>/installations/new`，用户选择账号和仓库。manifest 设了 `request_oauth_on_install`，GitHub 安装后接着请用户授权 App，再回到 App 的 callback URL（`/api/forge/v1/github/authorization/callback`，带 `setup_action`），由它换得用户的 token 并送回“连接”；这个选项下 GitHub 不用 setup URL。等待安装时状态每 5 秒刷新。
3. **完成**：列出每个安装的账号和可访问的仓库，附 GitHub 上的管理链接，以及 PR 以谁的名义打开（可以取消授权或去授权）。“断开连接”删除 AXP 保存的凭据和用户的授权，GitHub 上的 App 需要用户自己删除（提示里有链接）。

App 申请 GitHub 允许的全部仓库权限（含 `workflows`、`administration`、`secrets`、`repository_creation`）和组织权限，都取最高级别；用户安装时授予什么，智能体就有什么。installation token 签发时不收窄（`CreateInstallationToken` 不带 `permissions` 与 `repository_ids`），AXP 也不另设只读模式、操作白名单或降权。权限在创建 App 时写进 manifest，已经创建的 App 要在 GitHub 的 App 设置里改权限，再由安装方接受。webhook 关闭。

## runtime 里的 git 与 gh

- runtime 启动时（在 Codex 之前）向 `/forge/credentials` 要 gh 的 token（谁的 token 见[身份](#身份)），写进 gh 的 `hosts.yml`（`GH_CONFIG_DIR=/run/axp/gh`，0600，不在快照里），`user` 是用户的登录名或 App 的 bot，所以 `gh` 一开始就是登录状态，`gh auth status` 能看出以谁的身份。之后在过期前 5 分钟刷新；GitHub 还没连接或 forge 服务不可达时每 60 秒再试，连接之后不用重启 agent。断开连接后 `hosts.yml` 被删除。
- `/etc/gitconfig` 把 `git@github.com:` 改写为 HTTPS，凭据助手是 `gh auth git-credential`，所以 git 与 gh 用的是同一个 token。
- commit 身份：默认是 `AXP Agent`；GitHub 仓库里由 `includeIf` 引入 `/run/axp/git/github.inc`，即 App 的 bot（`<slug>[bot]` 与 `<id>+<slug>[bot]@users.noreply.github.com`），runtime 拿到凭据时一并写入。
- GitHub 没有连接时 gh 是未登录状态；App 没授权某个仓库时，GitHub 对它回答 404。`open_pull_request` 的错误里有服务的说明（引导用户去“设置 → 连接”）。公开仓库不需要凭据，照常可以 clone。

## open_pull_request

forge 服务在 `/forge/mcp` 提供这个 MCP 工具（`github` 插件的 `.mcp.json` 指向它，经 runtime 网关鉴权）。参数是仓库（`owner/name` 或 remote URL）、已推送的分支、标题、正文，可选的 base（默认是仓库的默认分支）和 draft。同一分支已有打开的 PR 时返回它，而不是报错。规则 `gh-pr-create` 把 `gh pr create` 引导到这个工具（见[工具调用规则与用户确认](agent-hooks.md)）。

## 身份

GitHub App 有两种身份（[官方说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)）：installation token（`ghs_`）的动作属于 App 的 bot，成败只看 App 获批的权限；用户授权 App 后得到的 user access token（`ghu_`）的动作属于用户，GitHub 显示用户的头像并带 App 的标识，权限是用户与 App 的交集，且只在 App 安装了的账号里。PR 等的作者取决于调用的 token，与 commit 的 author 无关。

forge 服务只有一条规则：**用户授权过 App 时，所有出口都以用户的身份**——runtime 里的 git 与 gh、远程电脑上的 `axp gh`（全部子命令）、`open_pull_request`、任务详情里的读 PR 与合并；没有授权（或授权失效）时都以 App 的 bot。`/forge/credentials` 对智能体和远程电脑（`computer-<id>`）回答相同，结果里的 `user` 说明是谁；旧版 CLI 带的 `?as=user` 被忽略。commit 的 author 始终是 App 的 bot。

有些操作 GitHub 只给用户身份，App 权限给全了 bot 也做不了。实测（#47）：App 安装在个人账号上、已获批 `administration: write` 时，installation token 调用 GraphQL `createRepository` 得到 `Resource not accessible by integration`，`POST /user/repos` 得到 403；同样的请求用用户的 token 通过了权限检查。官方[权限表](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)把 `POST /user/repos` 列为 `administration` 或 `repository_creation` 写权限、两种 token 都可，与实测不符，以实测为准。所以在个人账号下建仓库要求用户授权过 App；在组织里，installation token 可以用 `POST /orgs/{org}/repos`。

- **授权**：安装时一并授权（见上），或在向导“完成”一步点“前往 GitHub 授权”：`POST /api/forge/v1/github/authorization` 生成 `state` 与 PKCE，浏览器去 `github.com/login/oauth/authorize`，回到 callback。`state` 只在内存里，15 分钟有效、只能用一次；安装后的回跳没有 `state`，只带 `setup_action`。两种情况下都要求授权的账号能访问这个 App 的某个安装（`GET /user/installations`），否则不保存，别人的账号连不进来。
- **保存与刷新**：`user.json` 保存 token、refresh token、登录名和到期时间。token 8 小时过期，到期前 10 分钟用时刷新；refresh token 6 个月过期，用一次就换新的，所以刷新是串行的。刷新被拒或已过期时删除授权，以 App 的身份继续。
- **撤销**：向导里“取消授权”调用 `DELETE /applications/{client_id}/grant` 并删除 `user.json`。用户在 GitHub 上撤销时 AXP 收不到 webhook，下次 GitHub 回答 401 时删除授权。
- **下发**：`/forge/credentials` 只给出 access token（refresh token 留在 forge），到期时间最多报一小时，调用方因此至少每小时重新要一次：在 AXP 里取消授权后，一小时内各处都回到 App 的 bot。用户在 GitHub 上撤销时 AXP 收不到通知：forge 在自己调用 GitHub 得到 401 或刷新被拒时（最迟 token 到期，8 小时内）删除授权，在那之前下发的 token 会被 GitHub 拒绝（401）。
- **回退**：`open_pull_request` 有授权但 GitHub 回答 401（撤销）、403 或 404（用户对仓库的权限不够）时改以 App 的身份打开；结果的 `author` 是 GitHub 上 PR 的作者，智能体据此告诉用户。
- **较早创建的 App**：当时没有保存 client secret，也没有 callback URL。向导提示用户在 App 设置里把 Callback URL 设为 `<AXP>/api/forge/v1/github/authorization/callback`、生成新的 client secret，填进 AXP（`POST /api/forge/v1/github/oauth-client`），再去授权。
- **界面上的“via”**：GitHub 文档只承诺用户头像加 App 的标识，没有写“via <App>”的文案和位置，也没有配置项。

## 任务交付的 PR：状态与合并

任务详情（首页侧栏与全屏详情共用 `TaskProperties`）对每个 github.com 上的交付 PR 调用 `GET /api/forge/v1/pulls?url=`，显示状态（打开、草稿、已合并、已关闭）和 GitHub 的 `additions`/`deletions`；读不到时只显示“状态暂不可用”，不显示数字，也不影响详情其余部分。查询挂在任务的 query key 下，打开详情、刷新按钮和任务的修改都会重新读取；GitHub 还在计算可合并性时每 5 秒再读。

- **身份**：用户授权过 App 时以用户的 token 读和合并，GitHub 按用户自己的权限判断；没有授权（或 GitHub 拒绝了它，401）时用 installation token。用户的 token 被拒（403、404）不改用 App，以免借 App 越过用户的权限。
- **能否合并**：由 GitHub 的 `mergeable`/`mergeable_state` 得出 `ready`、`pending`（还没算出）或 `blocked`（草稿、冲突、分支保护要求未满足、落后于目标分支），附原因。以用户身份读时，仓库的 `permissions` 是用户自己的权限，没有写权限也是 `blocked`；以 App 身份读时 GitHub 对 installation token 报告的 `permissions` 全是 false（与 App 获批的权限无关），所以不看它，由 GitHub 在合并时判断。用户的 token 被拒（401）改用 App 后，按 App 身份判断。只有 `ready` 时界面上的按钮可用；`ready` 只是 AXP 看不出不能合并，以 GitHub 的合并结果为准。
- **合并**：`POST /api/forge/v1/pulls/merge {url, head_sha}`。先重新读 PR，head 不是用户看到的 `head_sha` 就拒绝（`STALE_HEAD`），再以 `sha` 调用 GitHub 的 merge，GitHub 在这之间有新提交时回答 409，同样是 `STALE_HEAD`。合并方式取仓库允许的第一个：squash、merge commit、rebase。不传 admin 覆盖、不开 auto-merge、不删分支。同一个 PR 同时只有一个合并（`MERGE_IN_PROGRESS`），前端也防重复点击。
- **结果未知**：GitHub 没有回答（断线、超时、5xx）时不重试，而是再读一次 PR：已在 `head_sha` 合并即为成功，否则回答 `MERGE_UNKNOWN`，界面重新读取 PR 状态，由用户确认后再决定。
- **合并并完成任务**：下拉菜单的“合并并标记任务完成”在合并成功之后才走现有的 `PATCH /api/v1/tasks/{id}`（`status: done`），收尾照旧。两步不在一个事务里：完成失败时提示“PR 已合并，任务未完成”，“标记任务完成”只重试改状态，不再合并。GitHub 上已合并、任务还没完成时同样提供这个按钮。

## 验证

- `apps/forge-service/internal/server`：测试对着 [emulate](https://github.com/vercel-labs/emulate)（forge-service 的开发依赖，`bun install` 安装）模拟的 GitHub 运行：App 的 JWT 校验、installation token 的权限、分支、开 PR 及其作者都是它的真实行为。它缺的或行为不同的几处（manifest 换凭据、`/installation/repositories`、同一分支重复开 PR 的 422、被删除的 App，以及用户授权的 client secret 校验、过期与刷新、`/user/installations` 和撤销）由测试里一层很薄的处理补上，其余请求原样转发；那一层还按 GitHub 的实际行为拒绝 installation token 在个人账号下建仓库（emulate 允许）。`open_pull_request` 通过 MCP 客户端调用，与 Codex 一样。`TestEveryCallerActsAsTheUserWhoAuthorized`：授权前智能体与远程电脑都拿到 bot 的 token、建不了仓库；授权后都拿到用户的 token（最多一小时）、能推送和建仓库，commit 身份仍是 bot，旧的 `?as=user` 无影响；取消授权后回到 bot。
- `apps/forge-service/internal/server/pulls_test.go`：同一个 emulate 上读 PR、草稿不能合并、读不到的 PR、过期的 head（本地检查与 GitHub 的 409）、合并成功、GitHub 已合并但回答丢失（核实为成功）、GitHub 失败（`MERGE_UNKNOWN`，没有合并）；以及仓库权限按 GitHub 的真实形状报告时（emulate 总报告全为 true，测试那层按用例改写）：App 身份权限全 false 仍能合并、用户没有写权限不能合并且不调用 GitHub、用户的 token 被拒后以 App 判断并合并、GitHub 拒绝用户的合并（403）不改用 App。
- `apps/web/src/components/workspace/task-pulls.test.tsx`：增删行数、读不到时不显示数字、不能合并时禁用并说明原因、按看到的 head 合并且只发一次、合并并完成时完成失败后只重试改状态、没有回答时重新读取而不重试。
- `apps/agent-runtime/tests/test_runtime.py`：runtime 对假的 forge 服务写出 gh 的 `hosts.yml`（用户授权时登录名是用户）与 commit 身份，断开后删除。
- 在开发环境中用浏览器走过向导：提交 manifest 后跳转到 GitHub，回调出错时显示原因；安装与已连接状态的界面。创建真实的 App 需要用户在 GitHub 上确认，没有自动化。
