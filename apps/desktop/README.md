# @eta/desktop

eta 的桌面壳。host 跑在哪里由用户决定：首次打开时在壳自己的页面上选，之后在设置 → 连接方式里改。

- **本机**：壳启动 host（`apps/eta`，一个 Bun 进程，页面、数据库和 WebSocket 都在它的
  一个端口后面），窗口指向它；退出应用就把 host 停掉。跑的是用户目录里的
  `~/.eta/desktop/host/eta-host`，第一次启动从包里复制过去，之后从设置里的按钮升级，壳是它的服务
  （`src/bun/service.ts`）。本机已经有 host 在用 `~/.eta`（比如命令行装的服务）时，直接打开那一个，
  不再启动第二个。细节见 `docs/release.md` 的「桌面应用」。
- **远程**：不启动本机 host，窗口直接加载远程 host 的页面。

两种模式的数据互相独立，切换不迁移，本机数据一直留在 `~/.eta`。

前端打过包（`apps/web/dist` 存在）时，host 用 `--web-dir` 自己托管页面，窗口打开的就是
产品本身。没打包时 host 只提供 socket，窗口提示先构建，页面仍由 `bun run dev` 的 vite
在 `http://127.0.0.1:3000` 提供。

## 开发

需要 [Hutch](https://hutch.blackboard.sh)（`bunx electrobun init` 会装好）：

```sh
bun run --cwd apps/desktop dev
```

这条命令启动 host、Vite 和桌面窗口；窗口加载 Vite 的开发页，并把 `/ws` 代理到同一个 host。
只调 Web 界面时，根目录的 `bun run dev` 不会打开桌面窗口。

## 打包

```sh
bun run --cwd apps/desktop package
```

这条命令就是 `hutch run build`，产物在 `artifacts/`。安装包里没有 host：选“在这台电脑上运行”时，
应用从 Release 下载它能跑的最新 host 到 `~/.eta/desktop/host/`，之后从那里运行、在设置里升级
（`src/bun/download.ts`，`docs/release.md` 的“桌面应用”）。下载的仓库在构建时由 `ETA_HOST_UPSTREAM`
写进应用，没写就是 `0xfe-project/eta`；运行时 `ETA_RELEASES_URL` 可以换掉它。删掉那个目录，下次
选本机会重新下载。

安装包单独发版：打 `desktop-v*` tag，CI 在各平台自己的 runner 上打（`.github/workflows/release-desktop.yml`），
打完用 `scripts/try-app.ts` 装上启动一次。版本号来自 tag，本地打包取 `package.json` 的 `version`
（`src/version.ts`）。没有签名，放行方式见 `docs/release.md`。

应用自己的更新：构建时给 `ETA_DESKTOP_UPDATE_URL`（能匿名读的静态地址），设置 → 更新里就有“桌面端”一节，
检查、下载、重启都由用户按（`src/bun/update.ts`）。没给就没有这一节。

`electrobun dev` 的开发构建不下载，和开发时一样往上找 checkout 运行 host。

数据目录是 `~/.eta`，和命令行启动的 host 共用一份。

## 连接方式

选择存在用户目录的 `connection.json`（0600，所在目录 0700）：Linux 是
`~/.local/share/dev.eta.desktop/stable/`，macOS 是 `~/Library/Application Support/dev.eta.desktop/stable/`，
Windows 是 `%LOCALAPPDATA%\dev.eta.desktop\stable\`。里面有远程 host 的 token，不进日志，也不给任何页面。
删掉这个文件，下次打开会重新询问。

远程连接用手机端同款的 `eta://connect?…` 链接（host 的设置 → 机器 → 连接手机），或手动填地址和
token。连接前先探测：`/up` 回 `ok`，再带 token 取 `/`。每次启动都走一次 `/?token=…`，host 换成
cookie 并重定向，所以地址栏不留 token，cookie 过期也不用重新登录。

运行中壳每 5 秒看一次 `/upgrade/status`：连续 30 秒没有回应就换成壳自己的失败页，host 恢复后自动
回去；token 失效立刻提示；这个 host 正在升级时宽限 10 分钟，让页面自己等重启。

原生桥只接受窗口当前页面的 origin，能力和本机模式一样。HTTPS 页面访问不了 `http://127.0.0.1`
（WebKit 按混合内容拦截），所以 preload 把这类请求转到 Electrobun 的原生消息通道，由壳发给同一个
桥（`src/bun/preload.ts`）。

设置里的入口只是请壳打开它自己的页面，页面本身不接触连接配置。连接到旧版本的 host 时页面里没有这个
入口：连得上就没有地方切换，要删掉 `connection.json`。
