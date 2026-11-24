import type {
  BoardTaskView,
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
import type { AttachmentStore } from "../conversations/attachments";
import type { SettingStore } from "../settings/store";
import type {
  DependencyInput,
  FieldsInput,
  NewTaskInput,
  TaskBoard,
} from "./board";
import type { TaskRunner } from "./runner";
import type { TaskSteps } from "./steps";
import type { WorkspaceChoice } from "./tools";
import type { TaskUsageStore } from "./usage";
import { TASK_ARCHIVED_FILTERS } from "@eta/client-contracts";
import { Args, productPlugin, publish } from "../wire";
import { boardSettings, saveBoardSettings } from "./archiver";

export interface TasksDeps {
  board: TaskBoard;
  runner: TaskRunner;
  /** What the tasks' runs used, in tokens (`tasks.usage`, and each task's `usage` section). */
  usage?: Pick<
    TaskUsageStore,
    "ofTask" | "onChange" | "ancestorsOf" | "briefs"
  >;
  /** The plan of each task's executor (each task's `steps` section). */
  steps?: Pick<TaskSteps, "ofRuns" | "onChange">;
  /** The workspace a task made in a conversation gets, when its parent does not say. */
  workspaceFor?: WorkspaceChoice;
  /** Where the board's settings (how soon quiet tasks are archived) are kept. */
  settings: Pick<SettingStore, "get" | "set">;
  /** The settings changed: a shorter wait may have made tasks due now. */
  settingsChanged?: () => void;
  /** Files attached to comments (`attach`, `unattach`, `attachment`). */
  attachments?: AttachmentStore;
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

/** A task's `base`: a string, the empty one being HEAD; absent is derived. */
function baseOf(value: unknown, i: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string")
    throw new TypeError(`tasks.create: tasks[${i}].base must be a string`);
  return value;
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
      base: baseOf(entry.base, i),
    };
  });
}

export function tasksPlugin(deps: TasksDeps, applied: () => void) {
  const { board, runner, workspaceFor, settings, usage, steps } = deps;
  const attachmentsOf = (): AttachmentStore => {
    if (deps.attachments === undefined)
      throw new Error("this host takes no files with a comment");
    return deps.attachments;
  };
  /** The task's id, once it is known to exist: a file is only ever a real task's. */
  const taskOf = (taskId: string): string => {
    const task = board.find(taskId);
    if (task === undefined) throw new Error(`no such task: ${taskId}`);
    return task.id;
  };
  // The board's tasks with their usage in brief, read in one pass for the whole list.
  const listed = (tasks: BoardTaskView[]): BoardTaskView[] => {
    if (usage === undefined) return tasks;
    const { own, withSubtasks } = usage.briefs();
    return tasks.map((task) => ({
      ...task,
      usage: own.get(task.id) ?? null,
      ...(withSubtasks.has(task.id)
        ? { usageWithSubtasks: withSubtasks.get(task.id)! }
        : {}),
    }));
  };

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
            ...(usage === undefined
              ? {}
              : { usage: () => usage.ofTask(id, true) }),
            ...(steps === undefined
              ? {}
              : { steps: () => steps.ofRuns(board.detail(id)!.runs) }),
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
            list: () => listed(board.list()),
            archived: () => listed(board.list({ archived: "only" })),
            settings: () => boardSettings(settings),
          },
          { eager: true },
        ),

        // A run's tokens were counted: its task's page moved, and so did every task above it,
        // whose section adds its subtasks in. Paced: a busy run is counted on every request.
        usage?.onChange((taskId) => {
          wire.push("tasks");
          for (const id of [taskId, ...usage.ancestorsOf(taskId)])
            if (targets.has(id)) wire.push(`tasks.${id}`);
        }) ?? (() => undefined),

        // A step of the executor's plan moved: its task's page, paced like the usage.
        steps?.onChange((taskId) => {
          if (targets.has(taskId)) wire.push(`tasks.${taskId}`);
        }) ?? (() => undefined),

        wire.handle("tasks", "usage", (call) => {
          if (usage === undefined)
            throw new Error("tasks.usage: this host does not count usage");
          const args = new Args(call);
          const taskId = args.string("taskId");
          if (board.detail(taskId) === undefined)
            throw new Error(`tasks.usage: no task ${taskId}`);
          return {
            result: {
              usage: usage.ofTask(
                taskId,
                args.optionalBoolean("includeSubtasks") ?? false,
              ),
            },
          };
        }),

        wire.handle("tasks", "list", (call) => {
          const archived = archivedFilterOf(
            (call.args as Record<string, unknown> | undefined)?.archived,
            "tasks.list",
          );
          return { result: { tasks: listed(board.list({ archived })) } };
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
            reactToResults: raw.reactToResults,
            autoAnswerAsks: raw.autoAnswerAsks,
            draftTimeout: raw.draftTimeout,
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
              args.optionalString("body") ?? "",
              USER,
              {
                clientId: args.optionalString("clientId"),
                mentions: args.strings("mentions"),
                attachments: args.strings("attachments"),
              },
            ),
          };
        }),

        // A comment's files, as a message's: uploaded first, claimed by the comment that carries them.
        wire.handle("tasks", "attach", async (call) => {
          const args = new Args(call);
          const taskId = args.string("taskId");
          const attachment = await attachmentsOf().receive({
            owner: { taskId: taskOf(taskId) },
            uploadId: args.string("uploadId"),
            name: args.string("name"),
            contentType:
              args.optionalString("contentType") || "application/octet-stream",
            index: args.integer("index"),
            last: args.optionalBoolean("last") ?? false,
            data: args.optionalString("data") ?? "",
          });
          return { result: { attachment } };
        }),

        wire.handle("tasks", "unattach", async (call) => {
          const args = new Args(call);
          return {
            result: {
              removed: await attachmentsOf().remove(
                { taskId: taskOf(args.string("taskId")) },
                args.string("attachmentId"),
              ),
            },
          };
        }),

        wire.handle("tasks", "attachment", async (call) => {
          const args = new Args(call);
          return {
            result: await attachmentsOf().picture(
              { taskId: taskOf(args.string("taskId")) },
              args.string("attachmentId"),
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

        wire.handle("tasks", "workspaceFor", async (call) => {
          const args = new Args(call);
          const parent = args.optionalString("parent");
          if (parent !== undefined && parent.trim() !== "")
            return { result: { mode: board.workspaceOf(parent) } };
          const conversationId = args.optionalString("conversationId");
          if (conversationId === undefined)
            throw new TypeError(
              "tasks.workspaceFor needs a parent or a conversationId",
            );
          const mode =
            (await workspaceFor?.(conversationId, undefined)) ?? "local";
          return { result: { mode } };
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

        wire.handle("tasks", "discardDraft", (call) => {
          const args = new Args(call);
          return {
            result: board.discardDraft({
              conversationId: args.string("conversationId"),
              messageId: args.string("messageId"),
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
