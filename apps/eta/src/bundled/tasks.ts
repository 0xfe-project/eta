/**
 * The task board (REFACTOR.md §9, P3.1 — the local half).
 *
 *   GET    /api/v1/tasks                        the board, and who work can go to
 *   POST   /api/v1/tasks                        a task, created by the user
 *   GET    /api/v1/tasks/{task_id}              one task with its timeline
 *   PATCH  /api/v1/tasks/{task_id}              what changed
 *   DELETE /api/v1/tasks/{task_id}              remove it
 *   POST   /api/v1/tasks/{task_id}/comments     say something on it
 *   POST   /api/v1/groups/{group_id}/drafts/{message_id}/confirm
 *
 * The last one is where the board and a conversation meet: a draft an agent proposed in a group
 * becomes a task, and the message it was becomes the card. Everything that changes a task
 * refreshes its cards in the same request, so a card is never a stale copy of the board.
 *
 * Not here: assists, review loops, runs and remote computers — those are remote dispatch (P4),
 * and the routes that need them answer 501 rather than pretending.
 */
import type { Context } from "cordis";
import type { AgentStore } from "../agents/store";
import type { GroupStore } from "../groups/store";
import type { PluginContext } from "../plugin-api";
import type { TaskCards } from "../tasks/cards";
import type { AxpTaskList } from "../tasks/shapes";
import type { TaskStatus, TaskStore } from "../tasks/store";
import { errorResponse } from "../routes";
import { toTask, toTaskDetail } from "../tasks/shapes";
import { isAssigneeKind, isTaskStatus } from "../tasks/store";

export interface TasksPluginConfig {
  tasks: TaskStore;
  cards: TaskCards;
  groups: GroupStore;
  agents: AgentStore;
}

const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  try {
    const body = (await request.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

export const tasksPlugin = {
  name: "tasks",
  inject: ["routes"],
  apply(ctx: Context, config: TasksPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { tasks, cards, groups, agents } = config;

    /** How the shapes name an agent: an id is not a name a reader recognises. */
    const options = {
      agentName: (agentId: string): string | undefined =>
        agents.get(agentId)?.name,
    };
    const detailOf = (id: string) => {
      const detail = tasks.detail(id);
      if (detail === undefined) return undefined;
      return toTaskDetail(detail, {
        ...options,
        comments: tasks.comments(detail.id),
      });
    };

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/v1/tasks", (request) => {
        const groupId = new URL(request.url).searchParams.get("group_id") ?? "";
        const list: AxpTaskList = {
          tasks: tasks
            .list(groupId.length === 0 ? {} : { groupId })
            .map((task) =>
              toTask(task, { ...options, comments: tasks.comments(task.id) }),
            ),
          // Who work can be assigned to besides the user: the paired remote runtimes.
          // None exist before P4, and an empty list says that.
          assignees: [],
        };
        return Response.json(list);
      }),
    );

    plugin.effect(() =>
      plugin.routes.register("POST", "/api/v1/tasks", async (request) => {
        const body = await readJson(request);
        const title = asString(body.title)?.trim() ?? "";
        if (title.length === 0) {
          return errorResponse(
            422,
            "VALIDATION_ERROR",
            "任务需要标题。",
            crypto.randomUUID(),
          );
        }
        const status = asString(body.status);
        if (status !== undefined && !isTaskStatus(status)) {
          return errorResponse(
            422,
            "VALIDATION_ERROR",
            "任务状态无效。",
            crypto.randomUUID(),
          );
        }
        const assignee = assigneeOf(body.assignee);
        if (assignee === "invalid") {
          return errorResponse(
            422,
            "VALIDATION_ERROR",
            "指派给远程电脑属于远程闭环(P4);这里只支持 none 或 user。",
            crypto.randomUUID(),
          );
        }
        const groupId = asString(body.group_id);
        if (
          groupId !== undefined &&
          groupId.length > 0 &&
          groups.get(groupId) === undefined
        ) {
          return errorResponse(
            422,
            "VALIDATION_ERROR",
            "没有这个群。",
            crypto.randomUUID(),
          );
        }
        const task = tasks.create({
          title,
          ...(asString(body.description) === undefined
            ? {}
            : { description: asString(body.description)! }),
          ...(status === undefined ? {} : { status: status as TaskStatus }),
          ...(assignee === undefined ? {} : { assignee }),
          ...(groupId === undefined || groupId.length === 0 ? {} : { groupId }),
        });
        // A task created straight onto the board has no draft, so nothing to sync — unless
        // it was linked to a group that already shows it.
        for (const card of cards.sync(task.id)) void card;
        const detail = detailOf(task.id)!;
        return Response.json(detail, { status: 201 });
      }),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/api/v1/tasks/:task_id",
        (_request, params) => {
          const task = tasks.find(params.task_id ?? "");
          if (task === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_TASK",
              "没有这个任务。",
              crypto.randomUUID(),
            );
          }
          return Response.json(detailOf(task.id));
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PATCH",
        "/api/v1/tasks/:task_id",
        async (request, params) => {
          const task = tasks.find(params.task_id ?? "");
          if (task === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_TASK",
              "没有这个任务。",
              crypto.randomUUID(),
            );
          }
          const body = await readJson(request);
          const status = asString(body.status);
          if (status !== undefined && !isTaskStatus(status)) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "任务状态无效。",
              crypto.randomUUID(),
            );
          }
          const assignee = assigneeOf(body.assignee);
          if (assignee === "invalid") {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "指派给远程电脑属于远程闭环(P4)。",
              crypto.randomUUID(),
            );
          }
          // `group_id: ""` unlinks; a string links. Absent leaves it alone.
          const rawGroup = body.group_id;
          let groupId: string | null | undefined;
          if (typeof rawGroup === "string") {
            if (rawGroup.length === 0) groupId = null;
            else if (groups.get(rawGroup) === undefined) {
              return errorResponse(
                422,
                "VALIDATION_ERROR",
                "没有这个群。",
                crypto.randomUUID(),
              );
            } else groupId = rawGroup;
          }
          const updated = tasks.update(
            task.id,
            {
              ...(asString(body.title) === undefined
                ? {}
                : { title: asString(body.title)! }),
              ...(asString(body.description) === undefined
                ? {}
                : { description: asString(body.description)! }),
              ...(status === undefined ? {} : { status: status as TaskStatus }),
              ...(assignee === undefined ? {} : { assignee }),
              ...(groupId === undefined ? {} : { groupId }),
            },
            { kind: "user" },
          );
          if (updated === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_TASK",
              "没有这个任务。",
              crypto.randomUUID(),
            );
          }
          cards.sync(updated.id);
          return Response.json(detailOf(updated.id));
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "DELETE",
        "/api/v1/tasks/:task_id",
        (_request, params) => {
          const task = tasks.find(params.task_id ?? "");
          if (task === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_TASK",
              "没有这个任务。",
              crypto.randomUUID(),
            );
          }
          // The cards are told before the rows go: what a reader still has is the card, and it
          // should say the task is gone rather than point at nothing.
          cards.sync(task.id);
          tasks.remove(task.id);
          cards.sync(task.id);
          return new Response(null, { status: 204 });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/tasks/:task_id/comments",
        async (request, params) => {
          const task = tasks.find(params.task_id ?? "");
          if (task === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_TASK",
              "没有这个任务。",
              crypto.randomUUID(),
            );
          }
          const body = await readJson(request);
          const text = asString(body.body) ?? asString(body.comment) ?? "";
          if (text.trim().length === 0) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "评论不能为空。",
              crypto.randomUUID(),
            );
          }
          tasks.comment(task.id, text, { kind: "user" });
          cards.sync(task.id);
          return Response.json(detailOf(task.id), { status: 201 });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/v1/groups/:group_id/drafts/:message_id/confirm",
        async (request, params) => {
          const groupId = params.group_id ?? "";
          const messageId = params.message_id ?? "";
          const body = await readJson(request);
          const title = asString(body.title)?.trim() ?? "";
          if (title.length === 0) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "任务需要标题。",
              crypto.randomUUID(),
            );
          }
          const confirmed = cards.confirm({
            groupId,
            messageId,
            confirm: {
              title,
              ...(asString(body.description) === undefined
                ? {}
                : { description: asString(body.description)! }),
              ...(asString(body.status) === undefined
                ? {}
                : { status: asString(body.status)! }),
              ...((body.assignee as { kind?: unknown } | undefined)?.kind ===
              "user"
                ? { assignee: "user" }
                : {}),
            },
          });
          if (confirmed === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_DRAFT",
              "没有这个草稿。",
              crypto.randomUUID(),
            );
          }
          return Response.json(detailOf(confirmed.id), { status: 201 });
        },
      ),
    );
  },
};

/**
 * The assignee a request asked for.
 *
 * `undefined` means "not mentioned"; `"invalid"` means "a remote computer, which this build cannot
 * do yet" — the difference matters, because one leaves the field alone and the other is refused.
 */
function assigneeOf(value: unknown): "none" | "user" | undefined | "invalid" {
  if (value === undefined || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string") return undefined;
  if (kind === "remote") return "invalid";
  return isAssigneeKind(kind) ? kind : "invalid";
}
