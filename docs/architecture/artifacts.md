# Artifacts

本文说明 [#104](https://github.com/akarachen/axp/issues/104) 的实现：智能体把静态网页（一个根目录有 `index.html` 的 ZIP，带 CSS、JS、图片）发布为 Artifact，用户在聊天和任务里点卡片预览，可以在新窗口打开、下载，也可以公开分享某个版本并随时撤销。页面可以交互，但拿不到 AXP 的 API、登录状态或任何宿主能力。

## 方案

先比较了两种做法：

|              | 独立的 artifact 服务（service-go 上新服务，自己的库）    | 控制面里的一个领域包（采用）                                    |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------- |
| 上传者的身份 | 要么复制远程电脑令牌的校验，要么每次回调控制面           | 直接复用：runtime 网关的 `X-AXP-Agent-Id`、`/remote` 的电脑令牌 |
| 绑定任务     | 要调控制面的接口写时间线、校验“这台电脑能不能写这个任务” | 同一事务里 `tasks.RecordArtifact`，复用 `remoteTask` 的权限检查 |
| 聊天卡片     | 控制面仍要认识 `artifact` 这种 ref                       | 同左，只多一个 ref kind                                         |
| 部署         | 新角色、新库、新网关路由、新密钥                         | 没有新进程；只多一个 S3（可换成外部 S3）                        |

独立服务的隔离收益很小（对象存储本来就在 adapter 后面），却要多一套身份和跨服务写入。所以 Artifact 是控制面的 `internal/artifacts`（领域：校验、版本、分享、预览能力）加 `internal/objects`（S3 adapter，只认 key 和字节），HTTP 只在 `internal/api/artifacts.go`。数据库存元数据和关联，S3 存对象。

## 模型

- `artifact`：标题、发布者（`agent_id` 或 `computer_id`，只有发布者能发新版本）、所属任务、来源群（`group_id`）。
- `artifact_version`：每次上传一个，编号递增，发布后不再改变。状态 `processing` → `published`，或 `failed`（带原因，对象已删除）。
- `artifact_share`：公开分享的令牌（256 位随机，base64url）绑定一个版本；撤销后永久失效，再分享会生成新令牌。发布新版本不会改动已有分享。

对象在 `artifacts/<artifact>/<version>/`：`archive.zip` 是原包，`files/<路径>` 是解出的文件（带按扩展名推断的 Content-Type）。

## 上传

一个上传实现（`artifacts.Service.Upload`），两个入口，请求体都是 ZIP，`title`、`task`、`artifact`（发新版本时）在 query 里：

| 调用方                     | 入口                                                                        | 身份                                                       | 能挂的任务                                     |
| -------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| AXP 智能体（包括主智能体） | `artifacts` 插件的 `publish_artifact` → runtime 网关 `/artifacts/v1/upload` | runtime 网关核对 agent key 和插件后给出 `X-AXP-Agent-Id`   | 任何任务（与 tasks 插件一致），可不挂          |
| 远程电脑上的智能体         | `axp artifact upload <dir\|zip>` → `POST /remote/v1/artifacts`              | 电脑的令牌（`Authorization: Bearer`），不依赖浏览器 Cookie | 必须挂任务，且是指派给这台电脑或它运行过的任务 |

`publish_artifact`（`apps/agent-runtime/plugins/artifacts/server.mjs`）和 `axp artifact upload`（`apps/remote/artifact.go`）都接受目录（就地打包，拒绝符号链接，跳过 `.git`、`node_modules`）或 ZIP。工具结果在 `_meta["axp/ref"]` 里写 `{kind: "artifact", id, title, number: 版本}`，控制面存为活动块的 ref，聊天里显示卡片（见[聊天与运行时架构](chat-runtime.md)）；挂了任务时时间线上记一条 `artifact`。用法写在 `artifacts` 插件的 skill 和 `axp` skill 里。

处理顺序：

1. 先查权限（发新版本只能是原发布者；任务按上表），不读请求体。
2. 请求体流式写入临时文件并算 sha256，超过 90 MiB 返回 413。ZIP 的目录在文件尾部，所以先落盘再读。
3. 校验整个包，不合格返回 422 `INVALID_ARTIFACT` 且什么都不存：根目录要有 `index.html`（在单层子目录里时提示怎么重新打包）；路径必须是根下的干净相对路径（拒绝 `..`、绝对路径、反斜杠、冒号、空字符、重复路径）；拒绝符号链接和其他非普通文件、加密条目、stored/deflate 以外的压缩方式；最多 5000 个文件、解压后共 512 MiB（按声明的大小先算，读的时候 `archive/zip` 会拒绝实际字节与声明不符的条目）。
4. 建版本行（`processing`），逐个文件流式写入 S3，再写原包。任何一步失败：删掉这个版本前缀下的对象，版本标为 `failed`，返回 424 `STORAGE_FAILED`（读包出错是 422）。进程中途退出留下的 `processing` 版本，一小时后由下一次上传清理。
5. 标为 `published`，同一事务里写任务时间线，并刷新关联群的任务卡。

AXP 智能体首次发布时，从网关的 `X-AXP-Group-Id` 记录来源群；发新版本不改变来源。远程电脑的产物通过所属任务的群关联展示。公开 Artifact 形状带 `group_id`，群工作区用现有 Artifact 卡片列出该群的产物，预览与分享规则相同。

## 预览与分享

页面都在 AXP 自己的域名下，用沙箱隔离：

- 每个文件响应都带 `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads`（没有 `allow-same-origin`、没有 `allow-top-navigation`），所以无论在 iframe 里还是在新窗口直接打开，页面都是 opaque origin：读不到 Cookie 和 localStorage（抛 `SecurityError`），不能以 AXP 的身份发请求。iframe 本身也带同样的 `sandbox` 属性。
- `Referrer-Policy: no-referrer`：路径就是凭据，不能经 Referer 泄露给页面加载的外部资源。
- `Access-Control-Allow-Origin: *`（不带 credentials）：opaque origin 里的 `fetch()` 和 module script 即使访问同一主机也是跨域请求，没有它页面读不到自己的数据文件。
- 分享页和文件 `Cache-Control: no-store`，避免 Cloudflare 按扩展名缓存后撤销不生效；预览 `private, max-age=3600`。

**私有预览不能靠 Cookie。** 实测 Chromium：sandbox iframe 里的子资源请求是 `Sec-Fetch-Site: cross-site`，不带 SameSite=Lax 或未设 SameSite 的 Cookie（Cloudflare Access 的 `CF_Authorization` 现在没有设 SameSite，即按 Lax 处理），`fetch` 的 `Origin` 是 `null`。只有 iframe 的第一个文档会带 Cookie。所以私有预览用路径里的短时能力：`/preview/artifacts/<版本 id>.<过期时间>.<HMAC>/files/…`，HMAC 由控制面的 `AXP_SECRET_KEY` 派生，1 小时有效（Web 每次打开 Dialog 都重新读取地址，打开期间每 30 分钟刷新），只能读这一个已发布版本的文件，相对路径的所有资源都在同一前缀下可用。它和分享令牌是两套：分享前缀下用预览能力或 artifact id 都访问不到任何东西。

**公开分享**：`/share/artifacts/<令牌>/` 是 AXP 生成的页面（无脚本，CSP `default-src 'none'`），上方标题、版本、“新窗口打开”“下载”，下面是 sandbox iframe 加载 `files/`。壳页面不引用 Web 的任何资源，所以不需要放行 `/assets` 之类的目录。无效、已撤销、版本不存在都返回 404（壳页面是一行“这个分享不存在，或已被撤销”）。

**外部资源**：页面可以加载公共 CDN 的脚本、字体、图片（不受 CSP 限制）；对外 API 只有允许跨域（`Access-Control-Allow-Origin` 为 `*` 或 `null`）的才能用，因为 origin 是 `null`。不能用 Cookie、localStorage、IndexedDB、Service Worker，也不能导航顶层窗口；弹窗可以打开（逃离沙箱，例如外链）。

## 同域与 CSRF

AXP 自己没有登录，浏览器 API 靠边缘的 Cloudflare Access，原先没有任何 Origin/CSRF 校验：同一域名下的沙箱页面（或任何别的站点）若能让浏览器带上 Access 的 Cookie，就能发写请求（form POST、`text/plain` 的 fetch 不需要预检）。CORS 只挡得住读响应，挡不住副作用。现在由浏览器网关（`apps/gateway/public.caddy`）统一拦：

- 除 `/share/artifacts/*`、`/preview/artifacts/*` 外，`Sec-Fetch-Site` 为 `cross-site` 或 `same-site` 的请求一律 403 `CROSS_SITE_FORBIDDEN`，只放过 GET/HEAD 的顶层导航（`Sec-Fetch-Mode: navigate`：普通链接、GitHub 授权后跳回 `/api/forge`）；
- `Origin: null` 的请求一律 403（覆盖不发 Fetch Metadata 的旧浏览器里的沙箱页面）。
- `axp` CLI、curl 这类非浏览器客户端不发这两个头，不受影响；它们本来也不靠 Cookie。

这条规则在网关一处生效，覆盖控制面、llm、memory、forge、routines 和 OpenObserve 的全部接口。

## 路由矩阵

| 路径                                          | 方法        | 用途                           | 鉴权                             | Cloudflare Access                     |
| --------------------------------------------- | ----------- | ------------------------------ | -------------------------------- | ------------------------------------- |
| `/share/artifacts/<令牌>/`                    | GET         | 公开分享页（壳）               | 令牌（未撤销）                   | **Bypass**                            |
| `/share/artifacts/<令牌>/files/<路径>`        | GET         | 分享版本的文件                 | 令牌                             | **Bypass**                            |
| `/share/artifacts/<令牌>/archive.zip`         | GET         | 分享版本的原包                 | 令牌                             | **Bypass**                            |
| `/preview/artifacts/<能力>/files/<路径>`      | GET         | 私有预览（Dialog、新窗口打开） | 1 小时的 HMAC 能力，只对一个版本 | **Bypass**                            |
| `/remote/v1/artifacts`                        | POST        | 远程电脑上传                   | 电脑令牌 + 任务归属              | Bypass（已有的 `/remote` 应用，不变） |
| `/artifacts/v1/upload`（runtime 网关）        | POST        | 容器内智能体上传               | agent key + `artifacts` 插件     | 不经过（runtime 网络）                |
| `/api/v1/artifacts`、`/api/v1/artifacts/{id}` | GET、DELETE | 列表、详情（含预览地址）、删除 | Access                           | 保持保护                              |
| `/api/v1/artifacts/{id}/versions/{n}/share`   | PUT、DELETE | 分享、撤销                     | Access                           | 保持保护                              |
| `/api/v1/artifacts/{id}/versions/{n}/archive` | GET         | 用户下载原包                   | Access                           | 保持保护                              |

**给部署任务的 Access 改动清单**：在 `axp.akr.moe` 上新增 Bypass（Everyone）的自托管应用，路径精确为 `axp.akr.moe/share/artifacts` 和 `axp.akr.moe/preview/artifacts`（Access 的路径是前缀匹配）。不要放行 `/api/*`、`/remote/*` 以外的其他路径、上传或管理接口，也不要放行 `/artifacts`、`/share`、`/preview` 整段。

注意：任务描述原本希望只放行公开分享前缀。实测证明私有预览在 opaque-origin iframe 里拿不到 Access 的 Cookie，留在 Access 后面就无法加载任何相对资源，所以私有预览也需要放行 `/preview/artifacts/`；它只认短时 HMAC 能力，泄露的影响与一个 1 小时后自动失效的分享链接相同。若不接受这一点，替代方案是给 Access 的 Cookie 设 `SameSite=None`（会让 Cookie 出现在所有跨站请求里，CSRF 只靠上面的网关规则），或者改用独立域名；两者都不如现在的做法。

## 对象存储与部署

控制面的配置（`internal/config`）：`AXP_S3_ENDPOINT`（为空时 Artifact 关闭，接口返回 503 `ARTIFACTS_UNAVAILABLE`）、`AXP_S3_BUCKET`（默认 `axp-artifacts`）、`AXP_S3_REGION`（默认 `us-east-1`）、`AXP_S3_ACCESS_KEY_ID`、`AXP_S3_SECRET_ACCESS_KEY`。桶不存在时第一次使用时创建（外部 S3 的凭据没有建桶权限时，请预先建好）。

| 环境 | 服务                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 开发 | 开发基础设施（`deploy/k3s/dev`）里的 `s3`（SeaweedFS `mini`），控制面的开发默认值指向它                                                                                      |
| 生产 | 默认是命名空间 `axp` 里的 `s3`（SeaweedFS，卷 `objects`，`s3.axp.svc:8333`）；设了 `AXP_S3_ENDPOINT` 时改用外部 S3。见 [deploy/README.md](../../deploy/README.md#存储与备份) |

SeaweedFS 在同一个容器里还提供不鉴权的 filer、master、volume 等接口，所以网络策略只让 AXP 自己的命名空间连它：智能体和环境包的服务连不到。

## 验证

- `internal/artifacts/zip_test.go`：合法站点的文件列表；缺 `index.html`、`index.html` 在子目录、`..`、绝对路径、反斜杠、盘符、符号链接、设备文件、重复路径、`a//b`、文件数和体积超限。
- `internal/api/artifacts_test.go`（内存里的假 S3）：智能体发布到任务（时间线、列表、详情），预览下多级相对资源的 Content-Type 与沙箱头，伪造/过期能力 404，私有版本在分享前缀下 404；分享、重复分享、分享页与文件与原包、发新版本不影响旧分享、撤销后全部 404、再分享得到新令牌、删除清掉对象；远程电脑只能发到自己的任务、不能给别人的 artifact 发版本、必须带任务，智能体不能给电脑的 artifact 发版本；S3 写失败（424，对象清空，版本 failed，列表里没有）、声明与内容不符的 ZIP（422）、超大请求（413）。
- `internal/objects/s3_test.go`：设置 `AXP_TEST_S3_ENDPOINT` 等变量时连真实 S3。
- 开发环境里的端到端验证见 PR。
