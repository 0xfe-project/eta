import type {
  TaskActor,
  TaskArchivedFilter,
  TaskWorkspaceMode,
} from "@eta/client-contracts";
/**
 * The `tasks` plugin: the board on the wire.
 *
 * `tasks` is eager, the whole board as one list; every task is a target of its own (`tasks.<id>`)
 * with its detail and its activity, made when the task is and taken away when it is deleted. What
 * the actions do is the board's (`board.ts`); this file reads the arguments and publishes. Every
 * action here is the user's: an agent changes the board with its tools. An agent's task is drafted
 * and confirmed by the user (`confirmDraft`); the user's own, from the page's form, is made by
 * `create`, whose call is the user pressing "Create" (`TaskBoard.make`).
 */
import type { CallFrame } from "@eta/client-wire-proto";
import type { SettingStore } from "../inbox/setting";
import type {
  DependencyInput,
  FieldsInput,
  NewTaskInput,
  TaskBoard,
} from "./board";
import type { TaskRunner } from "./runner";
import type { WorkspaceChoice } from "./tools";
import { TASK_ARCHIVED_FILTERS } from "@eta/client-contracts";
import { Args, productPlugin, publish } from "../wire";
import { boardSettings, saveBoardSettings } from "./archiver";

export interface TasksDeps {
  board: TaskBoard;
  runner: TaskRunner;
  /** The workspace a task made in a conversation gets, when its parent does not say. */
  workspaceFor?: WorkspaceChoice;
  /** Where the board's settings (how soon quiet tasks are archived) are kept. */
  settings: Pick<SettingStore, "get" | "set">;
  /** The settings changed: a shorter wait may have made tasks due now. */
  settingsChanged?: () => void;
}

/** `archived` as a call sends it: absent is the board without the archived tasks. */
function archivedFilterOf(
  value: unknown,
  call: string,
): TaskArchivedFilter | undefined {
  if (value === undefined) return undefined;
  if (!(TASK_ARCHIVED_FILTERS as readonly unknown[]).includes(value))
    throw new TypeError(
      `${call}: archived is ${TASK_ARCHIVED_FILTERS.join(" or ")}`,
    );
  return value as TaskArchivedFilter;
}

const USER: TaskActor = { kind: "user", agentId: null };

/** The fields a call may carry, as strings: the board says which are valid. */
function fieldsOf(args: Args): FieldsInput {
  return {
    title: args.optionalString("title"),
    description: args.optionalString("description"),
    status: args.optionalString("status"),
  };
}

/** `confirmDraft`'s `edits`: an object of the same fields, or nothing. */
function editsOf(call: CallFrame): FieldsInput {
  const raw = (call.args as Record<string, unknown> | undefined)?.edits;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new TypeError("tasks.confirmDraft: edits must be an object");
  return fieldsOf(new Args({ ...call, args: raw }));
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A list of batch indexes; absent is none. */
function indexesOf(value: unknown, what: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((n) => typeof n === "number" && Number.isInteger(n))
  )
    throw new TypeError(`tasks.create: ${what} must be a list of integers`);
  return value as number[];
}

/** `create`'s `tasks`: what each one is, as the board reads it (`NewTaskInput`). */
function newTasksOf(call: CallFrame): NewTaskInput[] {
  const raw = (call.args as Record<string, unknown> | undefined)?.tasks;
  if (!Array.isArray(raw) || raw.length === 0)
    throw new TypeError("tasks.create: tasks must be a list of at least one");
  return raw.map((entry, i) => {
    if (!isObject(entry))
      throw new TypeError(`tasks.create: tasks[${i}] must be an object`);
    const args = new Args({ ...call, args: entry });
    const dependsOn = entry.dependsOn ?? [];
    if (!Array.isArray(dependsOn))
      throw new TypeError(`tasks.create: tasks[${i}].dependsOn must be a list`);
    return {
      title: args.string("title"),
      description: args.optionalString("description"),
      assignee: args.string("assignee"),
      dependsOn: dependsOn.map((edge, j): DependencyInput => {
        if (!isObject(edge) || typeof edge.task !== "string")
          throw new TypeError(
            `tasks.create: tasks[${i}].dependsOn[${j}] needs a task`,
          );
        return { task: edge.task, requireDone: edge.requireDone === true };
      }),
      after: indexesOf(entry.after, `tasks[${i}].after`),
      under: args.optionalInteger("under"),
    };
  });
}

export function tasksPlugin(deps: TasksDeps, applied: () => void) {
  const { board, runner, workspaceFor, settings } = deps;

  return productPlugin(
    "tasks",
    (ctx) => {
      const { wire } = ctx;
      const targets = new Map<string, () => void>();
      const add = (id: string): void => {
        if (targets.has(id)) return;
        targets.set(
          id,
          publish(wire, `tasks.${id}`, {
            task: () => board.detail(id)!,
            activity: () => board.activity(id),
          }),
        );
      };
      // Every task has its page, archived or not.
      for (const task of board.list({ archived: "include" })) add(task.id);

      const offs = [
        publish(
          wire,
          "tasks",
          {
            list: () => board.list(),
            archived: () => board.list({ archived: "only" }),
            settings: () => boardSettings(settings),
          },
          { eager: true },
        ),

        wire.handle("tasks", "list", (call) => {
          const archived = archivedFilterOf(
            (call.args as Record<string, unknown> | undefined)?.archived,
            "tasks.list",
          );
          return { result: { tasks: board.list({ archived }) } };
        }),

        wire.handle("tasks", "archive", (call) => {
          const args = new Args(call);
          const task = board.archive(args.string("taskId"), USER, {
            stopRuns: args.optionalBoolean("stopRuns"),
          });
          return { result: { task } };
        }),

        wire.handle("tasks", "unarchive", (call) => {
          const args = new Args(call);
          const one = args.optionalString("taskId");
          const ids = [
            ...(one === undefined ? [] : [one]),
            ...args.strings("taskIds"),
          ];
          if (ids.length === 0)
            throw new Error("tasks.unarchive needs taskId or taskIds");
          return { result: { tasks: board.unarchive(ids, USER) } };
        }),

        wire.handle("tasks", "setSettings", (call) => {
          const raw = (call.args ?? {}) as Record<string, unknown>;
          const saved = saveBoardSettings(settings, {
            archiveAfterDays: raw.archiveAfterDays,
          });
          wire.pushNow("tasks");
          deps.settingsChanged?.();
          return { result: { settings: saved } };
        }),

        board.onChange(({ taskId, kind }) => {
          if (kind === "created") add(taskId);
          if (kind === "removed") {
            targets.get(taskId)?.();
            targets.delete(taskId);
          }
          wire.pushNow("tasks");
          if (kind !== "removed") wire.pushNow(`tasks.${taskId}`);
        }),

        wire.handle("tasks", "update", (call) => {
          const args = new Args(call);
          const task = board.update(
            args.string("taskId"),
            fieldsOf(args),
            USER,
          );
          return { result: { task } };
        }),

        wire.handle("tasks", "comment", (call) => {
          const args = new Args(call);
          return {
            result: board.comment(
              args.string("taskId"),
              args.string("body"),
              USER,
              {
                clientId: args.optionalString("clientId"),
                mentions: args.strings("mentions"),
              },
            ),
          };
        }),

        wire.handle("tasks", "delete", (call) => {
          const taskId = new Args(call).string("taskId");
          board.remove(taskId);
          return { result: { taskId } };
        }),

        wire.handle("tasks", "link", (call) => {
          const args = new Args(call);
          const conversationId = args.nullableString("conversationId");
          if (conversationId === undefined)
            throw new Error("tasks.link needs conversationId (or null)");
          const task = board.link(args.string("taskId"), conversationId, USER);
          return { result: { task } };
        }),

        wire.handle("tasks", "interrupt", (call) => {
          const args = new Args(call);
          return {
            result: {
              task: runner.interrupt(
                args.string("taskId"),
                args.string("runId"),
              ),
            },
          };
        }),

        wire.handle("tasks", "rerun", (call) => {
          const { task, run } = runner.rerun(new Args(call).string("taskId"));
          const { taskId: _, ...view } = run;
          return { result: { task, run: view } };
        }),

        wire.handle("tasks", "addDependency", (call) => {
          const args = new Args(call);
          const task = board.addDependency(
            args.string("taskId"),
            args.string("dependsOn"),
            { requireDone: args.optionalBoolean("requireDone") },
            USER,
          );
          return { result: { task } };
        }),

        wire.handle("tasks", "removeDependency", (call) => {
          const args = new Args(call);
          const task = board.removeDependency(
            args.string("taskId"),
            args.string("dependsOn"),
            USER,
          );
          return { result: { task } };
        }),

        wire.handle("tasks", "setParent", (call) => {
          const args = new Args(call);
          const parent = args.nullableString("parent");
          if (parent === undefined)
            throw new Error("tasks.setParent needs parent (or null)");
          const task = board.setParent(args.string("taskId"), parent, USER);
          return { result: { task } };
        }),

        wire.handle("tasks", "create", async (call) => {
          const args = new Args(call);
          const tasks = newTasksOf(call);
          const parent = args.optionalString("parent");
          const conversationId = args.optionalString("conversationId");
          const workspace = args.optionalString("workspace") as
            | TaskWorkspaceMode
            | undefined;
          if (
            workspace !== undefined &&
            workspace !== "local" &&
            workspace !== "worktree"
          )
            throw new TypeError("tasks.create: workspace is local or worktree");
          // With no parent to take it from, the conversation's project says (a repository or not).
          const chosen =
            workspace ??
            (parent === undefined && conversationId !== undefined
              ? await workspaceFor?.(conversationId, undefined)
              : undefined);
          const made = board.make(
            {
              tasks,
              parent,
              conversationId,
              status: args.optionalString("status"),
              workspace: chosen,
            },
            USER,
          );
          return { result: { tasks: made } };
        }),

        wire.handle("tasks", "confirmDraft", (call) => {
          const args = new Args(call);
          return {
            result: board.confirmDraft({
              conversationId: args.string("conversationId"),
              messageId: args.string("messageId"),
              edits: editsOf(call),
            }),
          };
        }),
      ];

      return () => {
        for (const off of offs.splice(0)) off();
        for (const off of targets.values()) off();
        targets.clear();
      };
    },
    applied,
  );
}
