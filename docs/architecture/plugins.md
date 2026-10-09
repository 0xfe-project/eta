# 插件

本文说明 [#56](https://github.com/AkaraChen/axp/issues/56) 的实现：AXP 的插件是一个不属于任何 agent harness 的目录，按目标编译。聊天智能体和定时任务都从这里取扩展；插件本身不写 Codex 或 ADK 特有的东西。

## 一个插件是什么

`apps/agent-runtime/plugins` 下的一个目录，新增插件只需新增目录：

```
plugins/grok/
  plugin.json        # name、version、description、targets
  mcp.json           # 可选：MCP 服务器，标准的 mcpServers 写法
  skills/*/SKILL.md  # 可选：Agent Skills
  hooks/hooks.json   # 可选：生命周期 hook（暂时只有 chat 目标支持，见下）
  setup              # 可选：构建镜像时运行一次，准备运行环境
```

`targets` 是插件能用在哪里：`chat`（聊天智能体）和 `routine`（定时任务）的子集。读取、校验和两个目标的编译都在 `packages/plugins-go`。

### MCP 服务器

只用两边都能实现的部分：stdio 的 `command`、`args`、`env`、`cwd`，streamable HTTP 的 `url`、`headers`。插件里只能出现这几个变量，由各目标给出值；出现其他变量时读取失败：

| 变量                   | 含义                | chat                      | routine                                          |
| ---------------------- | ------------------- | ------------------------- | ------------------------------------------------ |
| `${PLUGIN_ROOT}`       | 插件在镜像里的目录  | `/opt/axp/plugins/<name>` | 插件目录                                         |
| `${AXP_GATEWAY_URL}`   | 访问 AXP 服务的入口 | runtime 网关              | 定时任务服务的本地代理，只转发 `/v1`（LLM 网关） |
| `${AXP_AGENT_KEY}`     | 智能体的凭据        | runtime key               | 本次运行的 key，运行结束即失效                   |
| `${AXP_WORKSPACE_DIR}` | 工作目录            | 智能体的工作区            | 本次运行的临时目录                               |

需要身份的 HTTP 服务器写 `"headers": {"Authorization": "Bearer ${AXP_AGENT_KEY}"}`；stdio 服务器在 `env` 里把整个值写成 `${AXP_AGENT_KEY}`，例如 grok 的 `"XAI_API_KEY": "${AXP_AGENT_KEY}"`。

### setup

可执行文件，构建镜像时在插件目录里运行一次，环境里有 `TARGETARCH`、`PLUGIN_ROOT`、`AXP_PLUGIN_CACHE`（跨构建保留的下载缓存，各插件一个目录）和 `AXP_PLUGIN_BIN`（可执行文件装到这里）。下载要校验 checksum，最后自检；失败则镜像构建失败。运行时不安装任何东西。

## chat 目标：编译成 Codex plugin

聊天智能体的 runtime 跑 Codex，所以 chat 目标的产物是 Codex 的布局，和 runtime 的安装代码（`axp_runtime/runtime.py`）约定的完全一致。构建 runtime 镜像时运行 `axp-plugins chat /opt/axp/plugins /etc/codex /opt/axp/plugins`（`packages/plugins-go/cmd/axp-plugins`，由 Turbo 先为目标平台编译）：

1. 运行 chat 插件的 `setup`（`AXP_PLUGIN_BIN=/usr/local/bin`）；
2. 为每个插件就地生成 `.codex-plugin/plugin.json` 和 Codex 写法的 `.mcp.json`：`Authorization: Bearer ${AXP_AGENT_KEY}` 变成 `bearer_token_env_var = AXP_RUNTIME_LLM_KEY`；stdio 的 `env` 里的 key 变成 `env_vars` 透传，再由 `sh -c 'export NAME="$AXP_RUNTIME_LLM_KEY"; exec "$0" "$@"'` 改名（Codex 只透传、不改名）；`${PLUGIN_ROOT}` 换成镜像里的目录；
3. 生成本地 marketplace `axp`（`.agents/plugins/marketplace.json`，只含 chat 插件，按目录名排序）；
4. 在 `config.toml` 里让每个插件 MCP 服务器的工具免确认，否则每次调用都会被 runtime 以“无人应答”拒绝；
5. 把各插件的 `hooks/hooks.json` 写进 `requirements.toml`，成为 managed hook。Codex 只执行经过信任的 hook：插件自带的 hook 要有人审核，managed hook 按策略可信，`allow_managed_hooks_only` 让其他来源的 hook 一律不执行。managed hook 对所有智能体都执行，所以生成的命令先检查 `CODEX_HOME/plugins/cache/axp/<plugin>` 存在，即该智能体装了这个插件，才运行。

runtime 启动时安装选中的插件、在副本里填入 `${AXP_GATEWAY_URL}` 和 `${AXP_WORKSPACE_DIR}`，见[聊天与运行时架构](chat-runtime.md#plugin)。控制面的插件目录（`GET /plugins`）用同一个包读取，只列 chat 插件。

## routine 目标：加载进 ADK agent

定时任务服务在进程内用 ADK 跑每次运行（见[定时任务](routines.md)），用 `packages/plugins-go/adk` 把 routine 插件加载成 ADK toolset：

- 每个 MCP 服务器一个 `mcptoolset`。stdio 服务器的进程随本次运行结束；它只拿到 `PATH`、`HOME` 和自己的 `env`，看不到服务的环境（数据库地址等）。
- 各插件的 `skills/` 合成一个 skill toolset。
- 带 `hooks/hooks.json` 的插件拒绝加载：hook 要先迁到 akhook（[aghub-app/akhook#8](https://github.com/aghub-app/akhook/issues/8)），不能在没有 hook 的情况下运行。

`${AXP_GATEWAY_URL}` 是服务在 loopback 上开的代理：它只接受正在运行的运行的 key，把 `/v1` 以 `X-AXP-Agent-Id: routine-<id>` 转发给 LLM 网关，用量记在定时任务名下。需要控制面身份的插件（memory、tasks、github 经 runtime 网关向控制面校验 key）暂不标 `routine`。

构建应用镜像时运行 `axp-plugins setup routine`，把 routine 插件要用的可执行文件（如 `grok-api`）装进镜像（`deploy/Dockerfile`）；服务启动时跳过命令不存在的插件并记警告。

## 现有插件

| 插件     | targets       | 内容                                                                                      |
| -------- | ------------- | ----------------------------------------------------------------------------------------- |
| approval | chat          | 用户确认 akhook `ask` 规则拦下的命令（[确认](agent-hooks.md)）                            |
| github   | chat          | GitHub App 的 git、gh 凭据与 `open_pull_request`（[代码托管](forge.md)）                  |
| grok     | chat、routine | [grok-api](https://github.com/AkaraChen/grok-api)：Grok Imagine 图像和视频，网页和 X 搜索 |
| memory   | chat          | 长期记忆（[记忆](memory.md)），带 recall / capture hook                                   |
| tasks    | chat          | 任务看板（[任务与远程电脑](tasks.md)）                                                    |
