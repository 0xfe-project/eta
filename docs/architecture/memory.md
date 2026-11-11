# Memory

Long-term memory for agents across conversations. It is an **optional sidecar**: `apps/memory`, Python (mem0 as a library + fastembed CPU vectors), its own PostgreSQL (pgvector, table `memories`). The host calls it over HTTP; the host does no memory work in-process.

```
host ──HTTP──▶ memory sidecar (:8320)
  memory plugin        POST /memory/recall   before run: memories relevant to what will be told to the agent
  engine's run hook  POST /memory/capture  after run: a completed conversation turn, extracted in the background
  session tools           /memory/mcp           remember / recall / forget (MCP, streamable HTTP)
  memory target      /api/memory/v1/agents/{agent}/memories   users view, search, add, delete
                                          │
                                          ▼  extraction: MEMORY_LLM_* (OpenAI-compatible); vectors: fastembed; storage: PostgreSQL + pgvector
```

## Identity

The sidecar only looks at request headers: `X-AXP-Agent-Id` (agent) and `X-AXP-Group-Id` (conversation id). On agent-side routes, this header is the only identity, so an agent can only touch its own memories. User-side routes put the agent in the path (users can see and edit memories of all agents). **The sidecar has no authentication; the network is the trust boundary**: only let the host reach it (loopback, or an internal network in compose with no published ports).

## host side

Memory is only available when a sidecar address is provided: `--memory-url <url>`, or the environment variable `ETA_MEMORY_URL` (flag takes precedence; an empty value means none). Without an address: the `memory` plugin is not mounted, there is no `memory` target, no memory tools, and no requests are sent anywhere; it is absent from `hello.mounted`, and the UI hides the memory page.

- **before run** (`beforeRun`): uses the last 2000 characters of the briefing to be told to the agent as the query for `recall`; up to 5 memories with relevance no lower than 0.2 are placed before the briefing, each labeled "this conversation" or "another conversation".
- **after run** (`afterRun`): only saves if the reply ends with `done`—the triggering message and the agent's answer are passed as one turn to `capture`; the sidecar immediately returns 202 and, in the background, extracts facts one by one with the extraction model before writing them. Failed or stopped replies are not worth remembering.
- **Tools**: each session installs `remember` (records an entry as-is), `recall` (retrieves), `forget` (deletes by id).
- **User side**: `memory.list` (filterable by source `conversation` / `agent` / `user`, searchable), `memory.remember` (add manually, recorded as-is, without extraction), `memory.forget`.

Memory is a nice-to-have: every call has a timeout (recall 3 seconds); if the sidecar is slow or absent, the run proceeds as usual; hook errors are only reported and do not fail the reply. When the sidecar stops, anything still queued and unsaved is lost.

mem0 v2 only appends, never rewrites: a new phrasing of the same fact becomes a new memory; outdated ones are found by the model and removed with `forget`. Extraction requires facts to be written in the user's language; otherwise Chinese questions will have trouble retrieving English facts.

## Running the sidecar

Environment variables:

| Variable              | Meaning                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Its own PostgreSQL (requires the pgvector extension)                                                          |
| `MEMORY_LLM_BASE_URL` | OpenAI-compatible API base (e.g. `https://api.openai.com/v1`), used to extract facts from a conversation turn |
| `MEMORY_LLM_API_KEY`  | The key for the API above                                                                                     |
| `MEMORY_LLM_MODEL`    | Model used for extraction                                                                                     |
| `MEMORY_HOST`         | Network interface to listen on, default `127.0.0.1`                                                           |
| `MEMORY_PORT`         | Port, default `8320`                                                                                          |

The extraction model is configured by the sidecar itself and is unrelated to the host's providers. The embedding model is `jinaai/jina-embeddings-v2-base-zh` (768 dimensions, mixed Chinese and English); changing the model means re-embedding all memories.

Local development: after `bun run setup` installs the Python dependencies, first run `bun run --cwd apps/memory build` to download the embedding model to `apps/memory/out/models`, then in the `apps/memory` directory run `FASTEMBED_CACHE_PATH=out/models uv run python -m axp_memory` (with the environment variables above), and start the host with `--memory-url http://127.0.0.1:8320`. For containerization, see `deploy/memory.Dockerfile` and the `memory` profile in `deploy/compose.yaml` (with a `pgvector/pgvector` database).
