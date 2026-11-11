/**
 * The `memory` plugin: the user's view of what the sidecar remembers.
 *
 * A target with calls and no state, since the sidecar is the store. Mounted only when the host was
 * given a sidecar; without one there is no target, and a client sees none in `hello`.
 */
import type { MemorySource } from "@eta/client-contracts";
import type { MemoryClient } from "./client";
import { Args, productPlugin } from "../wire";

export interface MemoryPluginDeps {
  client: MemoryClient;
}

const SOURCES: readonly string[] = ["conversation", "agent", "user"];

export function memoryPlugin(deps: MemoryPluginDeps, applied: () => void) {
  const { client } = deps;
  return productPlugin(
    "memory",
    ({ wire }) => {
      const offs = [
        wire.handle("memory", "list", async (call) => {
          const args = new Args(call);
          const source = args.optionalString("source");
          if (source !== undefined && !SOURCES.includes(source))
            throw new Error(
              `memory.list: source must be ${SOURCES.join(", ")}`,
            );
          const query = args.optionalString("query")?.trim();
          const conversationId = args.optionalString("conversationId");
          const includeDeleted = args.optionalBoolean("includeDeleted");
          const memories = await client.list(args.string("agentId"), {
            ...(query ? { query } : {}),
            ...(source === undefined ? {} : { source: source as MemorySource }),
            ...(conversationId ? { conversationId } : {}),
            ...(includeDeleted === undefined ? {} : { includeDeleted }),
          });
          return { result: { memories } };
        }),

        wire.handle("memory", "remember", async (call) => {
          const args = new Args(call);
          const memory = await client.add(
            args.string("agentId"),
            args.string("text").trim(),
          );
          return { result: { memory } };
        }),

        wire.handle("memory", "forget", async (call) => {
          const args = new Args(call);
          const id = args.string("id");
          await client.forget(args.string("agentId"), id);
          return { result: { id } };
        }),

        wire.handle("memory", "restore", async (call) => {
          const args = new Args(call);
          const id = args.string("id");
          await client.restore(args.string("agentId"), id);
          return { result: { id } };
        }),
      ];
      return () => {
        for (const off of offs.splice(0)) off();
      };
    },
    applied,
  );
}
