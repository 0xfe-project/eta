/**
 * What memory does for a session: remembers around a wake's run, and gives the agent tools.
 *
 * Around a run: before it, what the agent is about to be told is the question put to the memory
 * ("what do I remember that bears on this?"), and the answer goes ahead of the briefing; after it,
 * a reply that ended `done` is handed over as one turn to remember, in the background. A failed or
 * stopped reply says nothing worth keeping. Memory is a nicety: when the sidecar is slow or down
 * the run goes on without it (the engine reports a hook that threw and carries on).
 *
 * As tools: `remember`, `recall` and `forget` are the sidecar's own MCP tools, called as the
 * agent, in the conversation the session belongs to.
 */
import type { KernelTool } from "@eta/core";
import type { SessionMeta } from "@eta/server";
import type { RunHooks } from "../conversations/engine";
import type { MemoryClient, Recalled } from "./client";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";

/** The tail of the briefing used as the question: the newest words are the ones that matter. */
const QUERY_CHARS = 2_000;

function recalledBlock(memories: readonly Recalled[]): string {
  const lines = memories.map(
    (memory) =>
      `- ${memory.text}${memory.from === "other" ? " (from another conversation)" : ""}`,
  );
  return [
    "[things you remember that may bear on this]",
    ...lines,
    "[end of memories]",
  ].join("\n");
}

export function memoryRunHooks(client: MemoryClient): RunHooks {
  return {
    async beforeRun(run) {
      const memories = await client.recall(
        run.agentId,
        run.conversationId,
        run.told.slice(-QUERY_CHARS),
      );
      return memories.length === 0 ? undefined : recalledBlock(memories);
    },
    async afterRun(run) {
      if (run.status !== "done") return;
      const asked = run.trigger.text.trim();
      const answered = run.said.trim();
      if (asked === "" || answered === "") return;
      await client.capture(run.agentId, run.conversationId, [
        { role: "user", content: asked },
        { role: "assistant", content: answered },
      ]);
    },
  };
}

export function memoryTools(
  client: MemoryClient,
  input: { meta: SessionMeta },
): KernelTool[] {
  const { agentId, conversationId } = input.meta;
  if (agentId === undefined) return [];

  const call = async (name: string, args: Record<string, unknown>) => {
    try {
      return await client.tool(agentId, conversationId, name, args);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };

  const remember = defineTool({
    name: "remember",
    description:
      "Remember a fact for later conversations, as one short statement. Use it for lasting facts " +
      "and preferences the user states or that you learn, not for the task at hand.",
    parameters: Type.Object({
      text: Type.String({ description: "The fact, as one short statement" }),
    }),
    async execute(args) {
      const done = await call("remember", { text: args.text });
      return done instanceof Error
        ? toolError(done.message)
        : text(`Remembered: ${args.text}`);
    },
  });

  const recall = defineTool({
    name: "recall",
    description:
      "Search what you remember. Memories from another conversation are marked as such.",
    parameters: Type.Object({
      query: Type.String({ description: "What to look for" }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description: "At most this many",
        }),
      ),
    }),
    async execute(args) {
      const found = await call("recall", {
        query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      if (found instanceof Error) return toolError(found.message);
      const memories = Array.isArray(found.structured)
        ? (found.structured as {
            id: string;
            text: string;
            group_context?: string;
          }[])
        : [];
      if (memories.length === 0) return text("Nothing remembered matches.");
      return text(
        memories
          .map(
            (memory) =>
              `- [${memory.id}] ${memory.text}${memory.group_context === "other" ? " (from another conversation)" : ""}`,
          )
          .join("\n"),
      );
    },
  });

  const forget = defineTool({
    name: "forget",
    description:
      "Forget a memory that is wrong or no longer true, by the id `recall` gave.",
    parameters: Type.Object({
      memoryId: Type.String({ description: "The memory's id" }),
    }),
    async execute(args) {
      const done = await call("forget", { memory_id: args.memoryId });
      return done instanceof Error
        ? toolError(done.message)
        : text(`Forgot ${args.memoryId}.`);
    },
  });

  return [
    toKernelTool(remember, () => undefined),
    toKernelTool(recall, () => undefined),
    toKernelTool(forget, () => undefined),
  ] as KernelTool[];
}
