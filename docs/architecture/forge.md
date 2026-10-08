# 代码托管（GitHub）

本文说明 [#19](https://github.com/AkaraChen/axp/issues/19) 的实现：智能体以用户自己的 GitHub App 的身份访问 GitHub，runtime 里的 `git` 和 `gh` 开箱即用，PR 由 `open_pull_request` 以 App 的身份打开，作者显示为 `<app>[bot]`。

## 组成

| 部分          | 位置                                                                                   | 作用                                                    |
| ------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| forge 服务    | `apps/forge-service`（`python -m axp_forge`，生产角色 `forge`，别名 `axp-forge:8330`） | 保存 App 凭据，签发 installation token，开 PR           |
| 向导          | 工作区“能力”页（`capabilities-view.tsx`）                                              | 创建 App、安装到仓库、查看与断开                        |
| `axp-forge`   | `apps/agent-runtime/bin/axp-forge`，镜像里是 `/opt/axp/bin/axp-forge`                  | git 的凭据助手；`/usr/local/bin/gh` 链接到它            |
| git 配置      | `apps/agent-runtime/git/gitconfig` → `/etc/gitconfig`                                  | GitHub 走 HTTPS 与凭据助手，commit 身份                 |
| `github` 插件 | `apps/agent-runtime/plugins/github`                                                    | `open_pull_request`（forge 服务的 MCP）与使用说明 skill |

| 路径              | 调用方                          | 鉴权                        |
| ----------------- | ------------------------------- | --------------------------- |
| `/api/forge/v1/*` | 浏览器（经 `gateway`）          | 无：只有网关连得到          |
| `/forge/*`        | runtime（经 `runtime-gateway`） | 网关注入的 `X-AXP-Agent-Id` |

一个 provider 只有一个连接，始终是用户自己的 App；不保存 installation，用到某个账号时从 `GET /app/installations` 查（缓存 30 秒）。凭据只在 forge 服务的状态目录（开发为仓库根目录的 `var/forge`，生产为卷 `axp-forge`）：`github.json` 和私钥 `github.pem`（0600）。没有数据库，也不接收 webhook。

## 连接 GitHub

1. **创建 App**：浏览器把服务生成的 [manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) 表单提交给 GitHub（个人账号或组织）。用户在 GitHub 上确认后，GitHub 带着一次性的 `code` 回到 `/api/forge/v1/github/manifest/callback`，服务用 `POST /app-manifests/{code}/conversions` 换回 App ID、slug 和私钥，再把浏览器送回 `/?view=capabilities`。`state` 一小时内有效、只能用一次。
2. **安装**：向导链接到 `https://github.com/apps/<slug>/installations/new`，用户选择账号和仓库；App 的 `setup_url` 把浏览器送回“能力”页。等待安装时状态每 5 秒刷新。
3. **完成**：列出每个安装的账号和可访问的仓库，附 GitHub 上的管理链接。“断开连接”只删除 AXP 保存的凭据，GitHub 上的 App 需要用户自己删除（提示里有链接）。

App 的权限：`contents`、`pull_requests` 读写，`issues`、`actions`、`checks`、`statuses`、`metadata` 只读；不申请 `workflows`，所以智能体不能修改 CI。webhook 关闭。

## runtime 里的 git 与 gh

- `/etc/gitconfig` 把 `git@github.com:` 改写为 HTTPS，并为 `https://github.com` 配置凭据助手 `axp-forge git-credential`（`useHttpPath`）。git 每次需要凭据时，助手向 `/forge/credential` 要一个只对这个仓库有效、权限为 `contents: write` 的 token，带上 GitHub 给的过期时间，所以不会遇到过期。
- `gh` 是 `axp-forge`：从 `-R`、`gh repo view|clone`、`gh api repos/...`、`GH_REPO` 或 `origin` 推断仓库所属账号，向 `/forge/gh-token` 要一个只读 token（按账号缓存到过期前 5 分钟），再执行真正的 gh（`/usr/local/lib/gh/gh`）。用户自己设了 `GH_TOKEN` 时不介入。
- Codex 不把含 KEY 的环境变量交给它运行的命令，因此 runtime 启动时把网关地址和实例 key 写到 `/run/axp/gateway.json`（0600，不在快照里）供 `axp-forge` 使用。
- commit 身份：默认是 `AXP Agent`；GitHub 仓库里由 `includeIf` 引入 `/run/axp/git/github.inc`，即 App 的 bot（`<slug>[bot]` 与 `<id>+<slug>[bot]@users.noreply.github.com`）。runtime 启动时写入；当时还没连接的话，`axp-forge` 第一次拿到凭据时写入。
- GitHub 没有连接、App 没装到该账号或没授权该仓库时，服务的说明（引导用户去“能力”页）会出现在 git 的错误输出、`gh` 的提示和 `open_pull_request` 的错误里。公开仓库不需要凭据，照常可以 clone。

写操作的约束见[工具调用规则与用户确认](agent-hooks.md)：`gh` 的写命令被拒绝，`gh pr create` 被引导到 `open_pull_request`，推送默认分支、`main`、`master` 要用户确认。这些是护栏；git 的 token 能写，绝对禁止的操作要靠 App 的权限（例如不给 `workflows`）。

## open_pull_request

forge 服务在 `/forge/mcp` 提供这个 MCP 工具（`github` 插件的 `.mcp.json` 指向它，经 runtime 网关鉴权）。参数是仓库（`owner/name` 或 remote URL）、已推送的分支、标题、正文，可选的 base（默认是仓库的默认分支）和 draft。token 只有 `pull_requests: write` 和 `contents: read`。同一分支已有打开的 PR 时返回它，而不是报错。

## 验证

- `apps/forge-service/tests`：用假的 GitHub API（真实的 RSA 密钥，校验 JWT）覆盖创建、回调的 `state`、安装与仓库列表、App 被删除、各用途的 token 权限与缓存、未连接时的提示和开 PR（含已存在的 PR）。
- `apps/agent-runtime/tests/test_axp_forge.py`：凭据助手与 gh 包装对假的 forge 服务的行为。
- 在开发环境中用浏览器走过向导：提交 manifest 后跳转到 GitHub，回调出错时显示原因；安装与已连接状态的界面。创建真实的 App 需要用户在 GitHub 上确认，没有自动化。
