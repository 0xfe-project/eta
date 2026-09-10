# 桌面化：后端待改清单（交给用户）

前端已就位（`packages/eta-client`，typecheck + 54 test + vite build 全绿）。
**后端我一行没改**，下面的东西你改；改完重启我，我照本文契约写 `packages/eta-desktop`。
（背景与设计取舍见 `docs/DESKTOP.md`。）

## 0. 已定契约（前端按这个写的，改了就对不上）

桌面壳在 webview 里、任何我们的脚本之前注入：

```js
window.__ETA_HOST__ = {
	apiBase: "http://127.0.0.1:<启动时随机端口>",
	wsBase: "ws://127.0.0.1:<同一个端口>",   // 省略时前端从 apiBase 推
	token: "<每次启动随机 hex>",
	platform: "darwin",                      // 可选
	appVersion: "0.1.0",                     // 可选
};
```

`packages/eta-client/src/lib/host.ts` 读它：

- 有 `__ETA_HOST__.apiBase` → 桌面模式，所有 `/api` 走绝对 URL，`Authorization: Bearer <token>`；WS URL 用 `?token=<token>`（WebSocket 带不了 header，所以两条路都得支持）。
- 没有 → 浏览器模式，相对路径 + 无 token，**行为和今天逐字节相同**（连 `fetch(url)` 的参数个数都没变，`test/timeline.test.tsx` 就是这么抓的）。

已加的协议消息（我改的，只有类型，无行为）：`packages/eta-core/src/wire.ts` 的 `ServerMessage` 多一条

```ts
| { type: "native"; kind: "menu" | "tray" | "update"; action: string; data?: unknown }
```

前端行为：`eta-store` 收到它 → 派发 `eta:native` window 事件（和现有 `eta:view`/`eta:personas` 同一手法）→ `app-shell` 响应 `view.toggle-sidebar` / `view.toggle-panel` / `view.command-palette` / `nav.new-session`。reducer 不认它，状态零变化（`test/native.test.ts` 有断言）。
浏览器里想手测：devtools 控制台 `window.__etaNative({kind:"menu",action:"view.toggle-sidebar"})`。

## 1. `packages/eta-server/src/protocol.ts`：加同一条消息

它的 `ServerMessage` 是自己一份（不走 `@eta/core`），照抄上面那行。不加的话 `push()` 传不出去。

## 2. `startServer` 的四个新选项 + 一个返回值

```ts
export interface NativeHandlers {
	folderDialog(input: { startingFolder?: string }): Promise<string | null>;
	saveFile(input: { content: string; filename: string }): Promise<string | null>;
	/** 立刻返回，点击结果由 main 调 push() 回报 */
	contextMenu(input: { items: unknown[] }): void;
}

export interface EtaServerOptions {
	/* 已有：port hostname cwd webDist configPath dataDir */
	corsOrigins?: string[];   // 例：["views://eta", "http://localhost:5173"]
	authToken?: string;       // 桌面壳注入；不设 = 不校验（dev:web、手机访问照旧）
	native?: NativeHandlers;  // 给了才注册 /api/native/*
	reusePort?: boolean;      // 默认保持 true；桌面壳会传 false
}

export interface EtaServer {
	host: Host;
	port: number;
	push(message: ServerMessage): void;   // 新增：向所有 /ws 连接广播
	close(): void;
}
```

## 3. CORS + Origin/token 校验

`views://eta`（或 `http://localhost:5173`）里的页面打到 `http://127.0.0.1:<口>` 是跨源，必须处理；`/ws`、`/term` 没有 CORS，得自己查 Origin，否则任何本地网页都能连进来把会话读走。

```ts
const allowed = new Set(options.corsOrigins ?? []);
const cors = (origin: string | null): Record<string, string> =>
	origin !== null && allowed.has(origin)
		? {
				"access-control-allow-origin": origin,
				vary: "origin",
				"access-control-allow-headers": "content-type, authorization",
				"access-control-allow-methods": "GET,POST,OPTIONS",
				"access-control-max-age": "600",
			}
		: { vary: "origin" };
```

- `OPTIONS` 直接在 `fetch` 最前面 `return new Response(null, { status: 204, headers: cors(new URL(request.url ... ).searchParams...) })` —— 从 `request.headers.get("origin")` 取。
- 所有 `/api/*` 的 Response 合上 `cors(origin)`。
- `srv.upgrade` 之前：`origin` 不在白名单 → 403；`options.authToken !== undefined && url.searchParams.get("token") !== options.authToken` → 401。
- `/api/*` 在非 GET 时（或全部）校验 `request.headers.get("authorization") === \`Bearer ${options.authToken}\``，`authToken` 未设则跳过。
- 静态 SPA 那段（`webDist`）不用管 CORS。

## 4. 四个原生端点（只在传了 `native` 时注册）

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/api/native/info` | — | `{isDesktop:true, platform, appVersion}` |
| POST | `/api/native/folder-dialog` | `{startingFolder?}` | `{path: string \| null}` |
| POST | `/api/native/save-file` | `{content, filename}` | `{path: string \| null}` |
| POST | `/api/native/context-menu` | `{items}` | `202`，点击结果走 `push({type:"native",kind:"menu",action,data})` |

前端已经有 `nativeInfo()` / `pickFolder()`（`src/lib/native.ts`），新会话页的 cwd 选择器接上就能用。

## 5. pty 清理（会留孤儿的真隐患）

`TermRegistry.kill` 只在 ws 的 `close`/`message` 里调。桌面版退出时走 `server.close()` → `Bun.serve.stop()`，那些 `Bun.spawn({terminal:true})` 的 shell 不保证被杀，`~/.eta` 里会话能恢复，但进程表里会多几个 zsh。

```ts
class TermRegistry {
	private readonly live = new Set<ShellHandle>();
	// start 时 live.add(handle)，proc.exited 里 live.delete(handle)
	killAll(): void {
		for (const shell of this.live) {
			shell.alive = false;
			try { shell.proc.kill(); } catch { /* 已经没了 */ }
		}
		this.live.clear();
	}
}
```

`EtaServer.close()` 里在 `host.close()` 之前调 `terms.killAll()`。

## 6. 包切换（你什么时候觉得 eta-client 够用了再做）

- 根 `package.json`：`build:web` / `dev:web` / `typecheck` / `test` 里的 `eta-web` → `eta-client`。
- `eta-server` 默认 `webDist`：`../../eta-web/dist` → `../../eta-client/dist`。
- 然后删 `packages/eta-web`。**我现在保留着它**，所以两条 `dev` 都能跑；eta-client 是它的副本 + 这次改动，差异文件：
  - 新增 `src/lib/host.ts`（宿主/URL/token）、`src/lib/native.ts`（原生动作总线）
  - 改 `src/lib/eta-store.ts`（WS URL 走 `wsUrl()`+`withToken()`；native 帧 → `eta:native`）
  - 改 `src/features/sessions/terminal-host.tsx`（`/term` URL 同上）
  - 改 `src/app/app-shell.tsx`（监听 4 个菜单动作）
  - 9 个文件里 22 处 `fetch(` → `apiFetch(`，并加一行 import
  - `package.json` 名字 `@eta/web` → `@eta/client`
  - 新测试 `test/native.test.ts`（3 条）

## 7. 我重启后接着做的事

1. 读本文 + `docs/DESKTOP.md`，按 §0 的契约写 `packages/eta-desktop`（`hutch.config.ts` + `electrobun.config.ts`：`mainProcess: "bun"`、`copy: {"../eta-client/dist/index.html": "views/eta/index.html", "../eta-client/dist/assets": "views/eta/assets"}`）。
2. P0：30 行壳验三件事——views:// 能不能连 `ws://127.0.0.1`、`views://eta` 作为 Origin 的确切值、preload 注入 `__ETA_HOST__` 的时序（可能要启动时把 preload 写成临时文件）。不通就退回"prod 也直接 load `http://127.0.0.1:<口>`"。
3. P1：内嵌 `startServer({port:0, hostname:"127.0.0.1", reusePort:false, authToken, native, corsOrigins:["views://eta","http://localhost:5173"]})` + `/api/health` 轮询 + `BrowserWindow` + 优雅退出。
4. P2：`menu.ts`（action 常量表与 `src/lib/native.ts` 的 `NativeActions` 一一对应）+ `windowState.ts`（`~/.eta/window-state.json`）。

验证命令：

```sh
bun run --cwd packages/eta-client typecheck && bun run --cwd packages/eta-client test
bun run --cwd packages/eta-server typecheck
```
