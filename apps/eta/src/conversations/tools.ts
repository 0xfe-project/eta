/**
 * The two tools an agent has because it is in a conversation: reaching the other members, and
 * looking at the room it is in. They are registered on each (agent x conversation) session when
 * it opens (`sessionTools`), so they know which conversation and which agent they speak for
 * without being told.
 */
import type { KernelTool } from "@eta/core";
import type { Engine } from "./engine";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";

export function conversationTools(
  engine: Engine,
  conversationId: string,
  agentId: string,
): KernelTool[] {
  const mention = defineTool({
    name: "mention",
    description:
      "Say something to other members of this conversation and wake them. Name them as they are " +
      "named in the conversation. They see your message and answer in the conversation; you do not " +
      "wait for them. A thread has a limited number of wake-ups, so mention only when someone else " +
      "has to act or know.",
    parameters: Type.Object({
      agents: Type.Array(Type.String(), {
        minItems: 1,
        description: "The names of the members to wake",
      }),
      message: Type.String({
        description: "What you want them to do or to know",
      }),
    }),
    execute(args) {
      const result = engine.mention({
        conversationId,
        agentId,
        names: args.agents,
        text: args.message,
      });
      return result.ok ? text(result.text) : toolError(result.text);
    },
  });

  const info = defineTool({
    name: "conversation_info",
    description:
      "Who is in this conversation, its goal and what has been decided, and the project directory it works in.",
    parameters: Type.Object({}),
    execute() {
      return text(engine.describe(conversationId, agentId));
    },
  });

  return [
    toKernelTool(mention, () => undefined),
    toKernelTool(info, () => undefined),
  ] as KernelTool[];
}
