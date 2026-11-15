/**
 * What Captain has in a routine's run besides its own tools: its routine's past, and the two ways
 * it leaves something behind.
 *
 * **What the user reads and what the next run reads are two tools, not two fields of one.** A
 * model that fills `report` and `handoff` in one call writes them side by side and lets one leak
 * into the other ("next time I will…" in the report). So:
 *
 * - `report(title, body)` or `no_news()`: what this run tells the user. Exactly one, once.
 * - `handoff(notes)`: what this run tells the next run of the same routine. Nobody else reads it:
 *   it is stored in `routine_run.handoff` and the next run's prompt is the only place it appears.
 *   No view, notification or tool returns it, `get_run` and `search_runs` included.
 *
 * Neither ends the run: the run ends when Captain stops, and the runner, which knows how it really
 * ended, writes the row (`runner.ts`). The tools are made for one routine, read its rows only, and
 * the routine is never something the model is told or could get wrong.
 */
import type { KernelTool } from "@eta/core";
import type { RoutineStore, RunRecord } from "./store";
import { defineTool, text, toKernelTool, toolError } from "@eta/harness";
import { Type } from "typebox";

/** What the run told the user, once it did. */
export type Said =
  | { kind: "report"; title: string; body: string }
  | { kind: "no_news" };

interface RunRecorder {
  /** Record what this run tells the user; an error message when it already did. */
  say: (said: Said) => string | undefined;
  /** Record the note for the next run; a second call replaces the first. */
  handoff: (notes: string) => string | undefined;
}

export interface RoutineToolsInput {
  store: RoutineStore;
  routineId: string;
  run: RunRecorder;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MAX_TITLE = 200;
const MAX_BODY = 20_000;
const MAX_NOTES = 8_000;

const when = (at: number): string => new Date(at).toISOString();

export function routineTools(input: RoutineToolsInput): KernelTool[] {
  const { store, routineId } = input;

  /** A run as the model reads it: what the user saw of it. Never the handoff. */
  const summary = (run: RunRecord, full: boolean): Record<string, unknown> => ({
    id: run.id,
    startedAt: when(run.startedAt),
    status: run.status,
    title: run.title,
    feedback: store.feedbackOn(run.id).map((feedback) => feedback.text),
    ...(full ? { report: run.report, error: run.error } : {}),
  });
  /** The routine's earlier runs; the one that is going now is the reader itself. */
  const earlier = (runs: RunRecord[]): RunRecord[] =>
    runs.filter((run) => run.status !== "running");
  const limitOf = (limit: number | undefined): number =>
    Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT));

  const report = defineTool({
    name: "report",
    description: [
      "Send this run's report to the user. Call it once, or call no_news instead — never both.",
      "The report is shown to the user on the routines page and announced in your chat with them. Write it for the user: what this run did and what it found, in the language of the brief.",
      "It is not where notes to yourself go. Plans for the next run, reminders, 'next time I will…', state to carry over: those go to handoff, which the user never sees. Do not repeat or summarise the handoff here.",
    ].join(" "),
    parameters: Type.Object({
      title: Type.String({
        minLength: 1,
        maxLength: MAX_TITLE,
        description: "A short headline for the user",
      }),
      body: Type.String({
        minLength: 1,
        maxLength: MAX_BODY,
        description:
          "The report itself, in Markdown, for the user: what was done and found this time",
      }),
    }),
    execute(args) {
      const title = args.title.trim();
      const body = args.body.trim();
      if (title === "" || body === "")
        return toolError("A report needs a title and a body.");
      const refused = input.run.say({ kind: "report", title, body });
      if (refused !== undefined) return toolError(refused);
      return text(
        "The report is recorded and will reach the user. If you have notes for the next run, call handoff; then end your turn.",
      );
    },
  });

  const noNews = defineTool({
    name: "no_news",
    description:
      "Say that this run found nothing new worth the user's time, instead of calling report. The user sees only that there was no news. Notes for the next run still go to handoff.",
    parameters: Type.Object({}),
    execute() {
      const refused = input.run.say({ kind: "no_news" });
      if (refused !== undefined) return toolError(refused);
      return text(
        "Recorded: no news this time. If you have notes for the next run, call handoff; then end your turn.",
      );
    },
  });

  const handoff = defineTool({
    name: "handoff",
    description: [
      "Leave private notes for the next run of this routine: what you did, what you sent, what you dispatched and where (task numbers, conversation ids), what to check or follow up next time.",
      "Only the next run reads them. The user never sees them, and they are never shown in a report.",
      "Calling it again replaces the earlier notes of this run.",
    ].join(" "),
    parameters: Type.Object({
      notes: Type.String({
        minLength: 1,
        maxLength: MAX_NOTES,
        description: "Notes for your next run, and for nobody else",
      }),
    }),
    execute(args) {
      const notes = args.notes.trim();
      if (notes === "") return toolError("The notes are empty.");
      const refused = input.run.handoff(notes);
      if (refused !== undefined) return toolError(refused);
      return text("Saved for the next run.");
    },
  });

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
      "One earlier run of this routine: the report the user got, its error, and the user's feedback.",
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
      "Earlier runs of this routine whose report, title or feedback mention a text, newest first. Use it to check whether something was already reported.",
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

  return [report, noNews, handoff, list, get, search].map((tool) =>
    toKernelTool(tool as never, () => undefined),
  ) as KernelTool[];
}
