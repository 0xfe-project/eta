# eta

一个人机协作 agent 的骨架:core 会话引擎 + Bun 服务 + Web 前端。

## 快速开始

```sh
bun install
bun run build:web   # 产出 packages/eta-web/dist
bun run dev         # 起 eta-server,http://localhost:3000 直接托管前端
```

开发前端时两条命令:`bun run dev`(server :3000)+ `bun run dev:web`(vite :5173,`/ws`、`/api` 自动 proxy)。

手机访问:server 默认绑 `0.0.0.0`,同 WiFi 下开 `http://<本机IP>:3000` 即可(远程场景自己打隧道指向 loopback)。

模型:环境里有 `ANTHROPIC_API_KEY` 就走真 anthropic(`claude-sonnet-4-5`);没有则用内置 faux provider(回声流,协议链路完整)。

## 包

| 包 | 作用 |
| --- | --- |
| `packages/eta-core` | 会话引擎(电池平铺在 `src/harness/`):lane/tree/loop/persona/goal/tasks/loops/btw/ask/memory,单一 barrel `@eta/core` |
| `packages/eta-sqlite` | sqlite 存储后端 |
| `packages/eta-server` | Bun HTTP+WS 托管 core:三通道帧(view/agent/dev)+ GuiOps + `session.*` 控制消息;`/api/{personas,files,file,paste,search,sessions,health}`;SPA 静态托管 |
| `packages/eta-web` | React 19 + Vite + wouter + Tailwind v4 单页(硬朗石墨:零圆角,高饱和只留给语义状态) |
| `packages/eta-i18n` | en / zh-CN 扁平 key 文案包(`keySeparator:false`) |

## 验证

```sh
bun run test        # core + sqlite + server + web
bun run typecheck   # 全部 TS 包
bun run build:web
```

手测清单见 `GUI-PLAN.md` 末尾。
