/**
 * The primary's tools, as a session on a daemon sees them.
 *
 * The tools a product adds to a session (reaching other members, the task board, memory,
 * publishing) belong to the product and need its database, so they cannot run here. The primary
 * sends their names, descriptions and schemas when it opens a session, and each is registered as a
 * tool whose execution is one call back to the primary, which runs the real tool for that session
 * and returns what it returned. The model cannot tell the difference, and nothing that decides
 * what a tool does is on this machine.
 */
import type { ToolSpec } from "@eta/client-contracts";
import type { KernelTool, ToolCallInfo } from "@eta/core";
import type { Peer } from "./link/peer";

/** A product tool's call may include its own work on this machine (reading files to publish). */
const TOOL_TIMEOUT_MS = 5 * 60 * 1000;

export function proxyTools(options: {
  session: string;
  specs: readonly ToolSpec[];
  peer: () => Peer | undefined;
}): KernelTool[] {
  return options.specs.map((spec) => {
    const tool: KernelTool & { parameters: unknown } = {
      name: spec.name,
      ...(spec.description === undefined
        ? {}
        : { description: spec.description }),
      parameters: spec.parameters,
      async execute(args: unknown, call: ToolCallInfo) {
        const peer = options.peer();
        if (peer === undefined || peer.lost) {
          throw new Error(
            `${spec.name} runs on the primary, and the primary is not reachable`,
          );
        }
        return await peer.call(
          "tool.call",
          {
            session: options.session,
            name: spec.name,
            toolCallId: call.toolCallId,
            args,
          },
          {
            timeoutMs: TOOL_TIMEOUT_MS,
            ...(call.signal === undefined ? {} : { signal: call.signal }),
          },
        );
      },
    };
    return tool;
  });
}
