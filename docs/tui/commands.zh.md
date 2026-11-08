<!-- 本文件由命令注册表生成，不要手改：运行 `bun run --cwd apps/tui docs` 重新生成。 -->

# eta 命令

[English](commands.md)

eta 终端界面的斜杠命令，在首页或对话的输入框里输入。命令名和参数名一律是英文。

## /agent

```text
/agent [agent]
```

用编辑器以 YAML 编辑智能体的设定

### 参数

- `agent` (选填): 智能体的名字或 id；不给时从列表里选

### 例子

- `/agent`: 选一个智能体来编辑
- `/agent Ada`: 编辑名叫 Ada 的智能体

## /approvals

```text
/approvals
```

查看运行前要先问过的工具，添加或删除

### 例子

- `/approvals`: 让某个工具每次调用前先问过

## /archive

```text
/archive [conversation]
```

归档一个对话（不写就是最前面的），并关掉它的标签

### 参数

- `conversation` (选填): 对话的 id、名字，或足以区分它的一段名字

### 例子

- `/archive`: 归档最前面的对话
- `/archive release`: 归档名字以“release”开头或包含它的对话

## /artifacts

```text
/artifacts
```

列出智能体发布的产物，并取得预览地址

### 例子

- `/artifacts`: 列出产物

## /config

```text
/config
```

用编辑器打开设定文件，关掉编辑器后立即生效

### 例子

- `/config`: 编辑设定

## /edit-host-config

```text
/edit-host-config [file]
```

用编辑器修改 host 的 config.json 或 mcp.json

### 参数

- `file` (选填): config.json 或 mcp.json；不给时从两者中选

### 例子

- `/edit-host-config config.json`: 修改 host 的模型 provider 设定
- `/edit-host-config mcp.json`: 修改 host 的 MCP 服务器

## /github

```text
/github
```

查看 GitHub App 的状态，刷新或授权

### 例子

- `/github`: 看 App 装在哪些账号

## /help

```text
/help [command]
```

列出全部命令，或查看一条命令的用法

### 参数

- `command` (选填): 要查看的命令名，不带斜杠

### 例子

- `/help`: 列出全部命令
- `/help config`: 查看 /config 的用法

## /install-service

```text
/install-service
```

装常驻 host，从临时 host 换过去

### 例子

- `/install-service`: 退出 eta 后 agent 继续运行

## /invite

```text
/invite [agent]
```

邀请一个智能体加入最前面的对话

### 参数

- `agent` (选填): 智能体的名字，或足以区分它的一段名字

### 例子

- `/invite`: 选要邀请谁
- `/invite cleo`: 邀请 Cleo

## /machines

```text
/machines
```

查看机器，添加、批准或撤销

### 例子

- `/machines`: 再加一台给智能体干活的机器

## /mcp

```text
/mcp
```

查看智能体的 MCP 服务器，连接或登录

### 例子

- `/mcp`: 登录需要登录的服务器

## /model

```text
/model [agent]
```

选智能体的模型和思考档

### 参数

- `agent` (选填): 智能体的名字、名字开头或 id；不给时会先问

### 例子

- `/model`: 从列表里选智能体
- `/model Ada`: 设 Ada 的模型

## /new

```text
/new [path]
```

新建对话：先选在哪里，再选谁

### 参数

- `path` (选填): 在 host 所在机器上的这个目录里新建对话，写绝对路径

### 例子

- `/new`: 选一个项目，输入路径，或浏览到一个目录
- `/new /home/me/code/site`: 在 host 所在机器上的这个绝对路径里新建对话

## /open

```text
/open <conversation>
```

在标签页里打开一个对话

### 参数

- `conversation` (必填): 对话的 id、名字，或足以区分它的一段名字

### 例子

- `/open release`: 打开名字以“release”开头或包含它的对话

## /plugins

```text
/plugins
```

查看 host 上的插件，给智能体启用或停用

### 例子

- `/plugins`: 选哪些智能体用某个插件

## /providers

```text
/providers
```

查看与连接模型网关的订阅账号和 API key

### 例子

- `/providers`: 连接 Codex、Grok 或 Google AI Studio 账号

## /queue

```text
/queue <message>
```

给最前面的对话发消息，排在正在跑的回复之后

### 参数

- `message` (必填): 要说的话

### 例子

- `/queue then write the tests`: 等当前回复结束后再要测试

## /remove

```text
/remove [agent]
```

把一个成员移出最前面的对话

### 参数

- `agent` (选填): 智能体的名字，或足以区分它的一段名字

### 例子

- `/remove`: 选要移出谁
- `/remove ben`: 把 Ben 移出

## /rename

```text
/rename <name>
```

给最前面的对话改名

### 参数

- `name` (必填): 新名字

### 例子

- `/rename Launch plan`: 把对话改名为“Launch plan”

## /setup

```text
/setup
```

打开首次设置：绑模型账号，再建智能体

### 例子

- `/setup`: 回到离开的首次设置

## /steer

```text
/steer <message>
```

把消息插进最前面对话正在跑的回复

### 参数

- `message` (必填): 要说的话

### 例子

- `/steer use the new API instead`: 回复还在跑的时候改方向

## /steward

```text
/steward [agent]
```

选最前面对话的主理人：没点名的消息交给谁

### 参数

- `agent` (选填): 成员的名字；“project” 表示跟随项目的主理人；“none” 表示不要主理人

### 例子

- `/steward`: 从列表里选
- `/steward ada`: 让 Ada 当主理人
- `/steward project`: 跟随项目的主理人
- `/steward none`: 不要主理人

## /stop

```text
/stop
```

停止最前面对话里所有在跑的回复

### 例子

- `/stop`: 停止回复

## /tasks

```text
/tasks
```

列出没关的任务，处理或留言

### 例子

- `/tasks`: 列出没关的任务

## /unarchive

```text
/unarchive <conversation>
```

取消归档一个对话并打开它

### 参数

- `conversation` (必填): 对话的 id、名字，或足以区分它的一段名字

### 例子

- `/unarchive release`: 取消归档名字像“release”的对话
