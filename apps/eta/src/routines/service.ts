/**
 * Making and changing routines: one set of rules for every way in.
 *
 * The routines page (`plugin.ts`), a `create_routine` card the user confirms
 * (`captain/propose-routine.ts`) and Captain's own `update_routine` all come through here, so a name,
 * a brief, a schedule and a zone are checked the same way whoever sends them, the clock is told to
 * look again, and the wire learns of the change. A routine is a name, a brief, a schedule in a zone,
 * and whether it is on: what it does with its reports, and with what rights, is written in the brief
 * for Captain to carry out.
 */
import type { RoutineSchedule } from "@eta/client-contracts";
import type { Scheduler } from "./scheduler";
import type { RoutineRecord, RoutineStore } from "./store";
import { checkSchedule, parseSchedule } from "./schedule";

/** What a routine may be made of, so a brief cannot be a book and a name cannot be a paragraph. */
const MAX_NAME = 100;
const MAX_BRIEF = 8_000;

export interface RoutineFieldsInput {
  name: string;
  brief: string;
  /** Untrusted: read by `parseSchedule`. */
  schedule: unknown;
  timezone: string;
}

export interface CheckedFields {
  name: string;
  brief: string;
  schedule: RoutineSchedule;
  timezone: string;
}

export interface RoutineServiceDeps {
  store: RoutineStore;
  scheduler: Scheduler;
  now: () => number;
  /** Say that a routine's state moved (and the list, always). */
  changed: (routineId: string) => void;
}

export class RoutineService {
  readonly #deps: RoutineServiceDeps;
  /** A routine exists now, or is gone: its wire target is published or taken down. Set by the plugin. */
  created: ((routineId: string) => void) | undefined;
  removed: ((routineId: string) => void) | undefined;

  constructor(deps: RoutineServiceDeps) {
    this.#deps = deps;
  }

  get store(): RoutineStore {
    return this.#deps.store;
  }

  existing(id: string): RoutineRecord {
    const routine = this.#deps.store.get(id);
    if (routine === undefined) throw new Error(`no such routine: ${id}`);
    return routine;
  }

  /** The fields of a new routine, checked; throws saying what is wrong. */
  check(input: RoutineFieldsInput): CheckedFields {
    const schedule = parseSchedule(input.schedule);
    const timezone = input.timezone.trim();
    checkSchedule(schedule, timezone, this.#deps.now());
    return {
      name: nameOf(input.name),
      brief: briefOf(input.brief),
      schedule,
      timezone,
    };
  }

  create(input: RoutineFieldsInput & { enabled?: boolean }): RoutineRecord {
    const fields = this.check(input);
    const routine = this.#deps.store.create({
      ...fields,
      enabled: input.enabled ?? true,
    });
    this.created?.(routine.id);
    this.#deps.scheduler.tick();
    this.#deps.changed(routine.id);
    return routine;
  }

  /** Change what is given; a brief that differs from the one in force is written as its next version. */
  update(
    id: string,
    patch: Partial<RoutineFieldsInput> & { enabled?: boolean },
  ): RoutineRecord {
    const before = this.existing(id);
    const schedule =
      patch.schedule === undefined ? undefined : parseSchedule(patch.schedule);
    const timezone = patch.timezone?.trim();
    if (schedule !== undefined || timezone !== undefined)
      checkSchedule(
        schedule ?? before.schedule,
        timezone ?? before.timezone,
        this.#deps.now(),
      );
    const brief = patch.brief === undefined ? undefined : briefOf(patch.brief);
    this.#deps.store.update(before.id, {
      ...(patch.name === undefined ? {} : { name: nameOf(patch.name) }),
      ...(schedule === undefined ? {} : { schedule }),
      ...(timezone === undefined ? {} : { timezone }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    });
    if (brief !== undefined) this.#deps.store.editBrief(before.id, brief);
    this.#deps.scheduler.tick();
    this.#deps.changed(before.id);
    return this.existing(before.id);
  }

  remove(id: string): void {
    const routine = this.existing(id);
    if (this.#deps.store.runningRun(routine.id) !== undefined)
      throw new Error(
        `${routine.name} is running; delete it when the run has ended`,
      );
    this.#deps.store.remove(routine.id);
    this.removed?.(routine.id);
    this.#deps.scheduler.tick();
    this.#deps.changed(routine.id);
  }
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
