/**
 * What a routine's sessions are told. Pure, so the words can be read, and tested, in one place.
 *
 * A run starts from nothing: it has no conversation to read back, and nobody is online to ask. The
 * first message carries everything it cannot look up: who it is, when it is, what it is for, what
 * the last run left for it, and how to end. Its tools (`routines/tools.ts`) cover the rest.
 */
import type { RoutineSchedule } from "@eta/client-contracts";
import { describeSchedule, wallClock } from "./schedule";

export function runPrompt(input: {
  name: string;
  schedule: RoutineSchedule;
  timezone: string;
  now: number;
  brief: { version: number; text: string };
  handoff: { text: string; writtenAt: number } | undefined;
}): string {
  const { handoff } = input;
  return [
    `You are running the routine "${input.name}". It runs on a schedule (${describeSchedule(input.schedule)}, time zone ${input.timezone}) with nobody online: do not ask questions, decide for yourself.`,
    `It is ${wallClock(input.now, input.timezone)} (${input.timezone}) now. The working directory is this routine's own and is kept between runs, so you can leave files there for later runs.`,
    "",
    `## What you are asked to do (version ${input.brief.version})`,
    "",
    input.brief.text,
    "",
    "## What the previous run left for you",
    "",
    handoff === undefined
      ? "This is the first run, or the earlier runs left nothing."
      : `(written ${wallClock(handoff.writtenAt, input.timezone)})\n${handoff.text}`,
    "",
    "## How to work",
    "",
    "- To learn what earlier runs did and what the user thought of them, use list_runs, get_run and search_runs.",
    "- Before you report, make sure it is not a repeat of an earlier report. If there is nothing new worth the user's time, report nothing.",
    "- End by calling finish, once. Give it `report` (Markdown, starting with a `# title` line, in the language of the brief) when there is something to send; leave `report` out when there is not. Give it `handoff` too: a few sentences for the next run about what you sent, what you noticed and what to watch for.",
    "- If you stop without calling finish, your last message is sent as the report.",
  ].join("\n");
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
