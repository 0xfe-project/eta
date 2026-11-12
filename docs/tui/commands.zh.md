<!-- 本文件由命令注册表生成，不要手改：运行 `bun run --cwd apps/tui docs` 重新生成。 -->

# eta 命令

[English](commands.md)

eta 终端界面的斜杠命令，在首页或对话的输入框里输入。命令名和参数名一律是英文。

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

## /steer

```text
/steer <message>
```

把消息插进最前面对话正在跑的回复

### 参数

- `message` (必填): 要说的话

### 例子

- `/steer use the new API instead`: 回复还在跑的时候改方向

## /stop

```text
/stop
```

停止最前面对话里所有在跑的回复

### 例子

- `/stop`: 停止回复
