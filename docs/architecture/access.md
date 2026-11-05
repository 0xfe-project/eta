# 访问控制

WebSocket 管道会在这台电脑上以运行 host 的用户身份执行命令、读写文件，所以它是**绝不能被偶然碰到**的东西。访问控制在 `apps/eta/src/access.ts`，作为传输层的 `authorize` 在任何路由和 WebSocket 升级**之前**运行。两道相互独立的检查。

## Origin 检查

只作用于 `/ws`。浏览器在 WebSocket 握手时附上页面的 origin，页面无法伪造，所以来自别的页面的握手就是某个随机网站想借用户的浏览器操作 host，一律 403。

- **没有 `Origin`** 的握手不是浏览器（脚本、daemon），通过这一道。
- 页面的 origin 等于它所请求的 origin（`Host` 头，加上反向代理给出的 `X-Forwarded-Proto`），或在 `--allow-origin` 里（可重复）。开发时页面由 vite 在另一个端口提供，所以 `bun run dev` 会把 vite 的地址传给 host。
- "它请求的 origin"只在不会被 DNS 重绑定欺骗时才被信任：攻击者的域名解析到 127.0.0.1，会把攻击者的页面变成"自己的 origin"。所以在**回环地址且没有令牌门**时，被请求的主机名也必须是回环地址。

## 令牌门

当给了 `--token-file`，**或** host 监听在回环以外的网卡（`--host 0.0.0.0` 等）时开启——因为此时任何能路由到这个端口的人都能用它。令牌文件不存在就在首次启动时创建（随机 24 字节，base64url；文件 0600，目录 0700），没给 `--token-file` 时默认是 `<数据目录>/access-token`。令牌不得短于 16 字符。

开启后，**除 `/up` 外**所有请求都需要令牌，两种方式：

- 脚本：`Authorization: Bearer <令牌>`。
- 手机 app：`X-Eta-Token: <令牌>`。它的运行时不让 WebSocket 握手带凭据类的头，所以用这个自定义头；比较方式与 bearer 相同。
- 浏览器：打开一次 `/?token=<令牌>`，host 回一个 303 重定向到去掉令牌的地址，并种下 cookie（`HttpOnly`、`SameSite=Strict`，https 下加 `Secure`，30 天）。cookie 里是令牌派生的哈希，不是令牌本身，泄漏 cookie 不等于泄漏令牌。令牌比较都是比较哈希，耗时不透露令牌的内容。`/ws` 不接受 `?token=`（socket 不能跟随重定向），它带 cookie、bearer 或 `X-Eta-Token`。

这是上游开发网关（`scripts/dev/gateway.ts`）的令牌门搬进了 host。

## 能力路由

有些页面自带凭据，不能靠 cookie：

- `/preview/<capability>/…`：artifact 在沙箱 iframe 里预览，沙箱 iframe 是不透明 origin，不发 cookie，所以**地址本身就是凭据**：`<版本>.<过期>.<签名>`，用只在 host 上的密钥（`artifacts/.preview-key`）签名，只能打开一个版本，一小时后失效。
- `/share/<token>/…`：公开分享，给不是用户的人，路径里是一个秘密令牌；取消分享后永久失效，再分享会生成新令牌。

- `/mcp/oauth/callback`：MCP 服务器 OAuth 登录结束后，浏览器从授权方跳回来，不带我们的 cookie。凭据是 URL 里的 `state`：只有宿主自己发起、还在等待的登录才认，其余（没有 `state`、`state` 不对、已用过）只回一页提示，什么都不改变；它只放行这一个路径的 GET，见 [MCP](mcp.md)。
- `/github/manifest/callback`、`/github/authorization/callback`：GitHub App 创建完成、用户授权完成后，浏览器从 github.com 跳回来，同样不带 cookie。凭据是宿主发出的一次性 `state`（创建一小时、授权 15 分钟有效，用一次就作废）：没有、不对、已用过或过期的，什么都不改变，只重定向回“设置 → 连接”并带上原因。装完 App 时 GitHub 带着 `code` 和 `setup_action` 回来、不带 `state`，这一种还要求授权的账号能访问这个 App 的某个安装，且个人 App 只认所有者本人。只放行这两个精确路径的 GET，见 [GitHub](github.md)。host 没加载 GitHub（默认，见下）时这两条路径依旧免令牌，只是没人应答，归页面。

这几类**只读**（GET/HEAD）免令牌门，不为别的原因。其余一切，包括应用自己的 `/artifacts/<id>/<版本>/archive.zip` 下载，仍在令牌门后。预览与分享的每个文件都带 `Content-Security-Policy: sandbox`（不含 `allow-same-origin`），所以别人的 HTML 在不透明 origin 里运行，读不到 cookie 与存储，也不能以用户身份调用 host；另有 `Referrer-Policy: no-referrer`。对无效的能力或令牌，不说明为什么无效。

## daemon 的入口

`/machines/enroll` 与 `/machines/connect` 同样不经这两道检查：daemon 没有 cookie，也不发 origin。它们各自校验自己携带的东西（安装码、设备凭据），见[机器与 daemon](machines.md)。

## 放在反向代理后面

代理需要：升级 WebSocket（`/ws`、`/machines/connect`）、传 `Host` 与 `X-Forwarded-Proto`。如果代理改写了 `Host`，把页面的外部地址加进 `--allow-origin`（如 `--allow-origin https://eta.example.com`）。令牌门由 host 自己管，代理处不必重复，但终止 TLS 后别让 host 直接暴露在公网。
