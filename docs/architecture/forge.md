# 代码托管（GitHub）

本文说明 [#19](https://github.com/AkaraChen/axp/issues/19) 的实现：智能体以用户自己的 GitHub App 的身份访问 GitHub，runtime 里的 `git` 和 `gh` 开箱即用，PR 由 `open_pull_request` 打开。用户授权过 App 时，PR 代表用户打开，GitHub 上作者显示为用户本人并带 App 的标识；否则作者是 `<app>[bot]`（见[以用户的名义开 PR](#以用户的名义开-pr)）。

## 组成

| 部分          | 位置                                                                                    | 作用                                                    |
| ------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| forge 服务    | `apps/forge-service`（Go，二进制 `axp-forge`，生产角色 `forge`，别名 `axp-forge:8330`） | 保存 App 凭据，签发 installation token，开 PR           |
| 向导          | “能力”页的 GitHub 卡片，点开是分步向导（`capabilities-view.tsx`、`github-wizard.tsx`）  | 了解、创建 App、安装到仓库、完成                        |
| runtime       | `apps/agent-runtime/axp_runtime/runtime.py`（`_refresh_github`）                        | 启动时以 App 的身份登录 gh，过期前刷新                  |
| git 配置      | `apps/agent-runtime/git/gitconfig` → `/etc/gitconfig`                                   | GitHub 走 HTTPS，凭据来自 gh，commit 身份               |
| `github` 插件 | `apps/agent-runtime/plugins/github`                                                     | `open_pull_request`（forge 服务的 MCP）与使用说明 skill |

| 路径              | 调用方                          | 鉴权                        |
| ----------------- | ------------------------------- | --------------------------- |
| `/api/forge/v1/*` | 浏览器（经 `gateway`）          | 无：只有网关连得到          |
| `/forge/*`        | runtime（经 `runtime-gateway`） | 网关注入的 `X-AXP-Agent-Id` |

一个 provider 只有一个连接，始终是用户自己的 App。App 是私有的，GitHub 只允许把它安装到拥有它的账号上；不保存 installation，用到时从 `GET /app/installations` 查（缓存 30 秒）。凭据只在 forge 服务的状态目录（开发为仓库根目录的 `var/forge`，生产为卷 `axp-forge`）：`github.json`、私钥 `github.pem` 和 client secret `github.secret`，用户的授权在 `user.json`（后三者 0600）。没有数据库，也不接收 webhook。

git 和 gh 的凭据、commit 身份是镜像级的，对每个 agent 都生效；`github` 插件只带来 `open_pull_request` 和使用说明，可以在智能体编辑器里关掉。

## 连接 GitHub

“能力”页的每项能力是一张卡片；点开 GitHub 卡片是一个四步向导（了解、创建 App、安装到仓库、完成），步骤由服务端状态决定，从 GitHub 回来时自动重新打开在当前步骤。

1. **创建 App**：浏览器把服务生成的 [manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) 表单提交给 GitHub（个人账号或组织）。用户在 GitHub 上确认后，GitHub 带着一次性的 `code` 回到 `/api/forge/v1/github/manifest/callback`，服务用 `POST /app-manifests/{code}/conversions` 换回 App ID、slug、私钥、client ID 和 client secret，再把浏览器送回 `/?view=capabilities`。`state` 一小时内有效、只能用一次。
2. **安装**：向导链接到 `https://github.com/apps/<slug>/installations/new`，用户选择账号和仓库。manifest 设了 `request_oauth_on_install`，GitHub 安装后接着请用户授权 App，再回到 App 的 callback URL（`/api/forge/v1/github/authorization/callback`，带 `setup_action`），由它换得用户的 token 并送回“能力”页；这个选项下 GitHub 不用 setup URL。等待安装时状态每 5 秒刷新。
3. **完成**：列出每个安装的账号和可访问的仓库，附 GitHub 上的管理链接，以及 PR 以谁的名义打开（可以取消授权或去授权）。“断开连接”删除 AXP 保存的凭据和用户的授权，GitHub 上的 App 需要用户自己删除（提示里有链接）。

App 申请 GitHub 允许的全部仓库权限（含 `workflows`、`administration`、`secrets`）和组织权限，都取最高级别；用户安装时授予什么，智能体就有什么。权限在创建 App 时写进 manifest，已经创建的 App 要在 GitHub 的 App 设置里改权限，再由安装方接受。webhook 关闭。

## runtime 里的 git 与 gh

- runtime 启动时（在 Codex 之前）向 `/forge/credentials` 要一个 installation token：App 所属账号的那个 installation，覆盖用户授权的所有仓库和权限。forge 服务对每个 installation 只签一种 token，`open_pull_request` 和向导也用它。token 写进 gh 的 `hosts.yml`（`GH_CONFIG_DIR=/run/axp/gh`，0600，不在快照里），所以 `gh` 一开始就是登录状态。之后在过期前 5 分钟刷新；GitHub 还没连接或 forge 服务不可达时每 60 秒再试，连接之后不用重启 agent。断开连接后 `hosts.yml` 被删除。
- `/etc/gitconfig` 把 `git@github.com:` 改写为 HTTPS，凭据助手是 `gh auth git-credential`，所以 git 与 gh 用的是同一个 token。
- commit 身份：默认是 `AXP Agent`；GitHub 仓库里由 `includeIf` 引入 `/run/axp/git/github.inc`，即 App 的 bot（`<slug>[bot]` 与 `<id>+<slug>[bot]@users.noreply.github.com`），runtime 拿到凭据时一并写入。
- GitHub 没有连接时 gh 是未登录状态；App 没授权某个仓库时，GitHub 对它回答 404。`open_pull_request` 的错误里有服务的说明（引导用户去“能力”页）。公开仓库不需要凭据，照常可以 clone。

## open_pull_request

forge 服务在 `/forge/mcp` 提供这个 MCP 工具（`github` 插件的 `.mcp.json` 指向它，经 runtime 网关鉴权）。参数是仓库（`owner/name` 或 remote URL）、已推送的分支、标题、正文，可选的 base（默认是仓库的默认分支）和 draft。同一分支已有打开的 PR 时返回它，而不是报错。规则 `gh-pr-create` 把 `gh pr create` 引导到这个工具（见[工具调用规则与用户确认](agent-hooks.md)）。

## 以用户的名义开 PR

GitHub App 有两种身份（[官方说明](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)）：installation token（`ghs_`）的动作属于 App 的 bot；用户授权 App 后得到的 user access token（`ghu_`）的动作属于用户，GitHub 显示用户的头像并带 App 的标识。PR 的作者取决于调用“创建 PR”的 token，与 commit 的 author 无关。

- **授权**：安装时一并授权（见上），或在向导“完成”一步点“前往 GitHub 授权”：`POST /api/forge/v1/github/authorization` 生成 `state` 与 PKCE，浏览器去 `github.com/login/oauth/authorize`，回到 callback。`state` 只在内存里，15 分钟有效、只能用一次；安装后的回跳没有 `state`，只带 `setup_action`。两种情况下都要求授权的账号能访问这个 App 的某个安装（`GET /user/installations`），否则不保存，别人的账号连不进来。
- **保存与刷新**：`user.json` 保存 token、refresh token、登录名和到期时间。token 8 小时过期，到期前 10 分钟用时刷新；refresh token 6 个月过期，用一次就换新的，所以刷新是串行的。刷新被拒或已过期时删除授权，以 App 的身份继续。
- **撤销**：向导里“取消授权”调用 `DELETE /applications/{client_id}/grant` 并删除 `user.json`。用户在 GitHub 上撤销时 AXP 收不到 webhook，下次 GitHub 回答 401 时删除授权。
- **使用范围**：只有 `open_pull_request` 和远程电脑上的 `axp gh pr …`（`/forge/credentials?as=user`，只给 `computer-<id>` 调用方）用用户的 token；runtime 里 git 与 gh 的凭据、commit 身份仍是 App 的。用户的 token 的权限是用户与 App 的交集。
- **回退**：没有授权时以 App 的身份打开。有授权但 GitHub 回答 401（撤销）、403 或 404（用户对仓库的权限不够）时改以 App 的身份打开，结果的 `fallback` 写明原因；`author` 总是 GitHub 上 PR 的作者。
- **较早创建的 App**：当时没有保存 client secret，也没有 callback URL。向导提示用户在 App 设置里把 Callback URL 设为 `<AXP>/api/forge/v1/github/authorization/callback`、生成新的 client secret，填进 AXP（`POST /api/forge/v1/github/oauth-client`），再去授权。
- **界面上的“via”**：GitHub 文档只承诺用户头像加 App 的标识，没有写“via <App>”的文案和位置，也没有配置项。

## 验证

- `apps/forge-service/internal/server`：测试对着 [emulate](https://github.com/vercel-labs/emulate)（forge-service 的开发依赖，`bun install` 安装）模拟的 GitHub 运行：App 的 JWT 校验、installation token 的权限、分支、开 PR 及其作者都是它的真实行为。它缺的或行为不同的几处（manifest 换凭据、`/installation/repositories`、同一分支重复开 PR 的 422、被删除的 App，以及用户授权的 client secret 校验、过期与刷新、`/user/installations` 和撤销）由测试里一层很薄的处理补上，其余请求原样转发。`open_pull_request` 通过 MCP 客户端调用，与 Codex 一样。
- `apps/agent-runtime/tests/test_runtime.py`：runtime 对假的 forge 服务写出 gh 的 `hosts.yml` 与 commit 身份，断开后删除。
- 在开发环境中用浏览器走过向导：提交 manifest 后跳转到 GitHub，回调出错时显示原因；安装与已连接状态的界面。创建真实的 App 需要用户在 GitHub 上确认，没有自动化。
