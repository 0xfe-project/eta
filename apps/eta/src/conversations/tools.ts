/**
 * The tools an agent has because it is in a conversation: reaching the other members,
 * looking at the room it is in, and looking at the images the user attached. They are registered on each (agent x conversation) session when
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

  const readImage = defineTool({
    name: "read_image",
    description:
      "Look at an image the user attached in this conversation. Name it by the attachment id or by " +
      "the path you were told for it. Only this conversation's attachments can be read; the answer " +
      "is the image itself, or an error when your model does not support images.",
    parameters: Type.Object({
      file: Type.String({ description: "The attachment id or its path" }),
    }),
    async execute(args) {
      try {
        const image = await engine.image(conversationId, agentId, args.file);
        return {
          content: [
            {
              type: "image" as const,
              data: image.dataBase64,
              mimeType: image.mime,
            },
          ],
          details: undefined,
        };
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  });

  return [
    toKernelTool(mention, () => undefined),
    toKernelTool(info, () => undefined),
    toKernelTool(readImage, () => undefined),
  ] as KernelTool[];
}
