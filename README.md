# eta

一个人机协作 agent:core 会话引擎 + Bun 服务 + Solid 前端 + Electrobun 桌面壳。

## 快速开始

```sh
bun install
bun run build:web   # 产出 packages/eta-client/dist
```

三种跑法,按你要什么挑:

| 命令 | 得到 |
| --- | --- |
| `bun run dev` | 只起 eta-server,`http://127.0.0.1:3000` 直接托管上面那份 dist |
| `bun run dev` + `bun run dev:web` | 前端热更新:vite :5173,`/api`、`/ws`、`/term` proxy 到 :3000 |
| `bun run dev:desk` | 桌面壳,一条命令:自己拉 vite、等它就绪、再开 Electrobun 窗口 |

桌面壳的 SDK 由本地 `electrobun` CLI 投影,第一次跑前先 `bun run --cwd packages/eta-desktop prepare:sdk`。
`bun run prod:desk` 在 macOS 出 `.app`,在 Windows 出 `eta-Setup.exe` 和更新包,产物在 `packages/eta-desktop/artifacts/`(不进 git)。
壳的窗口只在启动时认一次 vite;先开窗口再起 `dev:web` 的话,它会落到 `views://`(冷页面,无热更新),重开窗口即可。

监听默认 `127.0.0.1`;`ETA_HOST=0.0.0.0 bun run dev` 才放同 WiFi 的手机进来(远程场景自己打隧道指向 loopback)。

## 模型

按顺序往下落,前一个没有才用后一个:

1. 优先使用「设置 → 模型供应商」保存到 `~/.eta/config.json` 的 provider 和模型,由 eta 管理配置与选模、pi 提供供应商运行时（Codex 直接复用 pi 内置 provider 及认证流程）,按 `defaultModel: "providerId:modelId"` 选择默认模型,未指定则用第一个 provider 的第一个 model
2. 环境里有 `ANTHROPIC_API_KEY` → 内置 anthropic catalog,默认 `claude-sonnet-4-5`
3. 都没有 → faux 回声流,零配置也能把整条协议链路跑通

## 网络

在「设置 → 通用 → 网络」选择跟随系统（默认,优先使用环境代理）、手动 HTTP/HTTPS 代理或直连,配置保存到 `~/.eta/config.json` 的 `network`,重启后端或桌面应用后生效,暂不支持 PAC 和 SOCKS 代理。

## 包

| 包 | 作用 |
| --- | --- |
| `packages/eta-core` | 会话引擎(电池平铺在 `src/harness/`:lane/tree/loop/persona/goal/tasks/loops/btw/ask/memory/skills/compaction),外加 `wire.ts`:通道帧、`GuiOp`、`ControlOp` 全在这里定义一份 |
| `packages/eta-storage-sqlite` | sqlite 存储后端 |
| `packages/eta-server` | Bun HTTP+WS 托管 core:`/ws`(view/agent/dev 三通道帧)、`/term`(终端);`/api/{health,memory,personas,files,upload,settings,sessions,history,models,paste,search,git/status,git/diff,file,native/*}`;SPA 静态托管 |
| `packages/eta-client` | SolidJS + Vite + Tailwind v4 单页(硬朗石墨:零圆角,高饱和只留给语义状态);`@xterm/xterm` 终端、katex/shiki 渲染 |
| `packages/eta-i18n` | en / zh-CN 扁平 key 文案包(`keySeparator:false`) |
| `packages/eta-desktop` | Electrobun 壳:eta-server 以随机 loopback 端口跑在壳进程内,页面走 vite dev 或 `views://eta/`,再补上浏览器没有的两样——窗口装饰,和 `/api/native/*` 背后的原生能力(托盘、文件夹选择、导出) |

## 验证

```sh
bun run test        # core + storage + server + client
bun run typecheck   # 全部 TS 包,含桌面壳
bun run build:web
```

手测清单见 `GUI-PLAN.md`;规划中的东西在 `ETA-CORE-PLAN.md`。
