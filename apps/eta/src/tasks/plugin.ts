import type { TaskActor } from "@eta/client-contracts";
import type { CallFrame } from "@eta/client-wire-proto";
/**
 * The `tasks` plugin: the board on the wire.
 *
 * `tasks` is eager, the whole board as one list; every task is a target of its own (`tasks.<id>`)
 * with its detail and its activity, made when the task is and taken away when it is deleted. What
 * the actions do is the board's (`board.ts`); this file reads the arguments and publishes. Every
 * action here is the user's: an agent changes the board with its tools.
 */
import type { FieldsInput, TaskBoard } from "./board";
import { Args, productPlugin, publish } from "../wire";

export interface TasksDeps {
  board: TaskBoard;
}

const USER: TaskActor = { kind: "user", agentId: null };

/** The fields a call may carry, as strings: the board says which are valid. */
function fieldsOf(args: Args): FieldsInput {
  return {
    title: args.optionalString("title"),
    description: args.optionalString("description"),
    status: args.optionalString("status"),
    assignee: args.optionalString("assignee"),
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

export function tasksPlugin(deps: TasksDeps, applied: () => void) {
  const { board } = deps;

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
      for (const task of board.list()) add(task.id);

      const offs = [
        publish(wire, "tasks", { list: () => board.list() }, { eager: true }),

        board.onChange(({ taskId, kind }) => {
          if (kind === "created") add(taskId);
          if (kind === "removed") {
            targets.get(taskId)?.();
            targets.delete(taskId);
          }
          wire.pushNow("tasks");
          if (kind !== "removed") wire.pushNow(`tasks.${taskId}`);
        }),

        wire.handle("tasks", "create", (call) => {
          const args = new Args(call);
          const task = board.create(
            {
              ...fieldsOf(args),
              title: args.string("title"),
              conversationId: args.optionalString("conversationId"),
            },
            USER,
          );
          return { result: { task } };
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
