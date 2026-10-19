# 数据

产品数据在 SQLite（`bun:sqlite`），会话照上游存成文件。所有东西在**一个数据目录**里：`--data-dir`，默认 `~/.eta`；Docker 镜像里是卷 `/data`，由非 root 用户 `bun`（uid 1000）拥有，host 与会话的 bash 都以它运行。

## 目录布局

```text
<数据目录>/
  eta.sqlite(-wal, -shm)    产品数据库
  config.json               上游设置（模型、provider 等；providers 插件维护）
  llm/                      LLM 网关的状态：auths/ 凭据、models.json、providers.json（Gemini key）
  sessions/<会话 id>/       上游会话：meta.json + journal.jsonl（本机会话）
  attachments/<对话 id>/    用户附在消息上的文件：<附件 id>-<文件名>（上传中是 .up-<id>，重启时清理）
  agents/<智能体 id>/       智能体的工作区（它同时是一个 project）
  routines/<定时任务 id>/   定时任务每次运行的工作目录
  artifacts/<产物 id>/<版本>/   archive.zip 与解压后的 files/；artifacts/.preview-key 是预览地址的签名密钥
  plugins/、modules/        用户插件（热重载）
  access-token              令牌门的令牌（开启时；0600）
  secret.key                环境包配置、MCP 与 GitHub 的密封密钥（0600，第一次用时生成）
  github/                   这台机器上 git 与 gh 的 GitHub 登录（令牌最多一小时，见 [GitHub](github.md)）：gh/hosts.yml、token、login、git/github.inc
  bundles/<包名>/           环境包服务的数据目录（`ETA_BUNDLE_DATA`）
```

环境包的目录不在数据目录里：内置的在仓库的 `bundles/`，用户的在 `~/.eta/bundles/<name>/`，来自 git 的在 `~/.eta/bundles/git/<哈希>/`（见[环境包](bundles.md)）。

daemon 有自己的数据目录（默认 `~/.eta-daemon`，见[机器与 daemon](machines.md)；收到的环境包在它的 `bundles/<哈希>/`，GitHub 登录在它的 `github/`）。记忆边车的数据在它自己的 PostgreSQL，不在这里。

## SQLite

`src/db.ts`：WAL、外键、`busy_timeout`。时间一律是 epoch 毫秒。

**迁移**是一条扁平的编号序列 `apps/eta/src/migrations/NNNN-<name>.sql`，按号码顺序执行，已执行的记在 `eta_migrations`。不合规范的文件名或重复的号码直接报错，不会被静默跳过。新功能要表就加下一个号码；两个分支抢同一个号会在合并时冲突，而不是在某人的数据上出错。数据库不是契约，线协议才是，所以 schema 可以改，只要有迁移。

| 迁移               | 内容                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 agents        | `agent`                                                                                                                                                              |
| 0002 machines      | `machine`（`primary`、`daemon`、`ssh`；状态 online/offline/pending/revoked）                                                                                         |
| 0003 projects      | `project`（machine + path 唯一）                                                                                                                                     |
| 0004 conversations | `conversation`、`participant`、`message`                                                                                                                             |
| 0005 interactions  | `interaction`（会话里的提问及结果）                                                                                                                                  |
| 0006 settings      | `setting`（键 + JSON，如审批名单）                                                                                                                                   |
| 0007 usage         | `usage`                                                                                                                                                              |
| 0008               | `message` 增加 `task_draft`、`task_card` 两种行                                                                                                                      |
| 0009 tasks         | `task`（编号用 AUTOINCREMENT，永不复用）、`task_activity`                                                                                                            |
| 0010 artifacts     | `artifact`、`artifact_version`、`artifact_share`                                                                                                                     |
| 0011–0013          | `routine`、`routine_run`（同一定时任务同一时刻最多一次运行，由唯一索引保证）、`routine_feedback`、`routine_brief`（简报的版本）                                      |
| 0014               | `machine_enrollment`（一次性安装码，只存摘要）                                                                                                                       |
| 0028               | `attachment`（附件：属于哪个对话、名字、类型、大小、被哪条消息认领；未发送的 24 小时后清理）                                                                         |
| 0032               | `bundle_config`（环境包的配置，加密）、`bundle_source`（来自 git 的包：仓库、rev、路径、解析出的提交）、`agent.bundles`（智能体载入的包，JSON 名单）                 |
| 0033               | `credential`（外部集成的凭据：`integration`、`key`、`kind`、`value` 加密；目前是 MCP 服务器的 OAuth 状态，见 [MCP](mcp.md)）                                         |
| 0034               | `github_app`、`github_user`（私钥、client secret、用户令牌密封）、`github_pending`（进行中的 manifest 与授权）、`task_pull`（任务交付的 PR），见 [GitHub](github.md) |

外键的取舍：`message.agent_id`、`interaction`、`usage` 里指向智能体和对话的列**没有**外键，因为这些行是历史，比智能体活得久。

## 会话文件

会话（上游 `FileSessionStore`）每个一个目录：`meta.json`（cwd、模型等）与 `journal.jsonl`（追加写的日志，加载时可压缩）。会话的内容不复制进 SQLite；SQLite 里只有 `participant.session_id` 这条指针。重启后 host 按 `participant` 找回会话，新进程读同样的文件。

远端机器上的会话，文件在**那台机器**的 daemon 数据目录里；primary 只存指针（会话属于哪个 machine 由对话所在 project 的 machine 决定）。

## 启动时的收尾

重启的进程认为"上一个进程在途的一切都已经不在了"：`failInterrupted` 把遗留的 queued/working 回复标为失败，`expirePending` 让未回答的提问过期，定时任务里还在 `running` 的运行标为失败，上次在线的 daemon 先标为 offline，等它们重新连上。
