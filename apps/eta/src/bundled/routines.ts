/**
 * Routines: the API a page reads (REFACTOR.md §9, P3.3).
 *
 *   GET    /api/routines/v1/routines                            the list, with its recent runs
 *   POST   /api/routines/v1/routines                            a new routine
 *   GET    /api/routines/v1/routines/{routine_id}               one, with briefs, runs and handoff
 *   PATCH  /api/routines/v1/routines/{routine_id}               change it
 *   DELETE /api/routines/v1/routines/{routine_id}               remove it
 *   POST   /api/routines/v1/routines/{routine_id}/run           run it now
 *   POST   /api/routines/v1/routines/{routine_id}/seen          the user looked at it
 *   POST   /api/routines/v1/routines/{routine_id}/runs/{run_id}/feedback   revise the brief
 *   POST   /api/routines/v1/routines/{routine_id}/briefs/{version}/restore an old brief
 *
 * The page's shapes are AXP's, and the scheduler behind them is this process's own clock (P3.3) —
 * the two are kept in step by deriving "next run" from the same cron the clock fires on, so a page
 * can never count down to a time the scheduler does not know about.
 */
import type { Context } from "cordis";
import type { PluginContext } from "../plugin-api";
import type { RoutineRunner } from "../routines/runner";
import type { Scheduler } from "../routines/scheduler";
import type { RoutineStore } from "../routines/store";
import { errorResponse } from "../routes";
import { InvalidSchedule, isValidTimeZone } from "../routines/schedule";
import { toRoutine, toRoutineSummary } from "../routines/shapes";

export interface RoutinesPluginConfig {
  routines: RoutineStore;
  runner: RoutineRunner;
  scheduler: Scheduler;
  /** The model a new routine uses when the request does not name one. */
  defaultModel: () => string | undefined;
  /** Routines whose feedback is being revised right now. */
  revising?: (() => readonly string[]) | undefined;
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

export const routinesPlugin = {
  name: "routines",
  inject: ["routes"],
  apply(ctx: Context, config: RoutinesPluginConfig): void {
    const plugin = ctx as unknown as PluginContext;
    const { routines, runner, scheduler, defaultModel } = config;
    const revising = config.revising ?? (() => []);

    /** A brief version's number, found by the feedback that produced it (the brief points back). */
    const briefVersionOf = (feedbackId: string): number | undefined => {
      for (const routine of routines.list()) {
        for (const brief of routines.briefs(routine.id)) {
          if (brief.feedbackId === feedbackId) return brief.version;
        }
      }
      return undefined;
    };

    /** Everything the shapes need to read one routine's history. */
    const inputOf = (routineId: string, runs: number) => ({
      feedbackText: (feedbackId: string): string | undefined =>
        routines
          .runs(routineId, 200)
          .flatMap((run) => routines.feedbacks(run.id))
          .find((feedback) => feedback.id === feedbackId)?.text,
      nextRunAt: (routine: Parameters<typeof routines.nextRunAt>[0]) =>
        routines.nextRunAt(routine),
      revising: () => revising().includes(routineId),
      feedbackOf: (runId: string) => routines.feedbacks(runId),
      briefVersionOf,
      runs: routines.runs(routineId, runs),
    });

    const summaryOf = (routine: Parameters<typeof toRoutineSummary>[0]) =>
      toRoutineSummary(routine, {
        ...inputOf(routine.id, 5),
        unseen: routines.unseen(routine.id),
      });

    const detailOf = (routine: Parameters<typeof toRoutine>[0]) =>
      toRoutine(routine, {
        ...inputOf(routine.id, 50),
        briefs: routines.briefs(routine.id),
        handoff: routines.handoff(routine.id),
      });

    const rejection = (error: unknown): Response | undefined => {
      if (error instanceof InvalidSchedule) {
        return errorResponse(
          422,
          "VALIDATION_ERROR",
          error.message,
          crypto.randomUUID(),
        );
      }
      return undefined;
    };

    plugin.effect(() =>
      plugin.routes.register("GET", "/api/routines/v1/routines", () =>
        Response.json({ routines: routines.list().map(summaryOf) }),
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "GET",
        "/api/routines/v1/routines/:routine_id",
        (_request, params) => {
          const routine = routines.get(params.routine_id ?? "");
          return routine === undefined
            ? errorResponse(
                404,
                "NO_SUCH_ROUTINE",
                "没有这个定时任务。",
                crypto.randomUUID(),
              )
            : Response.json(detailOf(routine));
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/routines/v1/routines",
        async (request) => {
          const body = await readJson(request);
          const name = asString(body.name)?.trim() ?? "";
          const brief = asString(body.brief)?.trim() ?? "";
          if (name.length === 0 || brief.length === 0) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "定时任务需要名字和要求。",
              crypto.randomUUID(),
            );
          }
          const model = asString(body.model)?.trim() ?? defaultModel();
          if (model === undefined || model.length === 0) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "定时任务需要模型（配置里也没有默认模型）。",
              crypto.randomUUID(),
            );
          }
          const timezone = asString(body.timezone)?.trim() ?? "";
          if (!isValidTimeZone(timezone)) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              `无效的时区：${timezone}`,
              crypto.randomUUID(),
            );
          }
          try {
            const routine = routines.create({
              name,
              model,
              brief,
              schedule: body.schedule,
              timezone,
            });
            // On the clock as soon as it exists: a routine that only ran after the next boot
            // would be a routine that missed its first time.
            scheduler.schedule(routine);
            return Response.json(detailOf(routine), { status: 201 });
          } catch (error) {
            const rejected = rejection(error);
            if (rejected !== undefined) return rejected;
            throw error;
          }
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "PATCH",
        "/api/routines/v1/routines/:routine_id",
        async (request, params) => {
          const routine = routines.get(params.routine_id ?? "");
          if (routine === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_ROUTINE",
              "没有这个定时任务。",
              crypto.randomUUID(),
            );
          }
          const body = await readJson(request);
          const timezone = asString(body.timezone);
          if (timezone !== undefined && !isValidTimeZone(timezone)) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              `无效的时区：${timezone}`,
              crypto.randomUUID(),
            );
          }
          try {
            const updated = routines.update(routine.id, {
              ...(asString(body.name) === undefined
                ? {}
                : { name: asString(body.name)! }),
              ...(asString(body.brief) === undefined
                ? {}
                : { brief: asString(body.brief)! }),
              ...(asString(body.model) === undefined
                ? {}
                : { model: asString(body.model)! }),
              ...(timezone === undefined ? {} : { timezone }),
              ...(typeof body.enabled === "boolean"
                ? { enabled: body.enabled }
                : {}),
              ...(body.schedule === undefined
                ? {}
                : { schedule: body.schedule }),
            });
            if (updated === undefined) {
              return errorResponse(
                404,
                "NO_SUCH_ROUTINE",
                "没有这个定时任务。",
                crypto.randomUUID(),
              );
            }
            // The clock follows the row: a paused routine leaves it, a changed time replaces it.
            scheduler.schedule(updated);
            return Response.json(detailOf(updated));
          } catch (error) {
            const rejected = rejection(error);
            if (rejected !== undefined) return rejected;
            throw error;
          }
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "DELETE",
        "/api/routines/v1/routines/:routine_id",
        (_request, params) => {
          const id = params.routine_id ?? "";
          if (!routines.remove(id)) {
            return errorResponse(
              404,
              "NO_SUCH_ROUTINE",
              "没有这个定时任务。",
              crypto.randomUUID(),
            );
          }
          // A removed routine comes off the clock; `sync` is what makes that true even if the
          // caller's view of the clock was stale.
          scheduler.sync();
          return new Response(null, { status: 204 });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/routines/v1/routines/:routine_id/run",
        (_request, params) => {
          const id = params.routine_id ?? "";
          const routine = routines.get(id);
          if (routine === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_ROUTINE",
              "没有这个定时任务。",
              crypto.randomUUID(),
            );
          }
          // "Run now" runs a paused routine too: that is the point of pressing it.
          const runId = runner.start(id, { manual: true });
          if (runId === undefined) {
            return errorResponse(
              409,
              "ALREADY_RUNNING",
              "这个定时任务正在运行。",
              crypto.randomUUID(),
            );
          }
          return Response.json(detailOf(routines.get(id) ?? routine), {
            status: 202,
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/routines/v1/routines/:routine_id/seen",
        (_request, params) => {
          const id = params.routine_id ?? "";
          if (routines.get(id) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_ROUTINE",
              "没有这个定时任务。",
              crypto.randomUUID(),
            );
          }
          routines.markSeen(id);
          return Response.json(detailOf(routines.get(id)!));
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/routines/v1/routines/:routine_id/runs/:run_id/feedback",
        async (request, params) => {
          const runId = params.run_id ?? "";
          const body = await readJson(request);
          const text = asString(body.text)?.trim() ?? "";
          if (text.length === 0) {
            return errorResponse(
              422,
              "VALIDATION_ERROR",
              "反馈不能为空。",
              crypto.randomUUID(),
            );
          }
          const run = routines.run(runId);
          if (
            run === undefined ||
            run.routineId !== (params.routine_id ?? "")
          ) {
            return errorResponse(
              404,
              "NO_SUCH_RUN",
              "没有这次运行。",
              crypto.randomUUID(),
            );
          }
          if (routines.feedback(runId, text) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_RUN",
              "没有这次运行。",
              crypto.randomUUID(),
            );
          }
          // The revision happens in the background: it is a model call, and the page should not
          // wait on it to show the feedback it just wrote.
          void runner.revise(run.routineId);
          const routine = routines.get(run.routineId);
          return Response.json(routine === undefined ? {} : detailOf(routine), {
            status: 201,
          });
        },
      ),
    );

    plugin.effect(() =>
      plugin.routes.register(
        "POST",
        "/api/routines/v1/routines/:routine_id/briefs/:version/restore",
        (_request, params) => {
          const id = params.routine_id ?? "";
          if (routines.get(id) === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_ROUTINE",
              "没有这个定时任务。",
              crypto.randomUUID(),
            );
          }
          const version = Number(params.version ?? "");
          const restored = routines.restore(id, version);
          if (restored === undefined) {
            return errorResponse(
              404,
              "NO_SUCH_BRIEF",
              "没有这个版本。",
              crypto.randomUUID(),
            );
          }
          return Response.json(detailOf(routines.get(id)!));
        },
      ),
    );
  },
};
