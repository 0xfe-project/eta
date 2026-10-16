import type { TSchema } from "typebox";
import type { SubagentManager } from "../subagent";
import type { HarnessTool, ToolResult } from "./tool";
/**
 * The subagent tools — Agent / get_subagent_result / steer_subagent (port of
 * eta-agent's `tools/subagents.ts`).
 *
 * Three verbs over the pool, and `ownerId` is the important argument: the tools
 * are built for *one* agent, so "stop", "steer" and "whose child is this" are
 * evaluated against the caller rather than trusted from what a model typed. A
 * model that names someone else's child gets the pool's refusal, not its
 * cooperation.
 *
 * `background: false` is the blocking form: the spawn returns once the child has
 * settled, which is how a model asks for an answer it needs before continuing.
 */
import { Type } from "typebox";

const agentSchema = Type.Object({
  task: Type.String(),
  model: Type.Optional(Type.String()),
  background: Type.Optional(Type.Boolean()),
  maxTurns: Type.Optional(Type.Number()),
});

const getSchema = Type.Object({ id: Type.String() });
const steerSchema = Type.Object({ id: Type.String(), note: Type.String() });

/** The pool's three tools, scoped to the agent that owns them. */
export function createSubagentTools(
  manager: SubagentManager,
  ownerId?: string,
): HarnessTool<object | undefined, TSchema, unknown>[] {
  return [
    {
      name: "Agent",
      label: "Agent",
      description:
        "Spawn a subagent on a task. background=true returns immediately; otherwise it runs to completion first.",
      parameters: agentSchema,
      async execute(args: {
        task: string;
        model?: string;
        background?: boolean;
        maxTurns?: number;
      }): Promise<ToolResult<unknown>> {
        const spec = {
          prompt: args.task,
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
        };
        const spawn =
          args.background === true ? manager.spawn : manager.spawnAndWait;
        const spawned = spawn.call(manager, spec, ownerId);
        // A foreground spawn is waited for here, which is what the tool tells a
        // model: ask for an answer you need before continuing, and get it.
        const record =
          args.background === true
            ? spawned
            : ((await manager.wait(spawned.id)) ?? spawned);
        return {
          content: [
            {
              type: "text",
              text: `${record.id} ${record.status} (in ${record.totalUsage.input}/out ${record.totalUsage.output})`,
            },
          ],
          details: { record: { id: record.id, status: record.status } },
        };
      },
    },
    {
      name: "get_subagent_result",
      label: "get_subagent_result",
      description: "Fetch a subagent's status and rolled-up usage.",
      parameters: getSchema,
      async execute(args: { id: string }): Promise<ToolResult<unknown>> {
        const record = manager.get(args.id);
        if (record === undefined) {
          return {
            content: [{ type: "text", text: `No agent ${args.id}.` }],
            details: { error: true },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `${record.id} ${record.status} (in ${record.totalUsage.input}/out ${record.totalUsage.output})`,
            },
          ],
          details: {
            id: record.id,
            status: record.status,
            usage: record.totalUsage,
          },
        };
      },
    },
    {
      name: "steer_subagent",
      label: "steer_subagent",
      description: "Queue a steering note for a running subagent.",
      parameters: steerSchema,
      async execute(args: {
        id: string;
        note: string;
      }): Promise<ToolResult<unknown>> {
        const steered = manager.steer(args.id, ownerId, args.note);
        return {
          content: [
            {
              type: "text",
              text: steered
                ? `Steered ${args.id}.`
                : `Can't steer ${args.id} (unknown, done, or not yours).`,
            },
          ],
          details: { id: args.id, note: args.note },
        };
      },
    },
  ];
}

/** The names a deployment registers the subagent tools under. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Agent",
  "get_subagent_result",
  "steer_subagent",
]);
