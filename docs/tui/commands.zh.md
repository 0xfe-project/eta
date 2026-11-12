<!-- 本文件由命令注册表生成，不要手改：运行 `bun run --cwd apps/tui docs` 重新生成。 -->

# eta 命令

[English](commands.md)

eta 终端界面的斜杠命令，在首页或对话的输入框里输入。命令名和参数名一律是英文。

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
