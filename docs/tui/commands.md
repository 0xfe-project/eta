<!-- This file is generated from the command registry. Do not edit it: run `bun run --cwd apps/tui docs` to regenerate it. -->

# eta commands

[中文](commands.zh.md)

Slash commands of the eta terminal interface. Type them in the input line of the home screen or of a conversation; names and arguments are always English.

## /agent

```text
/agent [agent]
```

Edit an agent's settings as YAML in your editor

### Arguments

- `agent` (optional): The agent's name or id; without it, a list to choose from

### Examples

- `/agent`: Choose an agent to edit
- `/agent Ada`: Edit the agent named Ada

## /approvals

```text
/approvals
```

List the tools that ask before they run, and add or remove one

### Examples

- `/approvals`: Make a tool ask for approval before every call

## /archive

```text
/archive [conversation]
```

Archive a conversation, the one in front unless named, and close its tab

### Arguments

- `conversation` (optional): Its id, its name, or enough of its name to tell it apart

### Examples

- `/archive`: Archive the conversation in front
- `/archive release`: Archive the conversation whose name starts with or holds “release”

## /artifacts

```text
/artifacts
```

List what the agents published, and get an address to preview it

### Examples

- `/artifacts`: Show the artifacts

## /config

```text
/config
```

Open the settings file in your editor and apply it when the editor closes

### Examples

- `/config`: Edit the settings

## /edit-host-config

```text
/edit-host-config [file]
```

Edit the host's config.json or mcp.json in your editor

### Arguments

- `file` (optional): config.json or mcp.json; without it, a choice of the two

### Examples

- `/edit-host-config config.json`: Edit the host's model providers
- `/edit-host-config mcp.json`: Edit the host's MCP servers

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

## /invite

```text
/invite [agent]
```

Invite an agent into the conversation in front

### Arguments

- `agent` (optional): The agent's name, or enough of it to tell it apart

### Examples

- `/invite`: Choose whom to invite
- `/invite cleo`: Invite Cleo

## /machines

```text
/machines
```

List the machines, add one, approve or revoke one

### Examples

- `/machines`: Add another machine for agents to work on

## /mcp

```text
/mcp
```

List the agents' MCP servers, connect one or sign in to it

### Examples

- `/mcp`: Sign in to a server that needs it

## /model

```text
/model [agent]
```

Choose an agent's model and thinking level

### Arguments

- `agent` (optional): The agent's name, the start of it, or its id; asked when left out

### Examples

- `/model`: Pick the agent from a list
- `/model Ada`: Set Ada's model

## /new

```text
/new [path]
```

Start a new conversation: where, then who

### Arguments

- `path` (optional): The absolute path of a directory on the host's machine to start the conversation in

### Examples

- `/new`: Choose a project, type a path or browse to a directory
- `/new /home/me/code/site`: Start a conversation in this absolute path on the host's machine

## /open

```text
/open <conversation>
```

Open a conversation in a tab

### Arguments

- `conversation` (required): Its id, its name, or enough of its name to tell it apart

### Examples

- `/open release`: Open the conversation whose name starts with or holds “release”

## /plugins

```text
/plugins
```

List the host's plugins and turn one on or off for agents

### Examples

- `/plugins`: Choose which agents use a plugin

## /providers

```text
/providers
```

See and connect the model gateway's subscription accounts and API keys

### Examples

- `/providers`: Connect a Codex, Grok or Google AI Studio account

## /queue

```text
/queue <message>
```

Send a message to the conversation in front, after the reply that is running

### Arguments

- `message` (required): What to say

### Examples

- `/queue then write the tests`: Ask for the tests once the current reply ends

## /remove

```text
/remove [agent]
```

Take a member out of the conversation in front

### Arguments

- `agent` (optional): The agent's name, or enough of it to tell it apart

### Examples

- `/remove`: Choose whom to take out
- `/remove ben`: Take Ben out

## /rename

```text
/rename <name>
```

Rename the conversation in front

### Arguments

- `name` (required): The new name

### Examples

- `/rename Launch plan`: Call the conversation “Launch plan”

## /setup

```text
/setup
```

Open the first-time setup: connect model accounts, then create agents

### Examples

- `/setup`: Pick up the setup you left

## /steer

```text
/steer <message>
```

Send a message into the reply running in the conversation in front

### Arguments

- `message` (required): What to say

### Examples

- `/steer use the new API instead`: Change course while the reply is still running

## /steward

```text
/steward [agent]
```

Choose who takes the messages of the conversation in front that name nobody

### Arguments

- `agent` (optional): A member's name, “project” to follow the project's steward, or “none”

### Examples

- `/steward`: Choose from a list
- `/steward ada`: Make Ada the steward
- `/steward project`: Follow the project's steward
- `/steward none`: Have no steward

## /stop

```text
/stop
```

Stop every reply running in the conversation in front

### Examples

- `/stop`: Stop the replies

## /tasks

```text
/tasks
```

List the open tasks, and handle or comment on one

### Examples

- `/tasks`: List the open tasks

## /unarchive

```text
/unarchive <conversation>
```

Bring an archived conversation back and open it

### Arguments

- `conversation` (required): Its id, its name, or enough of its name to tell it apart

### Examples

- `/unarchive release`: Bring back the archived conversation named like “release”
