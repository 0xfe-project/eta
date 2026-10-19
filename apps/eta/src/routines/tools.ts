/**
 * What a routine's run can do besides what every session can: look at its own past, and end.
 *
 * Four tools, registered by `sessionTools` on the sessions of one routine and nobody else's. They
 * read the rows of the routine they were made for, so a run cannot see another routine's reports,
 * and the routine is not something the model is told or could get wrong. `finish` does not end
 * the run itself: it records how the run means to end and stops the loop, and the runner, which
 * knows how the loop really ended, writes the row.
 */
import type { KernelTool } from "@eta/core";
import type { RoutineStore, RunRecord } from "./store";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";

/** What `finish` was given. */
export interface Finish {
  report?: string | undefined;
  handoff?: string | undefined;
  title?: string | undefined;
}

export interface RoutineToolsInput {
  store: RoutineStore;
  routineId: string;
  /** Record how this run ends; an error message when it cannot (it already did, or is not a run). */
  finish: (input: Finish) => string | undefined;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const when = (at: number): string => new Date(at).toISOString();

export function routineTools(input: RoutineToolsInput): KernelTool[] {
  const { store, routineId } = input;

  /** A run as the model reads it. `full` adds what is long: the report, the handoff, the error. */
  const summary = (run: RunRecord, full: boolean): Record<string, unknown> => ({
    id: run.id,
    startedAt: when(run.startedAt),
    status: run.status,
    title: run.title,
    feedback: store.feedbackOn(run.id).map((feedback) => feedback.text),
    ...(full
      ? { report: run.report, handoff: run.handoff, error: run.error }
      : {}),
  });
  /** The routine's earlier runs; the one that is going now is the reader itself. */
  const earlier = (runs: RunRecord[]): RunRecord[] =>
    runs.filter((run) => run.status !== "running");
  const limitOf = (limit: number | undefined): number =>
    Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));

  const list = defineTool({
    name: "list_runs",
    description:
      "This routine's earlier runs, newest first: when, how each ended, the title of its report and what the user said about it.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_LIMIT,
          description: `How many runs; ${DEFAULT_LIMIT} by default`,
        }),
      ),
    }),
    execute(args) {
      const runs = earlier(
        store.runs(routineId, limitOf(args.limit) + 1),
      ).slice(0, limitOf(args.limit));
      return text(
        runs.length === 0
          ? "There are no earlier runs."
          : JSON.stringify(runs.map((run) => summary(run, false))),
      );
    },
  });

  const get = defineTool({
    name: "get_run",
    description:
      "One earlier run of this routine in full: its report, its handoff, its error and the user's feedback.",
    parameters: Type.Object({
      run: Type.String({ description: "The run's id, from list_runs" }),
    }),
    execute(args) {
      const run = store.run(args.run);
      if (run === undefined || run.routineId !== routineId)
        return toolError(`This routine has no run ${args.run}.`);
      return text(JSON.stringify(summary(run, true)));
    },
  });

  const search = defineTool({
    name: "search_runs",
    description:
      "Earlier runs of this routine whose report, handoff, title or feedback mention a text, newest first. Use it to check whether something was already sent.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "A word, name or URL" }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
    }),
    execute(args) {
      const runs = store.searchRuns(routineId, args.query, limitOf(args.limit));
      return text(
        runs.length === 0
          ? "No earlier run mentions that."
          : JSON.stringify(runs.map((run) => summary(run, false))),
      );
    },
  });

  const finish = defineTool({
    name: "finish",
    description:
      "End this run, exactly once. With a report, the user gets it; without one, this run found nothing new worth sending. `handoff` is what the next run should know.",
    parameters: Type.Object({
      report: Type.Optional(
        Type.String({
          description:
            "The report for the user, in Markdown starting with a '# title' line. Leave out when there is nothing new.",
        }),
      ),
      handoff: Type.Optional(
        Type.String({
          description:
            "A few sentences for the next run: what was sent, what you noticed, what to watch for",
        }),
      ),
      title: Type.Optional(
        Type.String({
          description:
            "A short title for the report, when its first heading would not do",
        }),
      ),
    }),
    execute(args) {
      const refused = input.finish(args);
      if (refused !== undefined) return toolError(refused);
      return { ...text("This run is finished."), terminate: true };
    },
  });

  return [
    toKernelTool(list, () => undefined),
    toKernelTool(get, () => undefined),
    toKernelTool(search, () => undefined),
    toKernelTool(finish, () => undefined),
  ] as KernelTool[];
}
