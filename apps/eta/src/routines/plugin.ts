/**
 * The `routines` plugin: the register of what runs on a schedule, and what to do with it.
 *
 * The list is eager (a client draws its routines from `hello`), and each routine is a target of
 * its own with its brief versions, its runs and its handoff. The clock and the runs are not here:
 * this file is the surface in front of them. Arguments are read, the rules of a routine are
 * checked, the clock is told to look again (it works out the rest from the rows), and state is
 * pushed.
 */
import type { RoutineSummary } from "@eta/client-contracts";
import type { ConversationStore } from "../conversations/store";
import type { RoutineRunner } from "./runner";
import type { Scheduler } from "./scheduler";
import type { RoutineRecord } from "./store";
import type { ViewDeps } from "./views";
import { Args, productPlugin, publish } from "../wire";
import { checkSchedule, parseSchedule } from "./schedule";
import {
  briefsOf,
  briefViewOf,
  feedbackViewOf,
  handoffOf,
  infoOf,
  listingOf,
  runsOf,
  summaryOf,
} from "./views";

export interface RoutinesDeps extends ViewDeps {
  runner: RoutineRunner;
  scheduler: Scheduler;
  conversations: ConversationStore;
  /** Say that a routine's state moved (and the list, always). */
  changed: (routineId: string) => void;
}

/** What a routine may be made of, so a brief cannot be a book and a name cannot be a paragraph. */
const MAX_NAME = 100;
const MAX_BRIEF = 8_000;
const MAX_FEEDBACK = 4_000;
const MAX_MODEL = 200;

export function routinesPlugin(deps: RoutinesDeps, applied: () => void) {
  const { store, runner, scheduler, conversations, now } = deps;

  const existing = (id: string): RoutineRecord => {
    const routine = store.get(id);
    if (routine === undefined) throw new Error(`no such routine: ${id}`);
    return routine;
  };
  const summary = (routine: RoutineRecord): RoutineSummary =>
    summaryOf(deps, routine);

  return productPlugin(
    "routines",
    (ctx) => {
      const { wire } = ctx;
      const details = new Map<string, () => void>();
      /** `routines.<id>`: registered for every routine there is and for each one made later. */
      const publishDetail = (id: string): void => {
        if (details.has(id)) return;
        const routine = (): RoutineRecord => existing(id);
        details.set(
          id,
          publish(wire, `routines.${id}`, {
            info: () => infoOf(deps, routine()),
            briefs: () => briefsOf(deps, id),
            runs: () => runsOf(deps, id),
            handoff: () => handoffOf(deps, id),
          }),
        );
      };
      for (const routine of store.list()) publishDetail(routine.id);

      runner.attach(ctx.sessions);
      scheduler.start();

      const offs = [
        publish(
          wire,
          "routines",
          { list: () => store.list().map(summary) },
          { eager: true },
        ),

        wire.handle("routines", "create", (call) => {
          const args = new Args(call);
          const name = nameOf(args.string("name"));
          const brief = briefOf(args.string("brief"));
          const schedule = parseSchedule(
            (call.args as Record<string, unknown>).schedule,
          );
          const timezone = args.string("timezone").trim();
          checkSchedule(schedule, timezone, now());
          const routine = store.create({
            name,
            brief,
            schedule,
            timezone,
            model: modelOf(args.nullableString("model")) ?? null,
            conversationId:
              conversationOf(
                conversations,
                args.nullableString("conversationId"),
              ) ?? null,
            enabled: args.optionalBoolean("enabled") ?? true,
          });
          publishDetail(routine.id);
          scheduler.tick();
          deps.changed(routine.id);
          return { result: { routine: summary(routine) } };
        }),

        wire.handle("routines", "update", (call) => {
          const args = new Args(call);
          const before = existing(args.string("routineId"));
          const raw = call.args as Record<string, unknown>;
          const name = args.optionalString("name");
          const brief = args.optionalString("brief");
          const timezone = args.optionalString("timezone")?.trim();
          const schedule =
            raw.schedule === undefined
              ? undefined
              : parseSchedule(raw.schedule);
          if (schedule !== undefined || timezone !== undefined)
            checkSchedule(
              schedule ?? before.schedule,
              timezone ?? before.timezone,
              now(),
            );
          const model = modelOf(args.nullableString("model"));
          const conversationId = conversationOf(
            conversations,
            args.nullableString("conversationId"),
          );
          const routine = store.update(before.id, {
            ...(name === undefined ? {} : { name: nameOf(name) }),
            ...(schedule === undefined ? {} : { schedule }),
            ...(timezone === undefined ? {} : { timezone }),
            ...(model === undefined ? {} : { model }),
            ...(conversationId === undefined ? {} : { conversationId }),
            ...(args.optionalBoolean("enabled") === undefined
              ? {}
              : { enabled: args.optionalBoolean("enabled")! }),
          })!;
          if (brief !== undefined) store.editBrief(before.id, briefOf(brief));
          scheduler.tick();
          deps.changed(routine.id);
          return { result: { routine: summary(existing(routine.id)) } };
        }),

        wire.handle("routines", "delete", (call) => {
          const routine = existing(new Args(call).string("routineId"));
          if (store.runningRun(routine.id) !== undefined)
            throw new Error(
              `${routine.name} is running; delete it when the run has ended`,
            );
          store.remove(routine.id);
          details.get(routine.id)?.();
          details.delete(routine.id);
          scheduler.tick();
          deps.changed(routine.id);
          return { result: { routineId: routine.id } };
        }),

        wire.handle("routines", "run", (call) => {
          const routine = existing(new Args(call).string("routineId"));
          const run = runner.start(routine.id, "user");
          if (run === undefined)
            throw new Error(
              store.runningRun(routine.id) === undefined
                ? `${routine.name} cannot be run right now`
                : `${routine.name} is already running`,
            );
          return {
            result: {
              routine: summary(existing(routine.id)),
              run: listingOf(run),
            },
          };
        }),

        wire.handle("routines", "seen", (call) => {
          const routine = existing(new Args(call).string("routineId"));
          store.markSeen(routine.id);
          deps.changed(routine.id);
          return { result: { routine: summary(routine) } };
        }),

        wire.handle("routines", "feedback", (call) => {
          const args = new Args(call);
          const routine = existing(args.string("routineId"));
          const run = store.run(args.string("runId"));
          if (run === undefined || run.routineId !== routine.id)
            throw new Error("no such run");
          if (run.status === "running")
            throw new Error("the run has not finished yet");
          const text = args.string("text").trim();
          if (text.length > MAX_FEEDBACK)
            throw new Error(
              `feedback is longer than ${MAX_FEEDBACK} characters`,
            );
          const feedback = store.addFeedback(run.id, text);
          // The revision is a model call: it happens after this returns, and the page sees the
          // routine as revising until it ends.
          runner.reviseSoon(routine.id);
          deps.changed(routine.id);
          return { result: { feedback: feedbackViewOf(feedback) } };
        }),

        wire.handle("routines", "restoreBrief", (call) => {
          const args = new Args(call);
          const routine = existing(args.string("routineId"));
          const brief = store.restoreBrief(routine.id, args.integer("version"));
          if (brief === undefined) throw new Error("no such brief version");
          deps.changed(routine.id);
          return {
            result: { brief: briefViewOf(deps, brief) },
          };
        }),
      ];
      return () => {
        scheduler.stop();
        for (const off of offs.splice(0)) off();
        for (const off of details.values()) off();
        details.clear();
        // The plugin is going: what is running is told to stop, and the dispose waits for it.
        return runner.detach();
      };
    },
    applied,
  );
}

function nameOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new Error("a routine needs a name");
  if (trimmed.length > MAX_NAME)
    throw new Error(`a name is at most ${MAX_NAME} characters`);
  return trimmed;
}

function briefOf(brief: string): string {
  const trimmed = brief.trim();
  if (trimmed === "") throw new Error("a routine needs a brief");
  if (trimmed.length > MAX_BRIEF)
    throw new Error(`a brief is at most ${MAX_BRIEF} characters`);
  return trimmed;
}

/** `provider:modelId`; an empty string clears it like null does; undefined leaves it alone. */
function modelOf(model: string | null | undefined): string | null | undefined {
  if (model === undefined || model === null) return model;
  const trimmed = model.trim();
  if (trimmed === "") return null;
  if (!trimmed.includes(":") || trimmed.length > MAX_MODEL)
    throw new Error("model must be provider:modelId");
  return trimmed;
}

/** The conversation a report goes to: it has to exist; an empty string unlinks like null does. */
function conversationOf(
  conversations: ConversationStore,
  id: string | null | undefined,
): string | null | undefined {
  if (id === undefined || id === null) return id;
  if (id === "") return null;
  if (conversations.get(id) === undefined)
    throw new Error(`no such conversation: ${id}`);
  return id;
}
