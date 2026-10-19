# eta

一个人用来指挥多个智能体的工作台。服务端是**一个 Bun 进程**：Web、产品数据（SQLite）、会话的运行和模型凭据都在里面。其他电脑上可以跑精简的 daemon，让会话在那里运行；记忆是一个可选的边车。

```text
apps/
  eta/       host：一个 Bun 进程，WebSocket 管道 + cordis 插件 + SQLite（主 node）
  daemon/    eta-daemon：别的机器上的精简节点，反向连回主 node，只跑会话
  web/       React 界面，通过那条 WebSocket 读写
  memory/    Python 边车（mem0 + PostgreSQL/pgvector），可选
packages/
  llm-gateway  Go 网关（嵌入 CLIProxyAPI），编成 c-shared 库由 host 加载
  eta-*      上游 eta 的内核、harness、服务端地板、SSH 与 git 插件
  client-wire-proto、client-contracts   线上的帧与产品 target 的类型
deploy/      Dockerfile、memory.Dockerfile、compose.yaml
docs/architecture/   架构说明
```

架构说明（中文）：

- [总览](docs/architecture/overview.md)：进程、分层、代码布局
- [线协议与 target](docs/architecture/wire-protocol.md)：WebSocket 管道、帧、各 target 与 action
- [产品模型](docs/architecture/product-model.md)：智能体、machine、project、对话、主理人、唤醒规则
- [数据](docs/architecture/data.md)：SQLite 与迁移、会话文件、数据目录布局
- [机器与 daemon](docs/architecture/machines.md)：配对、epoch、模型与工具的代理、远端会话
- [访问控制](docs/architecture/access.md)：Origin 检查、令牌门、能力路由
- [LLM 网关](docs/architecture/llm-gateway.md)：订阅账号（Codex、Grok）与 Gemini key，CLIProxyAPI 经 c-shared 与 bun:ffi 嵌入
- [记忆](docs/architecture/memory.md)：边车、身份头、host 如何调用它
- [任务](docs/architecture/tasks.md)：智能体提出、用户确认、同一个智能体在全新会话里执行
- [任务、产物与定时任务](docs/architecture/tasks-artifacts-routines.md)

界面约定见 [DESIGN.md](DESIGN.md) 与 [apps/web/AGENTS.md](apps/web/AGENTS.md)。

## 环境与初始化

需要 Bun 1.4.3（各包的类型检查用它自带的 `bun check`）、uv（Python 3.13，uv 会按 `.python-version` 自动获取）和 Go（LLM 网关；`go.mod` 要求的版本由 `GOTOOLCHAIN=auto` 自动获取，cgo 需要 gcc）。不需要 Docker、数据库或任何外部服务。没有 Go 时 host 仍能运行，只是没有订阅账号与 Gemini key。

```sh
bun run setup     # bun install + uv sync（记忆边车的 Python 依赖）+ 构建 LLM 网关库（首次约两分钟）
bun run dev       # host 与 web 开发服务器
bun run check     # 提交前的全部检查
```

`bun run dev` 同时启动 host 和 vite：

- Web：http://127.0.0.1:3000（`ETA_WEB_PORT` 改端口）
- host：http://127.0.0.1:8787（`ETA_PORT` 改端口），数据在 `~/.eta/`（和装好之后是同一份）；vite 把 `/ws` 代理给它，host 以 `--allow-origin` 放行 vite 的地址

打开 Web 后，先在设置的"模型服务"里添加模型服务（填 API key；或在"订阅与密钥"里用设备码绑定 Codex、Grok 订阅，或填 Google AI Studio 的 key），再新建智能体与对话。

`bun run check` 等于 `dprint check`、`bun run lint:repo`（根目录 eslint）和 `turbo run build typecheck lint test knip`。`bun run format` 用 dprint 格式化。CI 与 pre-commit 钩子跑的是同一组检查，turbo 结果走远程缓存。

## 生产启动

先构建 Web，再让 host 提供它：

```sh
bun run --cwd apps/web build
HOME=/var/lib/eta bun apps/eta/src/main.ts --web-dir apps/web/dist --host 0.0.0.0 --port 8787
```

数据目录固定是 `$HOME/.eta`，没有开关：换位置就换 `HOME`（systemd 里是 `Environment=HOME=/var/lib/eta`）。

host 的 flag（`apps/eta/src/main.ts`）：

| flag                  | 含义                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `--port <n>`          | 端口，默认 `8787`（0 表示任意空闲端口）                                                                 |
| `--host <addr>`       | 监听的网卡，默认 `127.0.0.1`。**监听回环以外的地址会自动开启令牌门**                                    |
| `--web-dir <dir>`     | 构建好的 Web（含 `index.html`）。不给则只提供管道，不提供页面                                           |
| `--token-file <path>` | 开启令牌门并指定令牌文件（不存在时创建，权限 0600）。监听非回环地址而没给时用 `<数据目录>/access-token` |
| `--allow-origin <o>`  | 额外允许打开 WebSocket 的页面 origin，可重复。放在改写了 `Host` 的反向代理后面时填页面的外部地址        |
| `--memory-url <url>`  | 记忆边车的地址，也可用环境变量 `ETA_MEMORY_URL`（flag 优先）。不给则没有记忆                            |
| `--no-llm`            | 不加载 LLM 网关（没有订阅账号与 Gemini key）                                                            |

首次访问带令牌的 host：在浏览器打开 `http://host:8787/?token=<令牌>` 一次，之后用 cookie；脚本用 `Authorization: Bearer <令牌>`。`/up` 是健康检查，不需要令牌。细节见[访问控制](docs/architecture/access.md)。

### Docker

```sh
docker build -f deploy/Dockerfile -t eta .
docker run -d --name eta -p 8787:8787 -v eta-data:/data eta
docker exec eta cat /data/.eta/access-token  # 令牌
```

一个镜像（构建 Web，host 用 `--web-dir` 提供），一个卷 `/data` 放全部数据（`HOME` 指向它，所以内容在 `/data/.eta/`），监听 `0.0.0.0:8787`，所以令牌门默认开启。镜像名后面的参数会追加给 host，例如 `docker run … eta --allow-origin https://eta.example.com --memory-url http://memory:8320`。健康检查是 `/up`。host 和智能体的 bash 以镜像里的非 root 用户 `bun`（uid 1000）运行，新建的卷归它所有；旧镜像（root）留下的卷或绑定挂载需要改一次属主：`docker run --rm -u 0 --entrypoint chown -v eta-data:/data eta -R 1000:1000 /data`。

`deploy/compose.yaml` 把 host 和（可选的）记忆边车放在一起：

```sh
docker compose -f deploy/compose.yaml up -d --build                      # 只有 host
MEMORY_LLM_BASE_URL=… MEMORY_LLM_API_KEY=… MEMORY_LLM_MODEL=… ETA_MEMORY_URL=http://memory:8320 \
  docker compose -f deploy/compose.yaml --profile memory up -d --build   # 加上记忆
```

放在反向代理后面时设置 `ETA_ALLOW_ORIGIN=https://你的域名`，代理需要升级 WebSocket（`/ws`、`/machines/connect`）。

## daemon：让别的电脑跑会话

daemon 是 `bun build --compile` 的单文件，不含 Web、数据库和模型配置；模型调用和产品工具都回到主 node。

```sh
bun run --cwd apps/daemon build           # 产出 apps/daemon/out/eta-daemon
```

1. 在主 node 的设置 → 机器里添加一台机器，得到一条命令（安装码 24 小时内有效、一次性）。
2. 在那台电脑上执行：`eta-daemon setup <主 node 地址> <安装码>`。它在本地生成密钥并显示指纹，等待批准。
3. 在设置页核对指纹一致后批准。
4. `eta-daemon run` 启动；`eta-daemon install-service` 注册成 systemd 用户服务（Linux）或 launchd agent（macOS）。

daemon 只出站连接主 node，主 node 需要对它可达（经反向代理时要能升级 `/machines/connect`）。数据目录是 `~/.eta/daemon`，和宿主同一个根，由 `$HOME` 决定（没有开关）。原理见[机器与 daemon](docs/architecture/machines.md)。

## 记忆边车

可选。没有它，host 不挂载记忆，界面隐藏记忆页。它需要一个带 pgvector 的 PostgreSQL，以及一个 OpenAI 兼容的模型（用来从对话里抽取事实）：

| 环境变量                                                        | 含义                              |
| --------------------------------------------------------------- | --------------------------------- |
| `DATABASE_URL`                                                  | 边车自己的 PostgreSQL（pgvector） |
| `MEMORY_LLM_BASE_URL`、`MEMORY_LLM_API_KEY`、`MEMORY_LLM_MODEL` | 抽取事实用的模型                  |
| `MEMORY_HOST`、`MEMORY_PORT`                                    | 监听，默认 `127.0.0.1:8320`       |

边车没有鉴权，只让 host 能连到它（回环，或 compose 的内部网络）。镜像见 `deploy/memory.Dockerfile`；本地运行与细节见[记忆](docs/architecture/memory.md)。host 用 `--memory-url http://127.0.0.1:8320` 指向它。
