# 记忆

智能体跨对话的长期记忆。它是一个**可选的边车**：`apps/memory`，Python（mem0 作为库 + fastembed 的 CPU 向量），自己的 PostgreSQL（pgvector，表 `memories`）。host 通过 HTTP 调用它；host 不在进程内做任何记忆。

```
host ──HTTP──▶ 记忆边车 (:8320)
  memory 插件        POST /memory/recall   run 之前：与要告诉智能体的内容相关的记忆
  engine 的 run 钩子  POST /memory/capture  run 之后：一轮完成的对话，后台抽取
  会话工具           /memory/mcp           remember / recall / forget（MCP，streamable HTTP）
  memory target      /api/memory/v1/agents/{agent}/memories   用户看、搜、加、删
                                          │
                                          ▼  抽取：MEMORY_LLM_*（OpenAI 兼容）；向量：fastembed；存储：PostgreSQL + pgvector
```

## 身份

边车只认请求头：`X-AXP-Agent-Id`（智能体）与 `X-AXP-Group-Id`（对话 id）。agent 侧的路由里这个头是唯一的身份，所以智能体只能碰到自己的记忆。用户侧的路由把智能体写在路径里（用户能看见并编辑所有智能体的记忆）。**边车没有鉴权，网络就是信任边界**：只让 host 到得了它（loopback，或 compose 里不发布端口的内部网络）。

## host 一侧

只有给了边车地址才有记忆：`--memory-url <url>`，或环境变量 `ETA_MEMORY_URL`（flag 优先，空值表示没有）。没有地址时：不挂载 `memory` 插件，没有 `memory` target，没有记忆工具，也不会向任何地方发请求；`hello.mounted` 里没有它，界面隐藏记忆页。

- **run 之前**（`beforeRun`）：把要告诉智能体的 briefing 的末尾 2000 字作为查询去 `recall`，最多 5 条、相关度不低于 0.2 的记忆放在 briefing 之前，每条标注是"本对话"还是"另一个对话"。
- **run 之后**（`afterRun`）：只有回复以 `done` 结束才保存——触发消息和智能体的回答作为一轮交给 `capture`，边车立即回 202，在后台用抽取模型逐条抽取事实再写入。失败或被停止的回复不值得记。
- **工具**：每个会话装 `remember`（原样记一条）、`recall`（检索）、`forget`（按 id 删）。
- **用户侧**：`memory.list`（可按来源 `conversation` / `agent` / `user` 筛，可搜索）、`memory.remember`（手动添加，原样记下，不经抽取）、`memory.forget`。

记忆是锦上添花：每次调用都有时限（recall 3 秒），边车慢或不在时这一轮照常进行；钩子抛错只被报告，不会让回复失败。边车停止时队列里还没保存的会丢失。

mem0 v2 只追加不改写：同一事实的新说法会成为新记忆，过时的由模型发现后 `forget`。抽取要求用用户的语言写事实，否则中文提问很难检索到英文事实。

## 运行边车

环境变量：

| 变量                  | 含义                                                                                |
| --------------------- | ----------------------------------------------------------------------------------- |
| `DATABASE_URL`        | 它自己的 PostgreSQL（需要 pgvector 扩展）                                           |
| `MEMORY_LLM_BASE_URL` | OpenAI 兼容 API 的 base（如 `https://api.openai.com/v1`），用来从一轮对话里抽取事实 |
| `MEMORY_LLM_API_KEY`  | 上面那个 API 的 key                                                                 |
| `MEMORY_LLM_MODEL`    | 抽取用的模型                                                                        |
| `MEMORY_HOST`         | 监听的网卡，默认 `127.0.0.1`                                                        |
| `MEMORY_PORT`         | 端口，默认 `8320`                                                                   |

抽取模型由边车自己配置，与 host 的 providers 无关。向量模型是 `jinaai/jina-embeddings-v2-base-zh`（768 维，中英混合），换模型意味着重新嵌入全部记忆。

本地开发：`bun run setup` 装好 Python 依赖后，先 `bun run --cwd apps/memory build` 把向量模型下载到 `apps/memory/out/models`，再在 `apps/memory` 目录里 `FASTEMBED_CACHE_PATH=out/models uv run python -m axp_memory`（带上面的环境变量），host 以 `--memory-url http://127.0.0.1:8320` 启动。容器化见 `deploy/memory.Dockerfile` 与 `deploy/compose.yaml` 的 `memory` profile（带一个 `pgvector/pgvector` 数据库）。
