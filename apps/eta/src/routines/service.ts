/**
 * Making and changing routines: one set of rules for every way in.
 *
 * The routines page (`plugin.ts`), a `create_routine` card the user confirms
 * (`captain/propose-routine.ts`) and Captain's own `update_routine` all come through here, so a name,
 * a brief, a schedule / trigger and a zone are checked the same way whoever sends them, the clock
 * and trigger hub are told to look again, and the wire learns of the change.
 */
import type {
  RoutineSchedule,
  RoutineTrigger,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { Scheduler } from "./scheduler";
import type { RoutineRecord, RoutineStore } from "./store";
import type { TriggerHub } from "./triggers";
import { Buffer } from "node:buffer";
import { checkSchedule, checkTimezone, parseSchedule } from "./schedule";

/** What a routine may be made of, so a brief cannot be a book and a name cannot be a paragraph. */
const MAX_NAME = 100;
const MAX_BRIEF = 8_000;
const PROVIDER_ID = /^[a-z0-9_-]{1,64}$/;
const SOURCE_SLUG = /^[\w-]{1,100}$/;
const TRIGGER_SLUG = /^[\w.-]{1,200}$/;
const ACCOUNT_ID = /^[\w.-]{1,200}$/;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_POLL_MINUTES = 7 * 24 * 60;

export interface RoutineFieldsInput {
  name: string;
  brief: string;
  /** Untrusted: read by `parseSchedule`, or null/undefined for trigger-only routines. */
  schedule?: unknown;
  /** Untrusted: read by `parseTrigger`, or null/undefined for schedule-only routines. */
  trigger?: unknown;
  timezone: string;
}

export interface CheckedFields {
  name: string;
  brief: string;
  schedule: RoutineSchedule | null;
  trigger: RoutineTrigger | null;
  timezone: string;
}

export interface RoutineServiceDeps {
  store: RoutineStore;
  scheduler: Scheduler;
  triggers?: TriggerHub | undefined;
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
    const schedule =
      input.schedule === undefined || input.schedule === null
        ? null
        : parseSchedule(input.schedule);
    const trigger =
      input.trigger === undefined || input.trigger === null
        ? null
        : parseTrigger(input.trigger, this.#deps.triggers);
    if (schedule === null && trigger === null)
      throw new Error("a routine needs a schedule or a trigger");
    const timezone = input.timezone.trim();
    if (schedule !== null) checkSchedule(schedule, timezone, this.#deps.now());
    else checkTimezone(timezone);
    return {
      name: nameOf(input.name),
      brief: briefOf(input.brief),
      schedule,
      trigger,
      timezone,
    };
  }

  async create(
    input: RoutineFieldsInput & { enabled?: boolean },
  ): Promise<RoutineRecord> {
    const fields = this.check(input);
    const routine = this.#deps.store.create({
      ...fields,
      enabled: input.enabled ?? true,
    });
    this.created?.(routine.id);
    if (fields.trigger !== null)
      await this.#deps.triggers?.onCreated(routine.id);
    this.#deps.scheduler.tick();
    this.#deps.changed(routine.id);
    return this.existing(routine.id);
  }

  /** Change what is given; a brief that differs from the one in force is written as its next version. */
  async update(
    id: string,
    patch: Partial<RoutineFieldsInput> & { enabled?: boolean },
  ): Promise<RoutineRecord> {
    const before = this.existing(id);
    const previousTrigger = this.#deps.store.trigger(before.id);
    const schedule =
      patch.schedule === undefined
        ? undefined
        : patch.schedule === null
          ? null
          : parseSchedule(patch.schedule);
    const trigger =
      patch.trigger === undefined
        ? undefined
        : patch.trigger === null
          ? null
          : parseTrigger(patch.trigger, this.#deps.triggers);

    const nextSchedule = schedule === undefined ? before.schedule : schedule;
    const hasTriggerAfter =
      trigger === undefined ? previousTrigger !== undefined : trigger !== null;
    if (nextSchedule === null && !hasTriggerAfter)
      throw new Error("a routine needs a schedule or a trigger");

    const timezone = patch.timezone?.trim();
    if (
      nextSchedule !== null &&
      (schedule !== undefined || timezone !== undefined)
    ) {
      checkSchedule(
        nextSchedule,
        timezone ?? before.timezone,
        this.#deps.now(),
      );
    } else if (timezone !== undefined) {
      checkTimezone(timezone);
    }

    const brief = patch.brief === undefined ? undefined : briefOf(patch.brief);
    const enabledAfter = patch.enabled ?? before.enabled;
    this.#deps.store.update(before.id, {
      ...(patch.name === undefined ? {} : { name: nameOf(patch.name) }),
      ...(schedule === undefined ? {} : { schedule }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(timezone === undefined ? {} : { timezone }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    });
    if (brief !== undefined) this.#deps.store.editBrief(before.id, brief);
    await this.#deps.triggers?.onUpdated({
      routineId: before.id,
      previousTrigger,
      triggerPatch: trigger,
      enabledBefore: before.enabled,
      enabledAfter,
    });
    this.#deps.scheduler.tick();
    this.#deps.changed(before.id);
    return this.existing(before.id);
  }

  async remove(id: string): Promise<void> {
    const routine = this.existing(id);
    if (this.#deps.store.runningRun(routine.id) !== undefined)
      throw new Error(
        `${routine.name} is running; delete it when the run has ended`,
      );
    const previousTrigger = this.#deps.store.trigger(routine.id);
    this.#deps.store.remove(routine.id);
    this.removed?.(routine.id);
    this.#deps.scheduler.tick();
    this.#deps.changed(routine.id);
    if (previousTrigger !== undefined)
      await this.#deps.triggers?.onRemoved(previousTrigger);
  }

  async triggers(filter?: {
    provider?: string | undefined;
    source?: string | undefined;
    query?: string | undefined;
    refresh?: boolean | undefined;
  }): Promise<{
    triggers: TriggerCatalogItem[];
    providers: TriggerProviderStatus[];
  }> {
    if (this.#deps.triggers === undefined)
      return { triggers: [], providers: [] };
    return await this.#deps.triggers.listTriggers(filter);
  }
}

function parseTrigger(value: unknown, hub?: TriggerHub): RoutineTrigger {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("trigger must be an object");
  const raw = value as Record<string, unknown>;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  if (!PROVIDER_ID.test(provider))
    throw new TypeError("trigger.provider must be a valid provider id");
  if (hub !== undefined && !hub.hasProvider(provider))
    throw new Error(`unknown trigger provider: ${provider}`);

  const source = typeof raw.source === "string" ? raw.source.trim() : "";
  if (!SOURCE_SLUG.test(source))
    throw new TypeError("trigger.source must be a valid toolkit/source slug");

  const trigger = typeof raw.trigger === "string" ? raw.trigger.trim() : "";
  if (!TRIGGER_SLUG.test(trigger))
    throw new TypeError("trigger.trigger must be a valid trigger slug");

  let accountId: string | null | undefined;
  if (raw.accountId === null || raw.accountId === undefined) {
    accountId = raw.accountId ?? null;
  } else if (
    typeof raw.accountId === "string" &&
    ACCOUNT_ID.test(raw.accountId.trim())
  ) {
    accountId = raw.accountId.trim();
  } else {
    throw new TypeError("trigger.accountId must be a valid id or null");
  }

  let config: Record<string, unknown> = {};
  if (raw.config !== undefined) {
    if (
      typeof raw.config !== "object" ||
      raw.config === null ||
      Array.isArray(raw.config)
    )
      throw new TypeError("trigger.config must be an object");
    const json = JSON.stringify(raw.config);
    if (Buffer.byteLength(json, "utf8") > MAX_CONFIG_BYTES)
      throw new TypeError("trigger.config is too large");
    config = raw.config as Record<string, unknown>;
  }

  let mode: RoutineTrigger["mode"] = null;
  if (raw.mode !== undefined && raw.mode !== null) {
    if (raw.mode !== "webhook" && raw.mode !== "poll")
      throw new TypeError("trigger.mode must be webhook, poll or null");
    mode = raw.mode;
  }

  let pollingIntervalMinutes: number | null = null;
  if (
    raw.pollingIntervalMinutes !== undefined &&
    raw.pollingIntervalMinutes !== null
  ) {
    if (
      typeof raw.pollingIntervalMinutes !== "number" ||
      !Number.isInteger(raw.pollingIntervalMinutes) ||
      raw.pollingIntervalMinutes < 1 ||
      raw.pollingIntervalMinutes > MAX_POLL_MINUTES
    )
      throw new TypeError(
        `trigger.pollingIntervalMinutes must be an integer between 1 and ${MAX_POLL_MINUTES}`,
      );
    pollingIntervalMinutes = raw.pollingIntervalMinutes;
  }

  return {
    provider,
    source,
    trigger,
    accountId,
    config,
    mode,
    pollingIntervalMinutes,
  };
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
