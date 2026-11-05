# 读网页与搜索

两个产品工具：`web_fetch` 读一个网页，返回 Markdown；`web_search` 搜索网页，返回排好序的结果。两者都在主 node 的进程里直接调用库（`@searxng-js/sex-scrape`、`sex-search`、`sex-searxng`、`sex-page`，0.1.1），不另起服务。代码在 `apps/eta/src/web/`。

## 为什么是会话工具

和 `open_pull_request` 一样，它们是 `sessionTools` 交给每个会话的工具，而不是 MCP 服务器：

- 要调用的是同一个进程里的库，不需要 MCP 客户端、端口或子进程来连。
- daemon 上的会话经 `tool.call` 拿到它们（产品工具的代理，见[机器与 daemon](machines.md)），抓取和搜索都在主 node 上发生；daemon 不需要装这些库，`bun build --compile` 出的单文件也不变。
- 读网页是每个智能体都该有的基本能力，所以默认就在，和任务、产物的工具一样。

## 开关和配置

| 主 node 参数          | 含义                                                                   |
| --------------------- | ---------------------------------------------------------------------- |
| （默认）              | 两个工具都在；`web_search` 用主 node 托管的 SearXNG                    |
| `--searxng-url <url>` | 用外部的 SearXNG（要开 `json` 格式）。`ETA_SEARXNG_URL` 同义，参数优先 |
| `--no-web`            | 两个工具都不加载                                                       |

`startHost` 默认不加载（测试起的 host 没有这两个工具），`main.ts` 把它打开，和 LLM 网关的做法一样。

## 参数为什么是 eta 自己写的

sex-scrape / sex-search 0.1.1 的 zod schema 描述已经是中性的说法，但工具的参数仍然用 eta 自己的 TypeBox 定义（描述借鉴 sex-lite 的 MCP 工具）：

- harness 用 TypeBox 校验参数（`defineTool`），sex 的是 zod，要转一道。
- sex 的 `ScrapeRequest` / `SearchRequest` 是 Firecrawl 的整套选项：`formats`、`actions`、`waitFor`、`headers`、`maxAge`、`parsers`、`proxy`、`scrapeOptions`……大半要浏览器、LLM 或缓存，在 eta 里只会得到 501；`headers`、`timeout` 这类也不该交给模型。给模型看的越少，它越少犯错，提示词也越短。
- eta 要的东西 sex 的 schema 里没有：`web_fetch` 的 `offset`（分段读），`web_search` 用 `timeRange` 枚举代替 Firecrawl 的 `tbs` 字符串，`limit` 和 `includeDomains` 的上限更小。

## web_fetch

- 参数：`url`；`onlyMainContent`（默认 true，Defuddle 提取正文；false 是整页）；`offset`（从 Markdown 的第几个字符开始，默认 0）。
- 结果：`Title:`、`URL:`（重定向之后的地址）、库给的 `Warning:`，然后是 Markdown。
- **长度**：一次最多 50KB（UTF-8 字节，和 `read` 工具一样），尽量在换行处断开，不拆代理对。没读完时末尾写明 `[Showing characters A-B of N. Call web_fetch with the same url and offset=B for the next part.]`，最后一段写 `This is the end of the page.`。
- **续读不重抓**：抓到的页面在内存里留 10 分钟（最多 16 页）。`offset > 0` 先用这份，保证各段来自同一份内容；`offset` 为 0 总是重新抓。
- **SSRF**：sex-egress 的防护保持开启：回环、私网、链路本地（含 `169.254.169.254`）、ULA 一律拒绝（`PRIVATE_NETWORK_BLOCKED`），DNS 校验后把连接固定到校验过的地址，每一跳重定向都再查一次。没有任何配置项能关掉它；要读本机或内网，智能体用 bash。
- 单页最大 10 MiB，默认 30 秒；PDF 也会转成 Markdown（unpdf）。不支持浏览器渲染和 LLM 格式。

## web_search

- 参数：`query`；`limit`（每个来源的条数，1–20，默认 5）；`sources`（`web`、`news`）；`includeDomains`（至多 10 个，每个是一次单独的查询）或 `excludeDomains`；`timeRange`（`day`、`week`、`month`、`year`）；`lang`。
- 结果：编号列表，每条是标题、URL、摘要；新闻另起一段，带日期；SearXNG 做不到的参数在 `Warning:` 里写明。
- 不顺带抓取结果页面：描述里让模型对需要的几个 URL 用 `web_fetch`，上下文只花在真要读的页面上。

## SearXNG

- **外部**：`--searxng-url`。主 node 只是去问它，不管它的配置。
- **托管**：没给地址时，`sex-searxng` 把 `@searxng-js/searxng` 的预编译 SearXNG 作为主 node 的子进程运行：第一次搜索时才启动（第一次要多等几秒），只监听回环，连续启动失败会冷却 30 秒；它盯着自己的 stdin 管道，主 node 退出（哪怕被 SIGKILL）它也跟着退出，主 node 正常关闭时 `close()` 停掉它。
- **平台**：预编译二进制只有 linux-x64（glibc ≥ 2.35）、darwin-arm64、win32-x64，随 `bun install` 作为可选依赖装上。其他平台（linux-arm64、musl、Intel Mac）不提供 `web_search`，启动时警告一次，提示用 `--searxng-url`；`web_fetch` 照常。`deploy/Dockerfile` 的 `oven/bun` 镜像是 Debian（glibc 2.36），x64 上可以托管；arm64 镜像要给外部地址。

## 代理

eta 的网络设置（`@eta/server` 的 `initializeNetwork`）把代理写进环境变量。抓取每次调用时读 `HTTPS_PROXY` / `HTTP_PROXY`，作为库的 `proxyUrl`；托管的 SearXNG 在第一次搜索时创建，拿到同一个代理（写进它的临时 settings.yml，文件 0600，起来后即删）。走代理时请求不能再固定到校验过的地址，主机名仍然先解析、校验一遍，防重绑定交给代理。

## 运行时

这些包的 `engines` 写的是 `node >= 24`，而仓库根的 `engines` 是 `node >= 22.12`。实际上它们只在主 node 里运行，主 node 永远是 Bun（`bun apps/eta/src/main.ts`，Docker 和桌面壳也一样），测试是 `bun --bun vitest`；daemon 不加载它们。所以：

- 不需要 Node 24，也不改根的 `engines`（那是给 Node 跑的工具链的，比如 eslint、knip）。
- 在 Bun 上，库的可选 peer 依赖都不用：请求用 Bun 的 `fetch`（不要 `undici`），Markdown 转 HTML 用 `Bun.markdown`（不要 `marked`），SearXNG 的代理配置用 `Bun.YAML`（不要 `yaml`）。所以 `apps/eta` 不声明它们。以后要在 Node 上跑主 node，得先补上这三个。

## 错误和日志

- 库的错误是 `AppError`（从 `@searxng-js/sex-scrape` 导入），主 node 自己的拒绝（offset 越界、没有 SearXNG）也用它，工具只有一种失败要描述。判断用 `AppError.isInstance(e)`，不用 `instanceof`：每个发布包里各打包了一份这个类。模型看到的是 `CODE: message`（例如 `PRIVATE_NETWORK_BLOCKED: ...`、`SEARCH_BACKEND_UNAVAILABLE: ...`），作为工具错误。
- 取消和超时：工具把会话的 `AbortSignal` 传给库。`search()` 等托管 SearXNG 启动时也看这个 signal 和请求的 `timeout`（sex-search 0.1.1 起），取消或超时立刻是 `TIMEOUT`（“... while waiting for SearXNG to start”），SearXNG 在后台接着启动，下一次搜索直接用。
- 日志：库自己不写 stdout/stderr，而是发到 `node:diagnostics_channel` 的 `searxng-js:sex:{scrape,search,searxng,page}`。主 node 订阅这几个频道，`warn` 和 `error` 进主 node 的 `warn`（`[eta] web: <包>: <消息> k=v`），`debug`、`info`（每次抓取、SearXNG 自己的输出）不记。

## 测试

`apps/eta/test/web.test.ts`：抓取用测试自己起的回环 fixture 站点（测试里才打开 `allowPrivateNetwork`，并验证默认会拒绝它），搜索用假的 SearXNG，外加一次经脚本模型在真会话上调用两个工具。访问外网和托管 SearXNG 的两个测试默认跳过，`ETA_WEB_LIVE=1` 才跑。
