/**
 * write — whole-file writing (port of eta-agent's `tools/write.ts`).
 *
 * Faithful to eta, including what it does *not* do: the file is written
 * directly, and the write goes anywhere the environment can reach. There is no
 * sandbox — a coding agent's `cwd` is where it starts, not where it is confined
 * — and there is no temp-file dance, because the mutation queue is what keeps
 * two writes to one file from interleaving. Parent directories are created,
 * an existing file is overwritten.
 *
 * A partially aborted write is still a real write: the queue is held until the
 * write settles, so the next write to that path waits rather than racing it.
 */

import type { EnvCallOptions } from "@eta/execution";
import type { Static } from "typebox";
import type { ExecutionToolContext } from "./context";
import type { HarnessTool } from "./tool";
import { getOrThrow } from "@eta/execution";
import { Type } from "typebox";
import { withFileMutationQueue } from "./file-mutation-queue";
import { resolveToolPath } from "./path-utils";
import { text } from "./tool";

export const writeSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to write (relative or absolute)",
  }),
  content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export function createWriteTool<
  TContext extends ExecutionToolContext = ExecutionToolContext,
>(): HarnessTool<TContext, typeof writeSchema, undefined> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    async execute(args, run) {
      const env = run.context.env;
      const call: EnvCallOptions =
        run.call.signal === undefined ? {} : { signal: run.call.signal };
      const absolutePath = await resolveToolPath(env, args.path, call);
      // Read through a closure: the abort can arrive during the write, and the
      // second look must not be optimised away as "already checked".
      const aborted = (): boolean => run.call.signal?.aborted === true;
      return await withFileMutationQueue(
        env,
        absolutePath,
        async () => {
          if (aborted()) throw new Error("the write was aborted");
          getOrThrow(await env.writeFile(absolutePath, args.content, call));
          if (aborted()) throw new Error("the write was aborted");
          return text(`Successfully wrote to ${args.path}`);
        },
        call,
      );
    },
  };
}
