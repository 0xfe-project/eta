# 插件

插件给智能体带来 skill 和 MCP 服务器，格式是 [Agent Plugins 1.0.0](https://agent-plugins.org)：根目录一个 `plugin.json`，`skills/<name>/SKILL.md` 和 `mcp.json` 在固定位置。eta 的私有数据放在 `extensions["moe.akr.eta"]` 里，不认识这个扩展的客户端把它当普通插件加载。

代码在 `apps/daemon/src/plugin-*.ts`（主 node 和 daemon 共用的读取、启动、文件同步）和 `apps/eta/src/plugins/`（来源、配置、工具、wire）。字段校验是纯函数，在 `packages/client-contracts/src/plugin-fields.ts`，host 和前端共用，host 的结果是权威。

## 从哪里来

- **本地**：`~/.eta/plugins/<目录>/`，改了就重读。主 node 每 2 秒比一次文件签名（路径、大小、修改时间），开会话前再比一次。`data` 这个目录名被 `PLUGIN_DATA` 占用，不算插件。这个目录也是 eta-server 用户插件的位置：有 `plugin.json` 的归这里，`package.json` 带 `eta-plugin` 的归它，互不打扰。
- **git**：`{ repo, rev, path }`。`rev` 解析成 commit 后固定下来，要用户手动「更新」才移动。文件在 `<dataDir>/plugin-sources/`。

插件的身份是 manifest 的 `name`。被规范拒绝的插件也会列出来，用目录名显示，并说明原因。

## 规范的失败边界

| 情况                                                                                          | 结果                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------- |
| `plugin.json` 缺失、不是合法 JSON、`$schema` 不识别、字段类型错、名字不合规、解析到插件根之外 | 拒绝整个插件                          |
| 未知顶层字段、`extensions` 不是对象                                                           | 报告并忽略，继续加载                  |
| 未实现的命名空间                                                                              | 不读                                  |
| `mcp.json` 不是合法 JSON、`$schema` 不识别或版本不一致、多余字段、解析到根之外、不是文件      | 这个插件的 MCP 关闭，skill 照常       |
| 单个 server 无效（字段、`command`、`cwd`、`url`、header、`env` 里有保留名）                   | 跳过这个 server                       |
| `sse` 传输                                                                                    | 跳过并报告：oar 的 `McpServer` 不支持 |
| `skills` 不是目录                                                                             | skill 无效，MCP 照常                  |
| 单个 skill 不合 Agent Skills 规范或解析到根之外                                               | 跳过这个 skill                        |

报告显示在设置页的插件条目下。只看 `skills/` 的直接子目录，不往深处找。

## 配置

`extensions["moe.akr.eta"]`：

```json
{
  "config": {
    "api_key": {
      "type": "string",
      "title": "API key",
      "required": true,
      "secret": true,
      "pattern": "^sk-"
    },
    "team": { "type": "string", "maxLength": 64 }
  },
  "mcp": {
    "server": {
      "env": { "SERVER_KEY": "api_key" },
      "headers": { "Authorization": "Bearer {api_key}" }
    }
  },
  "requires": ["node"]
}
```

- `config` 是封闭 schema，不是 JSON Schema。共用键 `type`、`title`、`description`、`required`、`default`、`secret`、`agent`；`string` 有 `pattern`、`minLength`、`maxLength`，`number` 有 `int`、`min`、`max`，`select` 有 `options`、`multiple`、`minItems`、`maxItems`。任何未知键让 `config` 整体无效：插件留在待配置，并报告原因。
- `secret: true` 只能用于 `string`，不能有 `default`。
- `pattern` 用 RE2（`re2js`）执行，匹配时间和输入长度成线性，所以作者写的正则不会拖住 host。环视和反向引用不是 RE2，算 `config` 无效。模式最长 512 字符，字符串值最长 64 KiB。
- `mcp.<server>.env` 和 `headers` 把字段送到 server，不写进 `mcp.json`。`mcp.json` 保持规范要求的样子：`${PLUGIN_ROOT}`、`${PLUGIN_DATA}` 单次展开，别的都不展开。多选字段用逗号连接。没有值的字段不设这个变量，也不加这个 header。
- `requires` 只用于提示：每台机器逐个检查，缺了显示在设置页。

配置全局一份，`seal` 成一个 JSON 存进 `plugin_config`。secret 不经 wire 返回，留空表示不改，`null` 表示清除。host 拒绝保存不合字段的值；缺必填项可以保存，状态留在待配置。

## 状态

`待配置`（`needs_config`）/ `可启用`（`ready`）。必填项没填、保存的值不合当前字段，或者 `config` 无效，都是待配置。只有可启用的插件能被勾选。

升级后配置不再合法时退回待配置：已启用的智能体保留勾选，会话跳过它，设置页和智能体编辑器都有提示。改好后自动恢复。

## 会话拿到什么

| 运行方式            | Skill                                                | MCP                                  |
| ------------------- | ---------------------------------------------------- | ------------------------------------ |
| 自带内核            | 目录接到 `skillDirsFor`，进系统提示的 skills 块      | 这一版不启动，界面标明，下一个任务接 |
| Claude Code         | `--plugin-dir` 原生加载一个只含合法 skill 的生成目录 | oar 的 `mcpServers`                  |
| Codex、OpenCode、Pi | 名字、描述和路径写进系统提示，agent 自己读文件       | oar 的 `mcpServers`                  |

Claude Code 不能直接拿插件目录：`--plugin-dir` 会把它当 Claude 插件，运行里面的 `hooks/`、加载 `commands/`，而 eta 不支持这些。生成目录在 `<dataDir>/plugin-runtime/claude/<内容哈希>/<插件名>/skills/`，里面是指向合法 skill 的符号链接。

运行时不接受工作目录，所以 stdio server 经 `/bin/sh -c 'cd "$0" && exec "$@"'` 启动，cwd 默认是插件根。server 名是 `<插件>-<server>`，非法字符换成 `_`。

`PLUGIN_ROOT` 和 `PLUGIN_DATA` 由 eta 设置，覆盖同名环境变量。`PLUGIN_DATA` 在 `<dataDir>/plugins/data/<name>`，插件更新时保留，主 node 和 daemon 各有各的。

配置或文件变化时，session 的 stamp 跟着变（`<名字>@<内容哈希>:<配置保存时间>`），相关会话下次打开时重开。

## 其他机器

会话开在 daemon 上时，`RemotePlace` 先用 `machine.pluginHave` 问它缺哪些内容哈希，再用 `machine.pluginPut` 分块发文件（每批不超过一帧，符号链接跟随，离开插件根的跳过），daemon 校验哈希后才放进 `<dataDir>/plugins/store/<hash>/`。

`machine.open` 带上 `plugins`（哈希和给每个 server 的值）和 `redactions`。这些只在 daemon 内存里，启动 server 时注入，不落盘。自带内核的会话不起 MCP，所以不发 server 的值，但 `redactions` 仍含 secret。

## agent 读取配置

`get_plugin_config({ plugin, fields? })` 是宿主工具，随工具表进入 realm（`eta.platform.get_plugin_config`）。只能读这个智能体启用的、可启用状态的插件。

| 级别    | 用于      | 返回                                 |
| ------- | --------- | ------------------------------------ |
| `read`  | 非 secret | 值                                   |
| `file`  | secret    | 0600 临时文件的路径，值不进结果      |
| `value` | secret    | 明文，会进 journal 和回复的工具记录  |
| `none`  | 两者      | 「不可读」，并说明插件进程已经拿到了 |

非 secret 默认 `read`，secret 默认 `none`。manifest 声明的是上限，用户可以调低，不能调高。

`file` 写在会话所在的机器上（经 `SshTransport`，远端走 link），每次读取一个新的 0700 目录，值走 stdin，不进任何进程的参数。文件一小时后删除，这台机器的下一次读取也会清理过期的。

`file`、`value` 每次读取都写审计（`plugin_audit`：会话、智能体、插件、字段、时间，不记值），设置页能看到。

**不要打印 secret。** `value` 的结果会进模型上下文和 journal，这是用户选这个级别时接受的；需要用值的脚本应该读 `file` 的路径。

## 脱敏

自带内核在工具结果和进度更新进入模型和 journal 之前，把已知 secret 替换成 `[secret <插件>.<字段>]`（`redactionMiddleware`，主 node 和 daemon 都装）。范围是所有插件保存的 secret，除了这个智能体能以 `value` 读的那些。

这只是防意外：匹配完全相同的文本，脚本编码过的值拦不住，短于 4 个字符的不处理。外部运行时内部的工具输出 eta 看不到，也管不到。

## 安全边界

stdio server 就是在机器上运行作者的代码，不是沙盒，所以启用前会显示它运行的命令或连接地址。`npx` 这类 server 运行时自己装包，不经过我们的检查。

secret 只交给 server 的环境，但和 agent 同一个用户运行，agent 有 shell 时可以从 `/proc/<pid>/environ` 读到。`none` 的意思是「不进上下文，也没有提供读取的途径」，不是操作系统级隔离。
