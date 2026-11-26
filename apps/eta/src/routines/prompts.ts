/**
 * What a routine's sessions are told. Pure, so the words can be read, and tested, in one place.
 *
 * A run is a new Captain session with nobody watching. The first message carries what it cannot
 * look up: which routine, when it is, the brief, and what the previous run left for it. The last
 * of these is private: it sits in its own fenced block that says so, after the brief and away from
 * the instructions about the report, so the model reads it as context and not as content.
 */
import type { RoutineSchedule } from "@eta/client-contracts";
import { describeSchedule, wallClock } from "./schedule";

/** The fence around the previous run's notes. Tests look for it, and for nothing of it in a report. */
export const PRIVATE_OPEN = "<private-notes-from-your-previous-run>";
export const PRIVATE_CLOSE = "</private-notes-from-your-previous-run>";

export function runPrompt(input: {
  name: string;
  schedule: RoutineSchedule;
  timezone: string;
  now: number;
  /** When the previous run started, if there was one. */
  previousRunAt?: number | undefined;
  brief: { version: number; text: string };
  handoff: { text: string; writtenAt: number } | undefined;
}): string {
  const { handoff } = input;
  return [
    `<routine-run>`,
    `This turn was not started by the user. You are running the routine "${input.name}", a scheduled job the user gave you (${describeSchedule(input.schedule)}, time zone ${input.timezone}). Nobody is watching this session: do not ask questions, decide for yourself.`,
    `It is ${wallClock(input.now, input.timezone)} (${input.timezone}) now.${input.previousRunAt === undefined ? " This routine has not run before." : ` The previous run started ${wallClock(input.previousRunAt, input.timezone)}.`}`,
    "",
    `## The brief (version ${input.brief.version})`,
    "",
    input.brief.text,
    "",
    "## How to do it",
    "",
    "- You have all your usual Captain tools. Do the brief however fits: look things up yourself, dispatch tracked tasks in a group with dispatch_task, coordinate in group chat with assign_in_group, post in a group with post_in_group, check tasks with captain_list_tasks. Work you dispatched may finish long after this run: a later run checks it and reports on it.",
    "- If the brief says to send something somewhere (a group, a person), do that with your tools; the report below is not sent there by itself.",
    "- Before you report, check the earlier reports (list_runs, search_runs) so you do not repeat one.",
    "",
    "## How to end: two separate things",
    "",
    "1. **For the user** — call `report(title, body)` once, or `no_news()` if nothing is worth the user's time. The report is shown to the user. It says what this run did and found, in the language of the brief. It never contains notes to yourself, plans for the next run, or anything from the private notes below.",
    "2. **For your next run only** — call `handoff(notes)`: what you did, what you dispatched and where (task numbers, conversation ids), what to check next time. The user never sees it.",
    "",
    "Then end your turn.",
    "",
    "## Your private notes from the previous run",
    "",
    "Only you can see what is between the tags below. It is context for you, not content: use it to know what to check, and never copy it, quote it or paraphrase it into a report. If it says what you planned to do, do it; report the outcome, not the plan.",
    "",
    PRIVATE_OPEN,
    handoff === undefined
      ? "(none: this is the first run, or the earlier runs left nothing)"
      : `(written ${wallClock(handoff.writtenAt, input.timezone)})\n${handoff.text}`,
    PRIVATE_CLOSE,
    `</routine-run>`,
  ].join("\n");
}

/** What a run that stopped without report or no_news is told, once. */
export function nudgePrompt(): string {
  return [
    "This routine run has not called `report` or `no_news` yet, so the user has been told nothing.",
    "Call `report(title, body)` with what this run did and found, or `no_news()` if there is nothing worth telling. Notes for the next run belong in `handoff`, never in the report. Then end your turn.",
  ].join(" ");
}

export function revisionPrompt(input: {
  brief: string;
  /** The run the feedback is about: what it sent, or why it failed. */
  run: string;
  feedback: string;
}): string {
  return [
    "You maintain the brief of a routine, an agent that runs on a schedule. The user left feedback on one of its runs. Work the feedback into the brief and answer with the complete revised brief and nothing else: keep its wording and its language, change only what the feedback needs, and do not explain. You have no use for tools here.",
    "",
    "## The brief now",
    "",
    input.brief,
    "",
    "## What that run produced",
    "",
    input.run,
    "",
    "## The user's feedback",
    "",
    input.feedback,
  ].join("\n");
}
