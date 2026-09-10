# 桌面版方案（Electrobun）

状态：**方案，未实施**。读码参考是 `pibun/`（khairold/pibun，Pi coding agent 的桌面 GUI，electrobun 1.16.0）里已经跑通的那套壳。
本文只讲两件事：pibun 怎么做的、eta 照搬时要改哪几处。

---

## 1. pibun 的 electrobun 实现（读码结论）

### 1.1 拓扑

```
Electrobun App（单一 Bun 进程）
├─ 主进程 src/bun/index.ts
│   ├─ 直接 import createServer → 同进程内嵌 HTTP+WS，port: 0 让 OS 分配
│   ├─ BrowserWindow.loadURL("http://127.0.0.1:<port>")
│   └─ 原生能力：菜单 / 右键菜单 / 文件对话框 / 托盘 / 通知 / Updater
└─ 系统 webview（WKWebView / WebView2 / WebKitGTK，不塞 Chromium）
    └─ 加载内嵌 server 的静态 SPA，业务流量全走 WebSocket
```

两条决定性选择（`pibun/CLAUDE.md` 决策 #3 / #4）：

- **server 同进程内嵌**，不 fork 子进程：`createServer` / rpcManager 直接 import，省掉进程管理和端口协商。
- **原生事件走 WS push，不用 electrobun 的 view 端 IPC**：菜单点击 → `broadcastPush(connections, "menu.action", {...})`。好处是 web 端零 electrobun 依赖，浏览器模式和桌面模式是同一份前端代码。

### 1.2 文件清单（`pibun/apps/desktop/`）

| 文件 | 职责 |
| --- | --- |
| `electrobun.config.ts` | 包名/标识/版本、bun 入口、`copy` 指令、签名与公证、entitlements、preBuild、`release.baseUrl`、`exitOnLastWindowClosed: false` |
| `src/bun/index.ts` | 启动编排 + 生命周期 + 导航拦截 + 菜单分发（约 700 行，一个文件） |
| `src/bun/menu.ts` | action 常量表 + `buildMenuConfig()` + `createMenuClickHandler()` |
| `src/bun/windowState.ts` | `~/.pibun/window-state.json`，500ms 防抖保存、close 时 flush、读档校验兜底 |
| `src/bun/tray.ts` | 托盘图标 + 动态菜单，手写 PNG 编码生成状态点（不引图像库） |
| `src/bun/notifications.ts` | focus/blur 跟踪 + 回合结束通知 |
| `src/bun/updater.ts` | `Updater.checkForUpdate/downloadUpdate/applyUpdate` + 状态经 WS 转给前端 |
| `scripts/prebuild.ts` | 先 `turbo build --filter=@pibun/web`，校验 `dist/index.html` 存在 |

### 1.3 启动时序（`src/bun/index.ts` bootstrap）

1. `resolveShellEnv()` — 从 Finder/Dock 启动的 macOS 应用 PATH 是残的（没有 nvm/brew），跑一次 login shell 把真实 env 拿回来。**必须在起 server 之前。**
2. `loadWindowState()` 取上次的 x/y/w/h。
3. 定 URL：`PIBUN_DEV_URL`/`PIBUN_DEV=1` → 指向 Vite（不启内嵌 server）；否则 `createServer({ port: 0, hostname: "localhost", staticDir: <bundle>/web-dist, hooks })`。
4. `waitForReady(url + "/health")` — 30 次 × 200ms 轮询，超时 `exit(1)`。
5. `new BrowserWindow({ title, url, frame })`。
6. `wireWindowLifecycle()` — `resize`/`move` 防抖存窗口；`close` 先 `getFrame()` 定稿再走优雅退出。
7. `wireNavigationRules()` — 三层：`webview.setNavigationRules(["^*", origin+"/*", "views://*"])` 原生拦；`will-navigate` 拦外链转系统浏览器；`new-window-open` 接 Cmd+点击 / `target="_blank"`。
8. `ApplicationMenu.setApplicationMenu(buildMenuConfig())` + `Electrobun.events.on("application-menu-clicked", …)`。
9. 托盘、通知、Updater 各自 `init*(server, …)`，都返回 cleanup。
10. `SIGINT`/`SIGTERM` → 同一个 `shutdown()`：停 server → 杀子进程 → `process.exit(0)`。
    配合 `exitOnLastWindowClosed: false`，否则 electrobun 会在异步清理完成前强杀。

### 1.4 原生 → 前端的事件通道

| 触发点 | 路径 |
| --- | --- |
| 菜单/托盘点击 | 主进程 → `broadcastPush("menu.action", { action, data })` → 前端 dispatch |
| 前端要原生对话框 | WS 请求 → server `hooks.onOpenFolderDialog()` → `Utils.openFileDialog()` → 返回值原路回去 |
| 前端要右键菜单 | WS 请求 → `hooks.onShowContextMenu(items)` → `ContextMenu.showContextMenu()` → `context-menu-clicked` 事件 → `broadcastPush("context-menu.action")` |
| 前端要存导出文件 | `hooks.onSaveExportFile(content, filename)` → 选目录 → `Bun.write` |
| 前端改标题 | `hooks.onSetWindowTitle` → `window.setTitle` |
| 更新状态 | `Updater` 事件 → `broadcastPush("app.update", …)` |

原生自己吞掉的：`file.close-window`、`view.zoom-*`（`getPageZoom`/`setPageZoom`）、about/hide/quit（`role` 交给系统）。
动态项用前缀编码索引：`file.open-recent:3` → 主进程查 `recentProjectCwds[3]` 再 push 给前端。

### 1.5 值得抄的细节

- 窗口状态：`MIN_WIDTH/HEIGHT` 夹逼 + JSON 坏了就回落默认值，别让用户打不开窗口。
- 托盘状态图标：`agent_start/agent_end/error` 聚合出 idle/working/error，只在状态真变时 `setImage`（防闪）。
- Updater：`Updater.localInfo.channel() === "dev"` 直接跳过；启动 10s 后首查、每 4h 静默查、菜单手动查非静默；`applyUpdate()` 前 `sleep(500ms)` 让 push 先飞出去。
- 签名：`electrobun.config.ts` 里按环境变量决定 `codesign/notarize`，entitlements 显式列 `network.client/server` + `files.user-selected.read-write`。
- 分发：Linux/Windows 用 electrobun 自带的自解压包（不是 AppImage/NSIS），Linux 需 `libwebkit2gtk-4.1-dev`，Windows 需 WebView2，两者都不能跨平台交叉编。

---

## 2. eta 侧现状与接入点

对着 `packages/eta-server/src/server.ts` 逐条核过：

| pibun 需要的东西 | eta 现状 |
| --- | --- |
| 内嵌 server | `startServer({ port, hostname, cwd, webDist, configPath, dataDir })` → `{ host, port, close() }`，直接可用 |
| 静态托管 SPA | 已内置（`webDist` 默认 `../../eta-web/dist`，带 SPA fallback） |
| 健康检查 | `/api/health` → `{ok:true}`，现成 |
| 前端连后端 | eta-web 走相对路径 `/ws`、`/api`（vite 已 proxy），webview 里同源，前端零改动 |
| 终端 | `/term` 用 `Bun.spawn({ terminal: true })`，**没有第三方 pty dylib 要拷进 bundle**（pibun 得拷 `bun-pty/rust-pty`），这块我们更简单 |

需要动的只有两处：

1. **eta-server 没有 hooks 机制**（pibun 的 `createServer({ hooks })`）。菜单动作、文件对话框要进前端，得补一条服务端→客户端的 push 消息：

   ```ts
   // protocol.ts
   | { type: "native"; kind: "menu" | "tray" | "update"; action: string; data?: unknown }
   ```
   加进 `ServerMessage`，`startServer` 返回值带一个 `push(msg)`，`EtaServerOptions` 加可选 `native?: { openFolderDialog?, saveFile?, showContextMenu? }`。
   eta-web 那边在 `ServerMessage` 的分发处（`reduceEtaState` 那一层）加一条 case，把 action 映射到已有命令（新会话 / abort / 切 sidebar / focus session）。浏览器收到就忽略 → 两端仍是同一份代码。

2. **绑定地址**：server 默认 `0.0.0.0`（为了让手机同 WiFi 访问）。桌面壳要显式传 `hostname: "127.0.0.1"`，不把局域网暴露出去。
   另外 `Bun.serve` 开了 `reusePort: true` — 桌面端用 `port: 0` 不受影响，但要知道两个进程抢 3000 时不是报错而是静默负载均衡。

---

## 3. eta-desktop 落地

```
packages/eta-desktop/
├── package.json            # deps: electrobun；scripts: dev/build/typecheck
├── electrobun.config.ts    # 入口 src/bun/index.ts、copy web dist、签名、release
├── icon.iconset/           # mac 图标 + 16x16@2x 当托盘图
└── src/bun/
    ├── index.ts            # bootstrap：内嵌 server → /api/health → BrowserWindow → 生命周期
    ├── menu.ts             # eta 版 action 表（新会话/abort/compact/切 persona/缩放）
    └── windowState.ts      # ~/.eta/window-state.json（~/.eta 目录已在用）
```

`copy` 只要一条：`"../eta-web/dist": "web-dist"`；主进程用 `resolve(import.meta.dir, "../web-dist")` 找静态目录（bundle 里 bun 代码在 `Resources/app/bun/`，兄弟目录即 `web-dist`）。

### P0 — 壳能跑（半天）

`package.json` + `electrobun.config.ts` + `index.ts`（内嵌 server、health 轮询、窗口、标准 `role` 菜单、优雅退出）。
验收：

```sh
bun run build:web
cd packages/eta-desktop && bun install && bunx electrobun dev
```

出窗口 → 能聊、能开终端 tab → Cmd+Q 后 `pgrep -fl eta` 没有残留进程。
这一步**不动 eta-server 一行代码**。

### P1 — 原生桥

- protocol/ServerMessage 加 `native` push + `EtaServerOptions.native` hooks；eta-web 加一条分发 case。
- 菜单接上：新会话（Cmd+N）、abort（Cmd+.）、切 sidebar（Cmd+B）、Open Folder…（`Utils.openFileDialog` 结果喂给 `session.create` 的 cwd）、缩放三件。
- 窗口状态持久化 + 导航三层拦截（聊天里点 markdown 链接不能把整个 app 导航走）。
- dev 模式：`ETA_DESKTOP_URL=http://localhost:5173 bunx electrobun dev`，指向 vite 热更新。

### P2 — 托盘 + 通知

- working/idle 从 `host` 的 view 帧或 `sidebar().badges` 聚合（pibun 是从 pi 的 `agent_start/agent_end` 拿的，等价物我们有）。
- 回合结束且窗口失焦 → `Utils.showNotification`；沿用 pibun 的 5s 阈值，短回合别吵。

### P3 — 分发

prebuild（先 build eta-web 并校验 `dist/index.html`）、图标、codesign + notarize + entitlements、Updater（要先有 release 渠道，eta 目前没有 → 可先搁置）、Linux/Windows 各一台实测。

---

## 4. 待验证（读码确认不了，得跑）

1. WKWebView 里 xterm.js / shiki / katex 的渲染与滚动表现；`navigator.clipboard.read()`（图片粘贴）在 WKWebView 里可能因无用户手势被挡。
2. `<a download>` / blob 下载在 webview 里通常不生效 → 下载类操作必须走原生 hook（pibun 的 `onSaveExportFile` 就是这个原因）。
3. `input[type=file]` 上传在 electrobun webview 是否可用（对应 `/api/upload`）。
4. `reusePort: true` 与 `port: 0` 的组合行为。
5. electrobun 1.16 的 `BrowserWindow` 是否支持 `minWidth/minHeight`、自定义图标 —— 本地 pibun 的 `node_modules` 没装，API 以包里的 `.d.ts` 为准，别照我这份抄死。
6. `host.close()` 是否足够干净（pibun 是显式 停 server → 杀子进程 → exit）。
7. Linux 的 `libwebkit2gtk-4.1-dev` 装了没。
