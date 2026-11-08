<!-- This file is generated from the command registry. Do not edit it: run `bun run --cwd apps/tui docs` to regenerate it. -->

# eta commands

[中文](commands.zh.md)

Slash commands of the eta terminal interface. Type them on the home screen; names and arguments are always English.

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
