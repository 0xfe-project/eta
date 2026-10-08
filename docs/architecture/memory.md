# 记忆

本文说明 [#12](https://github.com/akarachen/axp/issues/12) 的实现：智能体跨对话的长期记忆。它由两部分组成：runtime 镜像里的 `memory` plugin（见[聊天与运行时架构](chat-runtime.md#plugin)）和 `apps/memory-service`。

```
runtime 容器
  Codex
    memory plugin
      .mcp.json  ── MCP（streamable HTTP）──┐  Authorization: Bearer <runtime key>
      hooks      ── HTTP ──────────────────┤
                                           ▼
runtime 网关 /memory/*  forward_auth → X-AXP-Agent-Id
                                           ▼
memory-service
  MemoryProvider → Mem0Provider（mem0 作为库）
    抽取：智能体自己的模型，经 llm-gateway（chat completions）
    向量：fastembed，CPU 推理
    存储：PostgreSQL + pgvector（表 memories）
```

## 记忆怎么来、怎么用

- **每轮召回**：`UserPromptSubmit` hook 用用户的输入检索，最多 5 条、相关度不低于 0.2 的记忆以 `additionalContext` 加进本轮上下文（Codex 作为 developer 消息发给模型），每条带 id。
- **每轮保存**：`Stop` hook 把本轮的用户输入（含插话）和最终回答交给 `/memory/capture`，立即得到 202；memory-service 在后台逐条用该智能体的模型抽取事实再写入，hook 不等模型。用户输入在召回时暂存在 plugin 的数据目录（`PLUGIN_DATA/turns`），保存后删除；超过一天未结束的 turn 的暂存会被清掉。
- **主动工具**：MCP 工具 `remember`（原样记下一条）、`recall`（检索）、`forget`（按 id 删除）。`skills/memory/SKILL.md` 告诉模型什么时候用它们。
- 两个 hook 任何失败都只是本轮没有记忆，不会影响 turn。服务停止时还在队列里的保存会丢失。

mem0 v2 只追加不改写：同一事实的新说法会成为新记忆，过时的记忆由模型在发现后 `forget`。抽取时要求用用户的语言写事实，否则中文提问很难检索到英文事实。

## 隔离

memory-service 只认 runtime 网关设置的 `X-AXP-Agent-Id`，并把它作为 mem0 的 `user_id`；请求里自称的身份不起作用，没有这个头的请求被拒绝。删除前检查记忆属于该智能体（mem0 按 id 删除不区分用户）。memory-service 不在 runtime 网络上，也不持有任何凭据：调用 llm-gateway 时它同样只带 `X-AXP-Agent-Id`，因此抽取用量记在对应的智能体上。

## Provider 接口

`axp_memory/provider.py` 的 `MemoryProvider` 只有四个方法：`add(agent_id, messages, infer, model)`、`search`、`list`、`delete`。换别的记忆服务只需实现它们并在 `__main__` 中替换；已有记忆用旧 provider 的 `list` 导出，再以 `infer=False` `add` 到新的。plugin、hook、网关都不用改。

## Embedding 模型

`jinaai/jina-embeddings-v2-base-zh`（768 维，中英混合，长输入）。它由 Turbo 的 `build` 任务下载到 `apps/memory-service/out/models`（约 600 MB，缓存），生产镜像带上它，服务运行时不联网。换模型要重新嵌入所有记忆。

## 运行

|             | 开发                                               | 生产                                            |
| ----------- | -------------------------------------------------- | ----------------------------------------------- |
| 进程        | `bun run dev:memory-service`，`127.0.0.1:P+6`      | Kamal 角色 `memory`，网络别名 `axp-memory:8320` |
| 数据库      | 开发 PostgreSQL（`pgvector/pgvector:pg17-trixie`） | accessory `postgres`（同一镜像）                |
| llm-gateway | `AXP_LLM_GATEWAY_URL`（`dev.sh` 设定）             | `http://axp-llm:8317`                           |

PostgreSQL 镜像是 `postgres:17` 加 pgvector，同为 Debian trixie，因此原有数据目录的排序规则不变（bookworm 版的 `pgvector/pgvector:pg17` 会导致 collation 版本不匹配）。mem0 首次启动时创建 `vector` 扩展和 `memories` 表，它们不归 Django 迁移管理。mem0 的遥测已关闭；它的变更历史写在容器内的 SQLite，不保留。
