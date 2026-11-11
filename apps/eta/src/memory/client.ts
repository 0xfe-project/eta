/**
 * The memory sidecar, as the host calls it.
 *
 * The sidecar is another process (mem0 over PostgreSQL) and the host's only link to it is HTTP. An
 * agent is named in `X-AXP-Agent-Id` and the conversation it speaks in in `X-AXP-Group-Id`, which
 * is the sidecar's only notion of identity. Every call is bounded in time: memory is a nicety, and
 * a sidecar that hangs must cost a reply a moment, not the reply.
 */
import type { MemorySource, MemoryView } from "@eta/client-contracts";

const AGENT_HEADER = "X-AXP-Agent-Id";
const GROUP_HEADER = "X-AXP-Group-Id";

/** A memory the sidecar recalled for a prompt. */
export interface Recalled {
  id: string;
  text: string;
  /** Whether it was remembered in the conversation being asked for, or another one. */
  from: "this" | "other" | null;
}

/** What the sidecar sends for a memory; its keys are snake_case. */
interface WireMemory {
  id: string;
  text: string;
  score?: number;
  created_at?: string;
  source?: string;
  source_group_id?: string;
  group_context?: string;
  deleted_at?: string;
  deleted_by?: string;
}

const viewOf = (memory: WireMemory): MemoryView => {
  const created =
    memory.created_at === undefined ? NaN : Date.parse(memory.created_at);
  return {
    id: memory.id,
    text: memory.text,
    score: memory.score ?? null,
    createdAt: Number.isNaN(created) ? null : created,
    source: (memory.source as MemorySource | undefined) ?? null,
    conversationId: memory.source_group_id ?? null,
    deletedAt:
      memory.deleted_at === undefined ||
      Number.isNaN(Date.parse(memory.deleted_at))
        ? null
        : Date.parse(memory.deleted_at),
    deletedBy: memory.deleted_by ?? null,
  };
};

export class MemoryClient {
  readonly #base: string;

  constructor(baseUrl: string) {
    this.#base = baseUrl.replace(/\/+$/, "");
  }

  async #send(
    method: string,
    path: string,
    options: {
      agentId?: string | undefined;
      conversationId?: string | null | undefined;
      body?: unknown;
      timeoutMs: number;
    },
  ): Promise<Response> {
    const response = await fetch(`${this.#base}${path}`, {
      method,
      headers: {
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        // The MCP route answers a lone call as JSON when it is told it may.
        accept: "application/json, text/event-stream",
        ...(options.agentId === undefined
          ? {}
          : { [AGENT_HEADER]: options.agentId }),
        ...(options.conversationId == null
          ? {}
          : { [GROUP_HEADER]: options.conversationId }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `the memory service answered ${response.status}${detail === "" ? "" : `: ${detail.slice(0, 200)}`}`,
      );
    }
    return response;
  }

  /** The memories relevant to a prompt, as the sidecar scores them. */
  async recall(
    agentId: string,
    conversationId: string,
    query: string,
  ): Promise<Recalled[]> {
    const response = await this.#send("POST", "/memory/recall", {
      agentId,
      conversationId,
      body: { query },
      timeoutMs: 3_000,
    });
    const { memories } = (await response.json()) as { memories: WireMemory[] };
    return memories.map((memory) => ({
      id: memory.id,
      text: memory.text,
      from:
        memory.group_context === "this" || memory.group_context === "other"
          ? memory.group_context
          : null,
    }));
  }

  /** A finished turn, to be remembered in the background. */
  async capture(
    agentId: string,
    conversationId: string,
    messages: readonly { role: "user" | "assistant"; content: string }[],
  ): Promise<void> {
    await this.#send("POST", "/memory/capture", {
      agentId,
      conversationId,
      body: { messages },
      timeoutMs: 10_000,
    });
  }

  /** One of the sidecar's MCP tools, called as the agent; its text. */
  async tool(
    agentId: string,
    conversationId: string | undefined,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; structured: unknown }> {
    const response = await this.#send("POST", "/memory/mcp", {
      agentId,
      conversationId,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      timeoutMs: 15_000,
    });
    const reply = (await response.json()) as {
      error?: { message?: string };
      result?: {
        isError?: boolean;
        content?: { type: string; text?: string }[];
        structuredContent?: { result?: unknown };
      };
    };
    if (reply.error !== undefined || reply.result === undefined)
      throw new Error(
        reply.error?.message ?? "the memory service sent no result",
      );
    const text = (reply.result.content ?? [])
      .map((block) => block.text ?? "")
      .join("\n");
    if (reply.result.isError === true) throw new Error(text);
    return { text, structured: reply.result.structuredContent?.result };
  }

  /** The agent's memories, newest first, or the ones matching `query` best first. */
  async list(
    agentId: string,
    filters: {
      query?: string;
      source?: string;
      conversationId?: string;
      includeDeleted?: boolean;
    } = {},
  ): Promise<MemoryView[]> {
    const params = new URLSearchParams();
    if (filters.query) params.set("q", filters.query);
    if (filters.source) params.set("source", filters.source);
    if (filters.conversationId) params.set("group_id", filters.conversationId);
    if (filters.includeDeleted === true) params.set("include_deleted", "1");
    const search = params.size === 0 ? "" : `?${params}`;
    const response = await this.#send(
      "GET",
      `/api/memory/v1/agents/${encodeURIComponent(agentId)}/memories${search}`,
      { timeoutMs: 15_000 },
    );
    const { memories } = (await response.json()) as { memories: WireMemory[] };
    return memories.map(viewOf);
  }

  /** The user writes a memory by hand. */
  async add(agentId: string, text: string): Promise<MemoryView> {
    const response = await this.#send(
      "POST",
      `/api/memory/v1/agents/${encodeURIComponent(agentId)}/memories`,
      { body: { text }, timeoutMs: 15_000 },
    );
    return viewOf((await response.json()) as WireMemory);
  }

  async forget(agentId: string, id: string): Promise<void> {
    await this.#send(
      "DELETE",
      `/api/memory/v1/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(id)}`,
      { timeoutMs: 15_000 },
    );
  }

  async softDelete(
    agentId: string,
    id: string,
    deletedBy: string,
  ): Promise<void> {
    await this.#send(
      "DELETE",
      `/api/memory/v1/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(id)}/soft`,
      { body: { deleted_by: deletedBy }, timeoutMs: 15_000 },
    );
  }

  async restore(agentId: string, id: string): Promise<void> {
    await this.#send(
      "POST",
      `/api/memory/v1/agents/${encodeURIComponent(agentId)}/memories/${encodeURIComponent(id)}/restore`,
      { timeoutMs: 15_000 },
    );
  }
}
