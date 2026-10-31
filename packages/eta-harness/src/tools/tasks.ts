/**
 * The step tools — create_step / list_steps / get_step / update_step (port of
 * eta-agent's `tools/tasks.ts`).
 *
 * They are a thin surface over the kernel's task primitive: the ledger itself
 * (ids never reused, dependency edges kept even when they form a cycle, a
 * normalization guard on restore) lives in core, and persistence is the
 * journaling service's business. What this file adds is the words a model reads
 * and the details a UI shows.
 *
 * The names say "step", the kernel says `Task`: a step is one line of the plan
 * this session keeps for itself, and the board's tasks are another thing that
 * happens to share the word. The ledger's own type names are left alone because
 * they are also what the journal writes to disk (`task:*` entries); renaming
 * them would break replaying a session recorded before the change, for no gain
 * the model can see.
 *
 * Every mutation is a real mutation of the session's ledger, so a step list
 * survives a restart because it was written down — not because it was echoed
 * back from a snapshot.
 */
import type { StoredTask, Task, TaskService, TaskStatus } from "@eta/core";
import type { TSchema } from "typebox";
import type { HarnessTool, ToolResult } from "./tool";
import { Type } from "typebox";
import { STEP_UPDATE_SUCCESS } from "../prompts/tasks";

export type { TaskStatus };

/** The names the step tools are registered under. */
export const STEP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "create_step",
  "list_steps",
  "get_step",
  "update_step",
]);

const prioritySchema = Type.Optional(
  Type.Union([
    Type.Literal("high"),
    Type.Literal("medium"),
    Type.Literal("low"),
  ]),
);

const createSchema = Type.Object({
  content: Type.String({ description: "What the step is, one line" }),
  deps: Type.Optional(
    Type.Array(Type.String(), { description: "Step ids this waits on" }),
  ),
  priority: prioritySchema,
});

const listSchema = Type.Object({});
const getSchema = Type.Object({ id: Type.String() });

const updateSchema = Type.Object({
  id: Type.String(),
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("cancelled"),
    ]),
  ),
  content: Type.Optional(Type.String()),
  deps: Type.Optional(Type.Array(Type.String())),
  priority: prioritySchema,
});

/** The four step tools over a session's ledger. */
export function createStepTools(
  tasks: TaskService,
): HarnessTool<object | undefined, TSchema, unknown>[] {
  return [
    {
      name: "create_step",
      label: "create_step",
      description: "Add a step to your plan. deps are ids this step waits on.",
      parameters: createSchema,
      execute(args: {
        content: string;
        deps?: string[];
        priority?: Task["priority"];
      }): ToolResult<unknown> {
        const { task, warnings } = tasks.create(args.content, {
          ...(args.deps === undefined ? {} : { deps: args.deps }),
          ...(args.priority === undefined ? {} : { priority: args.priority }),
        });
        return {
          content: [
            {
              type: "text",
              text: `Created ${task.id}. ${STEP_UPDATE_SUCCESS}${warnings.length > 0 ? `\nwarnings: ${warnings.join("; ")}` : ""}`,
            },
          ],
          details: { task, warnings },
        };
      },
    },
    {
      name: "list_steps",
      label: "list_steps",
      description: "Show the current step list.",
      parameters: listSchema,
      execute(): ToolResult<unknown> {
        const rendered = renderSteps(tasks.list());
        return {
          content: [{ type: "text", text: rendered }],
          details: { tasks: tasks.list() },
        };
      },
    },
    {
      name: "get_step",
      label: "get_step",
      description: "Show one step with its dependency edges.",
      parameters: getSchema,
      execute(args: { id: string }): ToolResult<unknown> {
        const task = tasks.get(args.id);
        if (task === undefined)
          return {
            content: [{ type: "text", text: `No step ${args.id}.` }],
            details: { task: undefined },
          };
        return {
          content: [{ type: "text", text: JSON.stringify(task) }],
          details: { task },
        };
      },
    },
    {
      name: "update_step",
      label: "update_step",
      description:
        "Change a step: status (pending|in_progress|completed|cancelled), content, deps, priority.",
      parameters: updateSchema,
      execute(args: {
        id: string;
        status?: TaskStatus;
        content?: string;
        deps?: string[];
        priority?: Task["priority"];
      }): ToolResult<unknown> {
        const { id, ...patch } = args;
        const result = tasks.update(id, patch);
        if (result === undefined) {
          return {
            content: [{ type: "text", text: `No step ${id}.` }],
            details: { task: undefined },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Updated ${id}. ${STEP_UPDATE_SUCCESS}${result.warnings.length > 0 ? `\nwarnings: ${result.warnings.join("; ")}` : ""}`,
            },
          ],
          details: { task: result.task, warnings: result.warnings },
        };
      },
    },
  ];
}

/** The list a model reads: one line per step, marked by status. */
function renderSteps(list: StoredTask[]): string {
  const marks: Record<TaskStatus, string> = {
    pending: "[ ]",
    in_progress: "[~]",
    completed: "[x]",
    cancelled: "[-]",
  };
  const body = list
    .map((task) => `${marks[task.status]} ${task.id}: ${task.content}`)
    .join("\n");
  return `<current_steps>\n${body}\n</current_steps>`;
}
