# GitHub

智能体以**一个 GitHub App** 的身份使用 GitHub：用户在“设置 → 连接”里按向导创建它、安装它，并可以授权它代表自己行动。授权之后所有智能体都以用户的名义做事（GitHub 上显示为用户，带 App 的徽章）；没授权就以 App 的 bot 身份。没有按智能体划分的凭据。

这是主分支 AXP 的 forge 服务（`apps/control-plane/internal/{github,forge}`）移植进单进程 host：规则、提示语、工具名、技能文字都沿用，只有管道变了——Go 控制面 + Postgres + REST + 卷上的文件，变成 host 里的 TypeScript 插件 + SQLite + wire target。代码在 `apps/eta/src/github/`。

## 开关：默认不加载

这条链是**选择性加入**的，默认关：`--github`，或环境变量 `ETA_GITHUB=1`（`--no-github` 顶掉环境变量里的那份）。和 `--memory-url` 那一组一样，开关在 `apps/eta/src/main.ts`，往下是 `startHost({ github })` / `createProduct({ github })`；测试同样直接给（`github: true`，或指向假 GitHub 的 `{ endpoints }`）。

关着的时候整条都不建：不 `new Github`、不建 `GitHubKeeper`、不 `mount("github")`、不注册 `githubSessionTools`（智能体的工具列表里没有 `open_pull_request`、`draft_issue`）、不注册回调路由（`/github/manifest/callback`、`/github/authorization/callback` 谁也不答）、不派发 `githubRefresh`、会话 shell 的环境里没有 GitHub 凭据，宿主自己的 `eta:github` akhook 层也不注册。等插件起来的集合里不算它，所以启动不会白等一次 `MOUNT_TIMEOUT_MS`。**一次 GitHub API 请求也不发**（不是“发了但失败”）。

界面按 `hello.mounted` 里有没有 `github` 隐藏（`useGitHubMounted`），不再多问一次配置：设置里没有「连接」，任务详情没有交付那一行，旧时间线里带 PR / issue draft 引用的工具活动不画卡片（只剩工具调用本身），也不订阅 `github`。旧行一律不画而不是画个空框：一条通向别的系统、来源又不在这台宿主上的卡片，会让人以为功能还在。

这是**藏起来，不是删掉**：表、行、迁移、文案、代码都留着，带旗标开回来时行为与今天一致。

## 谁以谁的身份

| 场景                        | 身份                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| `git`、`gh`（会话的 shell） | 用户授权过 App：用户的 user-to-server 令牌（`gh auth status` 是用户）；否则 App 的安装令牌（bot） |
| commit 作者                 | 一律是 App 的 bot（`<slug>[bot]`，邮箱 `<bot id>+<slug>[bot]@users.noreply.github.com`）          |
| `open_pull_request`         | 用户的令牌先试；GitHub 拒绝（401 同时忘掉授权；403、404 表示用户权限不够）就静默改由 App 开       |
| 读取 PR、合并 PR（任务页）  | 用户的令牌；没有授权或被拒（401）则 App。合并被 GitHub 拒绝就是答案，不会换 App 再合并            |

App 是 public 的（用户可以把它装到自己的其他账号和组织），`request_oauth_on_install`：安装时 GitHub 顺带请用户授权，所以多数用户装完就已经是“以用户身份”。令牌的权限就是安装时用户授予的；创建 App 时 manifest 向 GitHub 要的是仓库与组织能要的最高档。

## 创建与安装（向导）

设置 → 连接 → GitHub，四步：了解 → 创建 App → 安装到仓库 → 完成。向导读 `github` target 的 `state`，所处步骤由 host 的状态决定。

1. **创建**：`github.createApp { name, organization?, origin }` 校验名称（≤ 34 个字符，字母数字空格 `._-`）和组织名，返回一个 `{ action, manifest }`。浏览器把 manifest 以表单 POST 给 GitHub（GitHub 只接受这种方式），`action` 里带着 host 生成的一次性 `state`（`github_pending`，1 小时有效）。manifest 的 `redirect_url` 是 `<origin>/github/manifest/callback`，`callback_urls` 是 `<origin>/github/authorization/callback`，webhook 地址写着但 `active: false`（没有东西监听 webhook，也就没有 webhook 路由）。
2. **回来**：GitHub 把浏览器送回 `GET /github/manifest/callback?code&state`。host 用掉 `state`、用 `code` 向 GitHub 换 App 的凭据（id、slug、私钥 PEM、client id/secret），存库后 303 到 `/?settings=connections&github=created`；失败则 `…&github_error=<原因>`，页面据此重开向导并显示原因。已有 App 时不能再创建（`GITHUB_ALREADY_CONNECTED`）。
3. **安装**：用户在 GitHub 上装 App。App 等第一次安装时页面每 5 秒让 host 重新问 GitHub（`github.refresh`），窗口重新获得焦点时也问一次。`state` 是 `not_connected` / `not_installed` / `ready` / `error`；`error` 带 GitHub 的原因，GitHub 不再认这个 App（401）是 `GITHUB_APP_GONE`，提示断开重连。
4. **授权**（可选，也是装完时 GitHub 顺带问的）：见下。
5. **断开**：`github.disconnect` 删掉 App 的凭据和用户的授权（GitHub 上的 App 不会被删，提示里有去删除的链接）。

重定向地址的 origin 取 `--public-url`（或 `ETA_PUBLIC_URL`），没有就用页面报来的 `location.origin`，和 [MCP 的 OAuth 回调](mcp.md#oauth)一致。

## 用户的授权

`github.authorize { origin }` 返回 GitHub 的授权地址（PKCE：`code_challenge` S256，`state` 与 verifier 记在 `github_pending`，15 分钟有效）。回调 `GET /github/authorization/callback` 有三种来法：

- 带 `code` 和 host 发出的 `state`（向导里点的“前往 GitHub 授权”）；
- 带 `code` 和 `setup_action`、**没有** `state`（装 App 时 GitHub 顺带要的授权，GitHub 不会回传 state）；
- 只有 `setup_action`（装完了，没要授权）：只在地址里告诉页面“已安装”。

换到令牌后一定核对：这个 GitHub 账号**能访问这个 App 的某个安装**（`GET /user/installations`），否则不保存（`AUTHORIZATION_UNRELATED`），免得别人的账号被连上。没有 `state` 的那种来法，host 无法把它和自己的某次点击对上，所以多一条：个人 App 只接受 App 所有者本人的账号（组织 App 不加这条）；否则让用户回到设置里用向导授权。（主分支没有这一条，这是移植时加的收紧。）

令牌 8 小时、refresh token 6 个月，每次刷新两个都换新，**一个 refresh token 只能用一次**，所以刷新是串行的（`Github.#locked`）。GitHub 拒绝刷新就忘掉授权。取消授权（`github.unauthorize`）会先在 GitHub 上撤销（`DELETE /applications/{client_id}/grant`，尽力而为）再删。早于 host 保存 client secret 的 App 没有 secret：向导里让用户填 Client ID 和新生成的 secret（`github.setOAuthClient`）。

host 给机器的令牌**最多一小时**（`credentials()`），所以在 eta 里取消授权，一小时内就换回 bot。

## 存哪里

迁移 0035：

| 表               | 内容                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `github_app`     | 单行。App 的公开信息明文；**私钥、client secret 密封**（`apps/eta/src/secret.ts`，AES-256-GCM，`secret.key`） |
| `github_user`    | 单行。登录名、id 明文；**访问令牌与 refresh token 密封**                                                      |
| `github_pending` | 进行中的创建（manifest）与授权：一次性 `state`、PKCE verifier、重定向地址。用掉即删，过期清除                 |
| `task_pull`      | 任务交付的 PR：`task_id`（外键，任务删除时级联）、`url`、`title`、`number`、`opened_at`                       |

密封的行读不开（换了密钥或被改过）等于没有：App 读作未连接，用户读作没授权。密钥、secret 和令牌从不上 wire：wizard 拿到的是要打开的地址和要 POST 的 manifest。

## 令牌与调用

`Github` 类（`service.ts`）。作为 App 调用用 JWT（RS256，`iss` 是 App id，有效 9 分钟），作为安装调用用安装令牌（缓存到离过期不到 10 分钟）。安装按 owner 找（先用 30 秒的缓存，找不到再问 GitHub 一次）；`credentials()` 用的是 **App 所有者**账号上的那个安装。找不到安装是 `GITHUB_NOT_INSTALLED`，消息里告诉用户去“设置 → 连接”安装。

GitHub 的失败一律是 424（不是 502，Cloudflare 会把源站的 502/504 换成自己的错误页）；错误对象 `GithubError` 带 `code`、`message`、`status`，消息是中文原文，页面和工具直接展示。

## 工具

`open_pull_request`、`draft_issue`，名字、参数、说明沿用主分支 forge 的 MCP 服务器。做成**会话工具**（`githubSessionTools`，进 `combineSessionHooks`），不起 MCP 服务器：

- 工具运行在 host 进程里，host 本来就持有每个会话的工具清单；不需要 MCP 客户端、端口和凭据去访问同进程里的东西。
- daemon 上的会话也有这两个工具：产品工具走 `tool.call` 回到主 node 执行，所以 App 的密钥不出主 node。
- 工具结果的 `details` 说明它做出了什么（`pull_request` 或 `issue_draft`），页面据此在工具行下画一张卡片（`activity-ref`），`draft_issue` 的卡片打开 GitHub 预填好的新建 issue 页，正文太长放不进链接时卡片带“复制正文”。

`open_pull_request` 找到同一个 head 已开的 PR 就返回它（`created: false`）。`draft_issue` 不碰 GitHub，没连接也能用；链接超过 8000 字符时只填标题，正文随结果带给页面（所以守护进程记工具活动的 `details` 上限放到 70,000 字符）。

## 任务与 PR

任务板不认识 GitHub。会话里 `open_pull_request` 成功后，host 在 `task_pull` 里记一行：任务是这个对话**还在进行**（todo / in_progress / in_review / blocked）的、最近动过的那个任务。没有就不记。`github` target 的 `pulls` 是这张表；任务页的“交付”一行（`TaskPulls`，挂在 `TaskProperties` 的 children 上）列出它们，每个显示 GitHub 上现在的状态、行数，并可以合并：

- `github.pull { url }`：现读 PR（`open` / `draft` / `merged` / `closed`，+/− 行数，`headSha`，能否合并 `ready` / `pending` / `blocked` 和原因）。PR 链接必须是 github.com 的 `…/pull/<n>`。
- `github.merge { url, headSha }`：只合并页面看到的那个提交（`sha` 对不上是 `STALE_HEAD`），用仓库允许的第一种合并方式（squash、merge、rebase）；**从不**绕过保护：没有 admin 覆盖、自动合并、删分支。答案丢了（网络、超时、GitHub 5xx）不重试：再读一次，在 `headSha` 上已合并就算成功，否则 `MERGE_UNKNOWN`。同一个 PR 同时只能有一次合并在进行。
- “合并并标记任务完成”是两步：GitHub 合并成功后才把任务设为完成，完成失败可以单独重试而不会再合并。

## 机器上的 git 与 gh

`GitHubKeeper`（`apps/daemon/src/github.ts`，host 和 daemon 共用）在每台机器的 `<数据目录>/github/` 写令牌、定时刷新（过期前 5 分钟，失败 1 分钟重试），并维护一个共享的环境对象 `env`，会话的 shell 每条命令都读它：

- `GH_CONFIG_DIR=<dir>/gh`：`gh/hosts.yml` 是 gh 对 github.com 的登录（用户名是授权用户或 bot）；
- `GIT_CONFIG_COUNT/KEY/VALUE`：`credential.https://github.com.helper`（先清空机器上原有的 helper，再用一个读 `token`、`login` 文件的 shell 函数）和 `include.path`（`git/github.inc`，commit 作者是 App 的 bot）。

没连接 GitHub 时 `env` 是空的、`github/` 里没有文件，机器自己的 gh/git 登录照旧；连接、授权、断开立刻对已经打开的会话生效（环境对象每条命令读一次），不用重开。`token` 文件最后写，写在别的文件之后，它在就说明其余都在。

- 主 node：同进程直接取（`Github.credentials()`）。
- daemon：经链路问主 node，`svc` 调用 `github.credentials`，返回 `{ token, expiresAt, identity, user? }` 或 `null`（没连接）。主 node 连接、授权、断开时向在线的 daemon 发 `machine.githubRefresh`，让它马上再问，不必等下一次刷新。链路断了就保留磁盘上的登录不动。**daemon 上没有 App 的私钥、client secret、refresh token**，只有最多一小时的令牌。

## akhook

宿主层 `eta:github`（`github/akhook.ts`）带 `gh-pr-create` 规则：`shell_exec` 命中 `gh pr create` 就拦下，消息“推送分支后用 open_pull_request 工具开 PR。”。它是宿主层，用户的与项目的 akhook 文件关不掉也盖不掉，并随其他宿主层一起送到 daemon 的会话。规则防的是失误，不防存心绕过的智能体：真正不允许的事靠凭据管。

（主分支的另一条 `akhook-approval` 管 Codex 的一次性授权文件，这里的 ask 规则走收件箱，没有对应物，不移植。）

## wire：`github` target

两个 section：`state`（`GitHubStatus`：`state`、`app`、`installations`、`error`、`user`、`oauth`、`checked`）和 `pulls`（`TaskPullView[]`）。`checked` 为 false 表示 host 启动后还没问过 GitHub，页面显示加载中。

| 动作             | 说明                                                       |
| ---------------- | ---------------------------------------------------------- |
| `refresh`        | `{ fresh? }`：问 GitHub 装在哪些账号，回新的 `state`       |
| `createApp`      | `{ name, organization?, origin }` → `{ action, manifest }` |
| `setOAuthClient` | `{ clientId, clientSecret }`                               |
| `authorize`      | `{ origin }` → `{ url }`                                   |
| `unauthorize`    | 撤销用户的授权                                             |
| `disconnect`     | 忘掉 App 和授权                                            |
| `pull`           | `{ url }` → `GitHubPull`                                   |
| `merge`          | `{ url, headSha }` → `GitHubPull`                          |

## 访问控制

两条回调是免令牌门的**精确路径、只读**（见[访问控制](access.md)）：`/github/manifest/callback`、`/github/authorization/callback`，浏览器从 github.com 回来不带我们的 cookie。凭据是 host 发出的 `state`：没有、不对、已用过、过期的，什么都不改变，只重定向到设置页并带上原因。它们不做别的事。

## 界面

设置 → 连接（`connection-settings.tsx`）：一行 GitHub，右边“开始连接”或“管理”，状态徽章和一句话（以谁的身份、待安装、出错）。向导（`github-wizard.tsx`）是对话框，带步骤条。GitHub 的回调把 `?settings=connections&github=created|authorized|…` 带回首页，设置对话框据此打开，向导读到 `github`、`github_error`、`setup_action` 就提示并重开在当前步骤，然后从地址里去掉这些参数。host 没有 `github` 插件时，这个设置项隐藏。
