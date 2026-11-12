<!-- 本文件由命令注册表生成，不要手改：运行 `bun run --cwd apps/tui docs` 重新生成。 -->

# eta 命令

[English](commands.md)

eta 终端界面的斜杠命令，在首页输入。命令名和参数名一律是英文。

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
