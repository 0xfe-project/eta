# 环境包

一个环境包（bundle）是一个目录，描述智能体的一种能力：技能、MCP 服务器、hook 规则，可选地还有一个服务。智能体勾选哪些环境包，它在任何一台机器上的会话就带着哪些。不构建镜像，不执行安装脚本。

| 组成       | 实现                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| 技能       | 包的 `skills/` 加进会话的 skill 目录（`skillsFor`），harness 照常发现和加载                 |
| MCP 服务器 | `mcp.json`，作为 [MCP](mcp.md) 的一个配置来源；stdio 进程在会话所在的机器上启动             |
| hook 规则  | `akhook.yml`，作为一层 akhook 配置（[akhook](akhook.md)）只对载入它的智能体的会话生效       |
| 配置和密钥 | 存进 SQLite，用宿主密钥加密；只交给本包的 MCP 进程、hook 命令和服务，不进智能体的 shell     |
| 服务       | 可选，宿主作为回环子进程托管，由宿主代理                                                    |
| 安装说明   | 写在包内技能的 `references/` 里。没配置好时智能体按文档指引用户去做；宿主不执行任何安装脚本 |

## 目录格式

沿用旧插件的写法，旧环境包改一改就能用：

```text
<name>/
  plugin.json        name、description、requires、config、service（targets、version 被忽略）
  mcp.json           { "mcpServers": { "<server>": { command, args, env, cwd } | { url, headers }，加 lifecycle、directTools、approveTools、auth 等 } }
  skills/<n>/SKILL.md   Agent Skills，可带 references/
  akhook.yml         akhook 规则，见 akhook.md
```

- `name`：小写字母、数字和连字符；本地和内置的包，目录名必须等于它。
- `requires`：需要在 PATH 上的命令（`["git", "gh"]`）。宿主在每台机器上检查，设置页提示“这台机器还缺什么”，只提示，不执行，缺命令也照常载入。
- `config`：JSON Schema 的子集，`type: object`，属性都是字符串；`required`、`title`、`description`（Markdown）、`writeOnly`（机密）、`minLength`、`maxLength`（默认并最多 4096）、`pattern`。属性名就是环境变量名，大写字母、数字和下划线，不能是 `PATH`、`HOME` 这类系统变量，也不能以 `ETA_`、`LD_`、`NODE_` 开头。
- `service`：`{ "command": [...], "env": {...}, "ready": "/" }`，见下。

mcp.json 里可以写 `${变量}`：`${PLUGIN_ROOT}`（包在这台机器上的目录）、`${ETA_WORKSPACE_DIR}`（会话的工作目录）、`${ETA_SERVICE_URL}`（包的服务地址，只在主机器上有）和 `config` 里声明的任何一项。用到本机没有的变量，这个服务器被丢掉并记一条警告，其他照常。akhook.yml 只展开 `${PLUGIN_ROOT}` 和 `${ETA_WORKSPACE_DIR}`，配置值不进文本。

规则 id 归在包名下（`<name>/<id>`），所以两个包的规则不会撞。`prompt_submit` 和 `stop` 属于一次回复，由主 node 执行，对远端机器上的会话也一样；工具调用规则（`file_change`、`shell_exec`、`tool_call`、`stream`）在会话所在的机器上执行。

## 来源

后面的盖住前面的同名包：

| 来源 | 位置                                                   | 说明                                                 |
| ---- | ------------------------------------------------------ | ---------------------------------------------------- |
| 内置 | 仓库的 `bundles/<name>/`                               | 只读                                                 |
| git  | `~/.eta/bundles/git/<哈希>/`，来源记在 `bundle_source` | `{ repo, rev, path }`，由主 node 拉取，只检出 `path` |
| 本地 | `~/.eta/bundles/<name>/`                               | 用户自己的；和内置同名就替换它。改了就生效，不用重启 |

**热重载**：每次读包之前先看文件的大小和修改时间，变了就重读清单；对 `~/.eta/bundles` 的监听只是更早地通知 wire。已经打开的会话在它的下一条消息时重开（见“会话”）。

**git 来源**：

- `rev` 是分支、tag 或提交。`add` 用 `git ls-remote` 把它解析成提交 sha（tag 取它指向的提交），记在 `bundle_source`，之后每次都装到同一份；分支往前走了也不动，更新是显式的 `refresh`。
- 拉取：`git fetch --depth 1 <repo> <sha>`（服务器不给出裸 sha 时退回分支或 tag 名并核对 sha），再 `git archive <sha>:<path>` 解出 `path`，换进 `git/<哈希>/`，旁边的 `.sha` 记着它是哪个提交。目录不见了或在别的提交上，启动时按记录的 sha 重拉，不管远端后来变成了什么。
- 私有仓库用主 node 上 git 自己的配置（ssh 密钥、credential helper），宿主不存凭据，也从不等输入（`GIT_TERMINAL_PROMPT=0`）。
- 远端机器不拉：见“daemon”。

## 配置和密钥

`bundle_config` 表，每个包一行，值是一个 JSON，用 AES-256-GCM 加密（密钥是数据目录里的 `secret.key`，0600，第一次用时生成）。单拷数据库读不出值；换了密钥读不出来，按没设置处理。

- `bundles.configure` 写入：`values` 里字符串是设置，`null` 或空串是清除，没写的项不变。校验 `maxLength`、`minLength`、`pattern`；报错只列项名，不带值。
- 读：`bundles` 的 `list` 只有 `set`（有没有值）；非机密项另带 `value` 供编辑，机密项永远是 `null`。没有任何路径把机密送到 wire 上。
- **只给这几类进程**：包的 MCP stdio 服务器（作为环境变量，以及 URL 和 header 里的 `${NAME}`）、包的 hook 命令（akhook 的 `ConfigInput.env`，只对那一层的规则命令生效）、包的服务（环境变量）。不进智能体的 bash 环境，不写进 akhook 文本，不落盘（daemon 也不写）。
- 必填项没填全时（`configured: false`）只载入技能，MCP 和 hook 不启动，技能的 reference 指引用户去设置页。

## 会话

智能体的 `agents.bundles` 是包名列表（按勾选顺序）。一个会话打开时：

- **技能**：`skillDirsFor` 把包的 `skills/` 加进 `renderSkillsBlock` 的目录。
- **MCP**：`bundleMcpServers` 把每个包的服务器作为一个配置来源（`bundle:<名>`）交给 `McpHost`；会话只拿到 `mcp` 工具和缓存里已有的直接工具，服务器在第一次调用时才连，所以打开会话不等它们。
- **规则**：包的 akhook 层并进会话的 `additional` 层（`AkhookHost.bundleLayers`），回复前后的 `prompt_submit` / `stop` 经 `LifecycleRun.extra` 带上。
- **重开**：会话的 stamp 含各包的“文件指纹 + git sha + 配置写入时间”，包被改过、重新配置过、或勾选变了，下一条消息时会话关了重开，重新读这些。

主机器上的会话由宿主进程里的 session manager 打开；远端的由 daemon 打开。宿主给两边的是同一份东西，只是方式不同。

## daemon

daemon 不拉 git，也不需要 git 凭据。主 node 在每次 `machine.open` 之前：

1. `machine.bundleHave { hashes }`：包的内容（排序后的路径、可执行位、内容）的哈希；daemon 回答它没有哪些；
2. `machine.bundlePut { hash, files }`：缺的才发，文件是 base64。一个包最多 400 个文件、2 MiB（一帧里发完）；超了这个包被丢掉并记警告；
3. `machine.open` 带 `bundles: [{ name, hash, config, configured }]`。

daemon 把文件放进 `<数据目录>/bundles/<哈希>/`（先写临时目录再改名，写前核对哈希，拒绝跳出目录的路径），在自己机器上读包，启动 MCP 服务器、组 akhook 层、加技能目录。**配置值随 `open` 走 WSS 链路到 daemon，只存在于它内存里的 opening 和它启动的进程的环境里，不写盘**；daemon 重启后，下一次唤醒时主 node 再发。

`${ETA_SERVICE_URL}` 在 daemon 上没有（服务只在回环上），用它的 MCP 服务器在 daemon 的会话里被丢掉。

## 就绪（`requires`）

`machine.which { commands }` 让 daemon 在它的 PATH 上找命令；主机器直接找。主 node 在启动、daemon 连上、包变了、`bundles.recheck` 时问一遍，结果缓存；主机器每次生成列表时现查。`list` 里每个包带 `machines: [{ machineId, name, ready, missing, checked }]`，离线的机器 `checked: false`。

## 服务

包的 `service` 照记忆边车的做法：宿主起一个子进程，在包目录里，环境是 `PORT`（宿主选的回环空闲端口）、`HOST=127.0.0.1`、`ETA_BUNDLE_DATA`（`<数据目录>/bundles/<name>/`，服务自己的数据）、包的配置值、`service.env`。`${PLUGIN_ROOT}` 在命令里展开。等 `ready` 路径应答（< 500）后状态是 `ready`，超时或退出是 `error`，附 stderr 最后一行。

- 只在包配置完整、`requires` 的命令都在主机器上时运行；包的文件或值变了就重启；退出了不自己重启，等下一次变化或 `recheck`。
- 用户经 `/bundles/<name>/service/*` 访问：在 host 的访问控制之后，去掉 Cookie 和 Authorization，非 GET 带跨站 Origin 的拒绝。
- 主机器上的会话经 `${ETA_SERVICE_URL}` 访问。

## wire：`bundles` target

`list` 一个 section，每项（`BundleView`）：`name`、`description`、`source`（`builtin` | `local` | `git {repo, rev, path}`）、`sha`、`requires`、`skills`、`mcpServers`、`hooks`、`fields`（`set`，非机密的 `value`）、`configured`、`service`、`machines`、`problem`。

| 动作        | 说明                                                      |
| ----------- | --------------------------------------------------------- |
| `configure` | 写配置，见上                                              |
| `add`       | `{ repo, rev?, path? }`：从 git 添加，名字取清单的 `name` |
| `refresh`   | `{ name? }`：重新解析 git 来源的 `rev`，变了就重拉        |
| `remove`    | `{ name }`：忘记一个 git 来源，删它的文件和配置           |
| `recheck`   | 重新问各机器                                              |

## 界面

设置 → 环境包：每个包的来源、sha、是否配置、缺什么命令、服务状态；设置表单（机密项是 password 输入，留空保持不变）、从 git 添加、更新、移除。智能体编辑器的“环境包”页签：勾选，未配置的提示“只有技能生效”，主机已没有的名字可以取消勾选。没有 `bundles` 插件的主机隐藏页签。

## 内置的环境包

`bundles/` 下：

| 包     | 内容                                                                                                                                                                    | requires                |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| github | 技能 `github`（gh/git 已由 eta 的 GitHub App 登录，PR 用 `open_pull_request`，issue 用 `draft_issue`；设置在“设置 → 连接”，见 [GitHub](github.md)）；没有 MCP、没有配置 | `git`、`gh`             |
| grok   | 技能 `grok`；MCP `grok-api mcp`（图像、视频、网页和 X 搜索）；config `XAI_API_KEY`                                                                                      | `grok-api`              |
| oomol  | 技能 `oomol`；一个零依赖的 stdio MCP（`server/oo-mcp.mjs`）把 `oo` CLI 当一个工具跑，密钥只在它的进程里；config `OO_API_KEY`、`OO_TEAM_NAME`                            | `node`、`oo`            |
| agenvo | 技能 `agenvo`；服务 `service/start.mjs` 起 agenvo 中继；MCP 指向 `${ETA_SERVICE_URL}/mcp`；config `AGENVO_ADMIN_SECRET`                                                 | `node`、`agenvo-server` |

groups、tasks、artifacts、approval、memory、routines 已经是产品功能，不再是环境包。每个包的 `skills/*/references/setup.md` 写着怎么安装和配置，智能体按它指引用户。

## 隔离

包里的东西以用户身份跑在真实机器上。这一版靠两点收住风险：不执行安装脚本；密钥只给对应的进程。用 bubblewrap 之类给每个人格的工具进程再套一层，之后另开 issue。
