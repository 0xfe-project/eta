<!-- This file is generated from the command registry. Do not edit it: run `bun run --cwd apps/tui docs` to regenerate it. -->

# eta commands

[中文](commands.zh.md)

Slash commands of the eta terminal interface. Type them in the input line of the home screen or of a conversation; names and arguments are always English.

## /config

```text
/config
```

Open the settings file in your editor and apply it when the editor closes

### Examples

- `/config`: Edit the settings

## /help

```text
/help [command]
```

List the commands, or show how to use one

### Arguments

- `command` (optional): The command to explain, without the slash

### Examples

- `/help`: List every command
- `/help config`: Show how to use /config

## /install-service

```text
/install-service
```

Install a resident host and move to it from the temporary host

### Examples

- `/install-service`: Keep agents running after eta quits

## /open

```text
/open <conversation>
```

Open a conversation in a tab

### Arguments

- `conversation` (required): Its id, its name, or enough of its name to tell it apart

### Examples

- `/open release`: Open the conversation whose name starts with or holds “release”

## /queue

```text
/queue <message>
```

Send a message to the conversation in front, after the reply that is running

### Arguments

- `message` (required): What to say

### Examples

- `/queue then write the tests`: Ask for the tests once the current reply ends

## /steer

```text
/steer <message>
```

Send a message into the reply running in the conversation in front

### Arguments

- `message` (required): What to say

### Examples

- `/steer use the new API instead`: Change course while the reply is still running

## /stop

```text
/stop
```

Stop every reply running in the conversation in front

### Examples

- `/stop`: Stop the replies
