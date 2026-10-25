# @eta/desktop

eta 的桌面壳。打开应用就启动 host（`apps/eta`，一个 Bun 进程，页面、数据库和 WebSocket
都在它的一个端口后面），窗口指向它；关掉窗口就把 host 停掉。

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
bun run --cwd apps/web build
hutch run --cwd apps/desktop build
```

数据目录是 `~/.eta`，和命令行启动的 host 共用一份。
