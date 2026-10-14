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
memory-service（Service memory，命名空间 <ns>-bundles）
  MemoryProvider → Mem0Provider（mem0 作为库）
    抽取：智能体自己的模型，带环境包的令牌经 runtime 网关的 /v1（chat completions）
    向量：fastembed，CPU 推理
    存储：自己的库 axp_bundle_memory（PostgreSQL + pgvector，表 memories）
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

`jinaai/jina-embeddings-v2-base-zh`（768 维，中英混合，长输入）。它由 Turbo 的 `build` 任务下载到 `bundles/memory/service/out/models`（约 600 MB，缓存），生产镜像带上它，服务运行时不联网。换模型要重新嵌入所有记忆。

## 运行

开发和生产一样：controller 按 `bundles/memory/service/memory.yaml` 把它部署到 `<ns>-bundles`，镜像 `axp-memory` 由 `bundles/memory/service/Dockerfile` 从 Turbo 的产物打包（`scripts/build/image.sh memory`）。库 `axp_bundle_memory` 由 AXP 在 PostgreSQL（`pgvector/pgvector:pg17-trixie`）上创建并装好 `vector` 扩展，连接串在 Secret `axp-memory`；mem0 首次启动时创建 `memories` 表。它在 `/.well-known/axp-service` 报告协议 `axp.memory/1`。

PostgreSQL 镜像是 `postgres:17` 加 pgvector，同为 Debian trixie，因此原有数据目录的排序规则不变（bookworm 版的 `pgvector/pgvector:pg17` 会导致 collation 版本不匹配）。mem0 的遥测已关闭；它的变更历史写在容器内的 SQLite，不保留。从 Kamal 迁移时，主库原来的 `memories` 表被复制到 `axp_bundle_memory`（`deploy/k3s/migrate-from-kamal.sh`）。
