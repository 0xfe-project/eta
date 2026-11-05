# 数据

产品数据在 SQLite（`bun:sqlite`），会话照上游存成文件。所有东西在**一个数据目录**里：`$HOME/.eta`，不是开关。想要别的位置就换 `HOME`；Docker 镜像里 `HOME=/data`，卷挂在 `/data`，所以内容在 `/data/.eta/`，由非 root 用户 `bun`（uid 1000）拥有，host 与会话的 bash 都以它运行。

这里不许再有第二个根。曾经有过一个 `--data-dir`：它只挪走配置、数据库和会话，persona 卡片仍然从真实的 `~/.eta/persona` 读，于是换一个目录启动的进程看起来像「模型配置丢了」。persona、MCP 配置这些用户级的东西也跟着 `$HOME` 走之后，一个根就够了。

## 目录布局

```text
<数据目录>/
  eta.sqlite(-wal, -shm)    产品数据库
  config.json               上游设置（模型、provider 等；providers 插件维护）
  llm/                      LLM 网关的状态：auths/ 凭据、models.json、config.yaml（CPA 的配置，含 Gemini key）
  sessions/<会话 id>/       上游会话：meta.json + journal.jsonl（本机会话）
  attachments/<对话 id>/    用户附在消息上的文件：<附件 id>-<文件名>（上传中是 .up-<id>，重启时清理）
  agents/<智能体 id>/       智能体的工作区（它同时是一个 project）
  routines/<定时任务 id>/   定时任务每次运行的工作目录
  worktrees/<项目 id>/task-<编号>/   任务在 primary 上的 git worktree（运行后保留；daemon 机器上在 ~/.eta/worktrees/）
  artifacts/<产物 id>/<版本>/   archive.zip 与解压后的 files/；artifacts/.preview-key 是预览地址的签名密钥
  plugins/<目录>/           Agent Plugins（有 plugin.json，见[插件](plugins.md)）和 eta-server 的用户插件（package.json 里有 eta-plugin），两种各认各的
  plugins/data/<插件名>/    插件的 PLUGIN_DATA，更新时保留
  plugin-sources/           从 git 取回的插件，固定在一个 commit
  plugin-runtime/           给 Claude Code 的生成目录，只有合法的 skill（符号链接）
  modules/                  官方插件
  access-token              令牌门的令牌（开启时；0600）
  secret.key                邮箱、MCP 与 GitHub 的密封密钥（0600，第一次用时生成）
  github/                   这台机器上 git 与 gh 的 GitHub 登录（令牌最多一小时，见 [GitHub](github.md)）：gh/hosts.yml、token、login、git/github.inc
```

daemon 的数据在同一个根里：`~/.eta/daemon/`（见[机器与 daemon](machines.md)），GitHub 登录在 `daemon/github/`，会话在 `daemon/sessions/`。和宿主共用 `$HOME`，各自占一个子目录。记忆边车的数据在它自己的 PostgreSQL，不在这里。

## SQLite

`src/db.ts`：WAL、外键、`busy_timeout`。时间一律是 epoch 毫秒。

**迁移**是一条扁平的编号序列 `apps/eta/src/migrations/NNNN-<name>.sql`，按号码顺序执行，已执行的记在 `eta_migrations`。不合规范的文件名或重复的号码直接报错，不会被静默跳过。新功能要表就加下一个号码；两个分支抢同一个号会在合并时冲突，而不是在某人的数据上出错。数据库不是契约，线协议才是，所以 schema 可以改，只要有迁移。

| 迁移               | 内容                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 agents        | `agent`                                                                                                                                                                                                                    |
| 0002 machines      | `machine`（`primary`、`daemon`、`ssh`；状态 online/offline/pending/revoked）                                                                                                                                               |
| 0003 projects      | `project`（machine + path 唯一）                                                                                                                                                                                           |
| 0004 conversations | `conversation`、`participant`、`message`                                                                                                                                                                                   |
| 0005 interactions  | `interaction`（会话里的提问及结果）                                                                                                                                                                                        |
| 0006 settings      | `setting`（键 + JSON，如审批名单）                                                                                                                                                                                         |
| 0007 usage         | `usage`                                                                                                                                                                                                                    |
| 0008               | `message` 增加 `task_draft`、`task_card` 两种行                                                                                                                                                                            |
| 0009 tasks         | `task`（编号用 AUTOINCREMENT，永不复用）、`task_activity`                                                                                                                                                                  |
| 0010 artifacts     | `artifact`、`artifact_version`、`artifact_share`                                                                                                                                                                           |
| 0011–0013          | `routine`、`routine_run`（同一定时任务同一时刻最多一次运行，由唯一索引保证）、`routine_feedback`、`routine_brief`（简报的版本）                                                                                            |
| 0014               | `machine_enrollment`（一次性安装码，只存摘要）                                                                                                                                                                             |
| 0028               | `attachment`（附件：属于哪个对话、名字、类型、大小、被哪条消息认领；未发送的 24 小时后清理）                                                                                                                               |
| 0033               | `credential`（外部集成的凭据：`integration`、`key`、`kind`、`value` 加密；目前是 MCP 服务器的 OAuth 状态，见 [MCP](mcp.md)）                                                                                               |
| 0034               | `task_run`（任务的运行，同时是队列）；`task` 增加项目、工作区（模式、worktree 路径与分支）、来源对话，去掉 `assignee`；`machine.max_active_runs`（默认 2）；`task_activity` 增加运行类的条目，见[任务](tasks.md)           |
| 0035               | `github_app`、`github_user`（私钥、client secret、用户令牌密封）、`github_pending`（进行中的 manifest 与授权）、`task_pull`（任务交付的 PR），见 [GitHub](github.md)                                                       |
| 0043               | `plugin_source`（git 来源）、`plugin_config`（配置，密封）、`plugin_agent_level`（用户调低的级别）、`agent_plugin`（智能体启用哪些，随智能体删除）、`plugin_audit`（agent 读 secret 的记录，不含值），见[插件](plugins.md) |

外键的取舍：`message.agent_id`、`interaction`、`usage` 里指向智能体和对话的列**没有**外键，因为这些行是历史，比智能体活得久。

## 会话文件

会话（上游 `FileSessionStore`）每个一个目录：`meta.json`（cwd、模型等）与 `journal.jsonl`（追加写的日志，加载时可压缩）。会话的内容不复制进 SQLite；SQLite 里只有 `participant.session_id` 这条指针。重启后 host 按 `participant` 找回会话，新进程读同样的文件。

远端机器上的会话，文件在**那台机器**的 daemon 数据目录里；primary 只存指针（会话属于哪个 machine 由对话所在 project 的 machine 决定）。

## 启动时的收尾

重启的进程认为"上一个进程在途的一切都已经不在了"：`failInterrupted` 把遗留的 queued/working 回复标为失败，`expirePending` 让未回答的提问过期，定时任务里还在 `running` 的运行标为失败，任务里还在 `starting/running` 的运行标为失败，上次在线的 daemon 先标为 offline，等它们重新连上。
