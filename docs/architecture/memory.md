# 记忆

本文说明 [#12](https://github.com/akarachen/axp/issues/12) 的实现：智能体跨对话的长期记忆。它是必选的内置环境包 `memory`：runtime 镜像里的 `memory` plugin（见[聊天与运行时架构](chat-runtime.md#plugin)），和这个环境包的服务 `bundles/memory/service`（[环境包](bundles.md#服务)）。

```
runtime 容器
  Codex
    memory plugin
      .mcp.json  ── MCP（streamable HTTP）──┐  Authorization: Bearer <runtime key>
      hooks      ── HTTP ──────────────────┤
                                           ▼
runtime 网关 /bundles/memory/* → /memory/*  forward_auth → X-AXP-Agent-Id、X-AXP-Group-Id
                                           ▼
memory-service（Nomad job memory，命名空间 <ns>）
  MemoryProvider → Mem0Provider（mem0 作为库）
    抽取：智能体自己的模型，带环境包的令牌经 runtime 网关的 /v1（chat completions）
    向量：fastembed（CPU 推理），或网关的 /v1/embeddings（Gemini）
    存储：自己的库 axp_bundle_memory（PostgreSQL + pgvector，每个向量空间一张表）
```

## 记忆怎么来、怎么用

- 两个 hook 的脚本在 plugin 目录（`hooks/memory.mjs`），声明在插件的 `akhook.yml`（akhook 的 `prompt_submit` 和 `stop` 规则），由 akhook 运行，每个智能体都通过必选的 memory 环境包装载（见[插件](plugins.md#hook)）。
- **每轮召回**：`prompt_submit`（Codex 的 `UserPromptSubmit`） 用用户的输入检索，最多 5 条、相关度不低于 0.2 的记忆以 `additionalContext` 加进本轮上下文（Codex 作为 developer 消息发给模型），每条带 id；有来源群时只标明“本群”或“其他群”，没有来源的不标。
- **每轮保存**：`stop` 把本轮的用户输入（含插话）和最终回答交给 `/memory/capture`，立即得到 202；memory-service 在后台逐条用该智能体的模型抽取事实再写入，hook 不等模型。用户输入在召回时暂存在 `CODEX_HOME/axp-memory/turns`，保存后删除；超过一天未结束的 turn 的暂存会被清掉。
- **主动工具**：MCP 工具 `remember`（原样记下一条）、`recall`（检索）、`forget`（按 id 删除）。`skills/memory/SKILL.md` 告诉模型什么时候用它们。
- 两个 hook 任何失败都只是本轮没有记忆，不会影响 turn。服务停止时还在队列里的保存会丢失。

mem0 v2 只追加不改写：同一事实的新说法会成为新记忆，过时的记忆由模型在发现后 `forget`。抽取时要求用用户的语言写事实，否则中文提问很难检索到英文事实。

## 在界面中查看和编辑

全窗口工作区的「记忆」页列出当前智能体的记忆（新的在前，每 15 秒刷新），可以搜索、手动添加（原样记下，不经模型抽取）和删除。浏览器经公共网关的 `/api/bundles/memory/*` 访问记忆服务，网关把路径改成下表的 `/api/memory/*`：

记忆页面提供种类筛选：对话中记下（`conversation`）、智能体记下（`agent`）、手动添加（`user`），或全部种类。GET 接口可带 `source=`，与 `q=` 组合；存储先按来源筛选，再应用列表最多 1000 条、搜索最多 50 条的现有上限。未指定种类时显示全部记忆。前端每页显示 20 条，切换种类、来源群、搜索或智能体时回到第一页。

| 方法与路径                                           | 作用                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/memory/v1/agents/{agent}/memories`         | 列出全部；带 `?q=` 时按相关度检索，最多 50 条、相关度不低于 0.2 |
| `POST /api/memory/v1/agents/{agent}/memories`        | `{"text"}`，原样记下一条                                        |
| `DELETE /api/memory/v1/agents/{agent}/memories/{id}` | 删除；不属于该智能体时 404                                      |

这组接口的智能体由路径指定，因为用户可以看所有智能体的记忆。它们只能从公共网关到达：runtime 网关只把 `/bundles/memory/*` 转成 `/memory/*`，智能体碰不到 `/api/memory/*`。

## 来源群

长期记忆仍按智能体共享，跨群召回不加群过滤。`remember` 和 `capture` 从 runtime 网关的 `X-AXP-Group-Id` 取来源群。来源在接收请求时记下，再跟随后台抽取入队；模型和请求正文不能指定来源。

mem0 metadata 和公开记忆形状只保存 `source_group_id`。Web 按群快照查当前名称，群改名后同步更新，不在记忆中保留旧名。MCP recall 和 hook 的 `/memory/recall` 在返回时将来源 id 与网关注入的 `X-AXP-Group-Id` 比较，以临时字段 `group_context` 标明 `this`（本群）或 `other`（其他群），没有来源的不标；这两种召回结果不带来源 id。hook 只把标注写进上下文，不查询群，也不依赖 groups 插件路由。手动添加的记忆没有来源群。Web 显示可跳回群的来源名，GET 的 `group_id=` 可与 `source=`、`q=` 组合，存储先过滤再应用条数上限。skill 要求引用其他群的事实时说明来自别的群，必要时请用户确认，不把它当作当前群已经达成的决定。不写 `MEMORY.md`，不为群另建记忆库。

## 隔离

memory-service 只认 runtime 网关设置的 `X-AXP-Agent-Id`，并把它作为 mem0 的 `user_id`；请求里自称的身份不起作用，没有这个头的请求被拒绝。删除前检查记忆属于该智能体（mem0 按 id 删除不区分用户）。记忆服务只有 AXP 给它的凭据：它的库的账号，和只能调用模型的环境包令牌。调用模型时它在 `X-AXP-Agent-Id` 里写明是哪个智能体的抽取，因此用量记在对应的智能体上。

## Provider 接口

`axp_memory/provider.py` 的 `MemoryProvider` 只有四个方法：`add(agent_id, messages, infer, model)`、`search`、`list`、`delete`。换别的记忆服务只需实现它们并在 `__main__` 中替换；已有记忆用旧 provider 的 `list` 导出，再以 `infer=False` `add` 到新的。plugin、hook、网关都不用改。

## Embedding 模型

默认是本地的 `jinaai/jina-embeddings-v2-base-zh`（768 维，中英混合，长输入）。它由 Turbo 的 `build` 任务下载到 `bundles/memory/service/out/models`（约 600 MB，缓存），生产镜像带上它，本地模型运行时不联网。也可以改用 Gemini 的 `gemini-embedding-001` 或 `gemini-embedding-2-preview`（[#273](https://github.com/0xfe-project/eta/issues/273)）：经 runtime 网关调用 LLM 网关的 `/v1/embeddings`（[LLM 网关](llm-gateway.md#embedding)），用环境包的令牌，`X-AXP-Agent-Id` 写明是哪个智能体的记忆，用量记在它名下；凭据是模型服务里的 Google AI Studio 账号，记忆服务只认 OpenAI 格式。

### 向量空间

一个空间是 embedder 加维度：`local`（fastembed）或 `gateway:<模型>`，维度目前固定 768。每个空间一张表 `memories_<embedder>_<维度>`，mem0 的实体表在旁边（`<表>_entities`），不同空间的向量不会出现在同一次检索里。原有的 `memories` 表就是本地 768 维这个空间。`embedding_settings`（单行）记当前空间和上一个空间的表；首次启动没有这一行时把 `memories` 登记为当前空间，不动数据。

### 重建

换模型要重算所有向量，由 `axp_memory/rebuild.py` 在后台做，期间召回和保存照常走当前空间。任务的状态在 `embedding_rebuild`（单行：目标空间、`status`、阶段、游标、`done`/`total`、连续失败次数、错误、重试时间），服务重启后从游标继续。任何时刻最多一个任务；来了新目标就丢掉当前任务的半成品表，重新开始。

1. 探测：用目标 embedder 嵌一段文本，向量长度不对或请求失败直接 `failed`，不建表。然后删掉上一个空间留下的表（它保留到下一次重建开始，作为回滚手段）和目标的残留表，建新表。
2. 复制：按 id 做 keyset 分页遍历当前空间的记忆表，再遍历实体表，每批 50 条，按 `payload->>'user_id'` 分组嵌入（各算在各自智能体名下），payload 原样复制，id 不变；每批和游标、`done` 在同一事务里写入。
3. 追平：任务开始后 provider 的每次保存和删除除了写当前空间，还往 `embedding_rebuild_changes` 记 id 和操作。复制完消费这张表：当前空间里还在的重新嵌入写进新表，不在了的从新表删掉，直到表空。mem0 自己维护的实体表按差异追平（实体的文字不变，只有关联的记忆变）。
4. 切换：关上写入闸门（等进行中的保存和删除做完，新的等着），做最后一轮追平，在同一事务里改 `embedding_settings`、把任务标成 `done`，再原子替换 provider 里的 mem0 实例，打开闸门。搜索从此走新空间。

429、5xx 和网络错误按 1、2、4、8 秒退避重试，连续 5 次失败转 `paused`；网关说没有可用的 Google AI Studio 账号（503 `no_account`）或拒绝请求（其他 4xx）时直接 `paused`。`paused` 的任务每分钟自动重试，错误显示在界面上。

切错了可以切回去，但那也是一次重建：旧表缺少期间的新记忆。worker 不加跨进程锁，假设记忆服务只有一个实例（Nomad job `memory` 只有一个 alloc），多副本时要加 advisory lock。`capture` 的进程内队列重启即丢，不在这里解决。

### 接口与界面

经公共网关的 `/api/bundles/memory/v1/embedding`（服务里是 `/api/memory/v1/embedding`），runtime 网关到不了，智能体改不了它：

| 方法与路径                                | 作用                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /api/memory/v1/embedding`            | 当前空间、当前空间的记忆条数、最近一次任务（`status`、`done`、`total`、`error`、时间）    |
| `PUT /api/memory/v1/embedding`            | `{"model": "local" \| "gateway:<模型>", "dims"}`：与当前相同返回 409，否则 202 并开始重建 |
| `DELETE /api/memory/v1/embedding/rebuild` | 取消进行中的重建，丢掉半成品表；没有时 404                                                |

设置 → 模型服务的“记忆 embedding”下拉框列出本地模型和 `GET /api/llm/v1/embedding-models` 的模型，没有可用的 Google AI Studio 账号时 Gemini 的选项禁用并说明原因。切换前确认，说明会重算全部记忆（附条数）并消耗配额；重建中显示进度条，每 5 秒刷新，可以取消，暂停或失败时显示原因。

## 运行

开发和生产一样：controller 按 `bundles/memory/service/job.nomad.hcl` 把它作为 job `memory` 运行在 AXP 的命名空间里，镜像 `axp-memory` 由 `bundles/memory/service/Dockerfile` 从 Turbo 的产物打包（`scripts/build/image.sh memory`）。库 `axp_bundle_memory` 由 AXP 在 PostgreSQL（`pgvector/pgvector:pg17-trixie`）上创建并装好 `vector` 扩展，连接串在环境变量 `DATABASE_URL`；mem0 首次启动时创建 `memories` 表，记忆服务启动时创建 `embedding_settings`、`embedding_rebuild` 和 `embedding_rebuild_changes`。它在 `/.well-known/axp-service` 报告协议 `axp.memory/1`。

PostgreSQL 镜像是 `postgres:17` 加 pgvector，同为 Debian trixie，因此原有数据目录的排序规则不变（bookworm 版的 `pgvector/pgvector:pg17` 会导致 collation 版本不匹配）。mem0 的遥测已关闭；它的变更历史写在容器内的 SQLite，不保留。
