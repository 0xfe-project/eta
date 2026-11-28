/**
 * Built-in In-Process Internal Events `TriggerProvider` (`provider = "eta-events"`).
 *
 * - Purely in-process event bus (`EtaEventBus`): zero network calls, zero polling timers.
 * - Extensible event catalog (`ETA_EVENT_SPECS`):
 *   - `task.status.changed`: emitted after a task's status change is committed to SQLite
 *   - `task.run.finished`: emitted after a task run finishes (`completed` / `failed` / `interrupted`)
 * - Validates trigger slug, source, mode, and optional filter conditions (`to`, `from`, `status`,
 *   `group`, `creator`, `assignee`) inside `provision()` so invalid configs surface `status: "error"` + `lastError`.
 * - Wraps subscriber delivery in `try/catch` + `warn` so event dispatch never disrupts task flows.
 */
import type {
  BoardTaskStatus,
  RoutineTrigger,
  TaskActor,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { AgentStore } from "../agents/store";
import type { ConversationStore } from "../conversations/store";
import type {
  TriggerProvider,
  TriggerProviderHost,
  TriggerProvisionResult,
} from "./triggers";
import { TASK_STATUSES } from "@eta/client-contracts";
import { CAPTAIN_KIND } from "../captain/policy";

const ETA_EVENTS_PROVIDER_ID = "eta-events";
const TASKS_SOURCE_SLUG = "tasks";
const TASKS_SOURCE_NAME = "eta Tasks";

export const TASK_STATUS_CHANGED_TRIGGER = "task.status.changed";
export const TASK_RUN_FINISHED_TRIGGER = "task.run.finished";

const RUN_FINISHED_STATUSES = ["completed", "failed", "interrupted"] as const;
type TaskFinishedRunStatus = (typeof RUN_FINISHED_STATUSES)[number];

const MAX_ASSIGNEE_CHARS = 200;

/** Where a task came from and who made it; all null when the task is gone. */
interface TaskOriginPayload {
  groupId: string | null;
  groupName: string | null;
  groupKind: "group" | "captain" | null;
  creator: string | null;
  creatorName: string | null;
}

interface TaskStatusChangedPayload extends TaskOriginPayload {
  taskId: string;
  number: number;
  title: string;
  from: BoardTaskStatus;
  to: BoardTaskStatus;
  assignee: string | null;
  assigneeName: string | null;
  actor: TaskActor;
  reason: string | null;
  occurredAt: number;
}

interface TaskRunFinishedPayload extends TaskOriginPayload {
  taskId: string;
  number: number;
  title: string;
  runId: string;
  status: TaskFinishedRunStatus;
  reason: string | null;
  errorCode: string | null;
  agentId: string | null;
  assignee: string | null;
  assigneeName: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  occurredAt: number;
}

export type EtaInternalEvent =
  | {
      type: typeof TASK_STATUS_CHANGED_TRIGGER;
      eventId: string;
      occurredAt: number;
      payload: TaskStatusChangedPayload;
    }
  | {
      type: typeof TASK_RUN_FINISHED_TRIGGER;
      eventId: string;
      occurredAt: number;
      payload: TaskRunFinishedPayload;
    };

export class EtaEventBus {
  readonly #listeners = new Set<(event: EtaInternalEvent) => void>();
  readonly #warn: (message: string) => void;

  constructor(options?: { warn?: ((message: string) => void) | undefined }) {
    this.#warn = options?.warn ?? ((message) => console.warn(message));
  }

  subscribe(listener: (event: EtaInternalEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(event: EtaInternalEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#warn(
          `[eta] internal event listener failed for ${event.type}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

interface ParsedEventFilter {
  to?: readonly BoardTaskStatus[];
  from?: readonly BoardTaskStatus[];
  status?: readonly TaskFinishedRunStatus[];
  group?: string | null;
  creator?: string | null;
  assignee?: string | null;
}

interface EtaEventSpec {
  readonly catalogItem: Omit<TriggerCatalogItem, "configSchema">;
  /** The fixed config fields; the group, creator and assignee dropdowns are added per listing. */
  readonly configProperties: Record<string, unknown>;
  parseConfig: (rawConfig: Record<string, unknown>) => {
    filter: ParsedEventFilter;
    persistedConfig: Record<string, unknown>;
  };
  matches: (filter: ParsedEventFilter, event: EtaInternalEvent) => boolean;
}

const ORIGIN_PAYLOAD_PROPERTIES = {
  groupId: { type: ["string", "null"] },
  groupName: { type: ["string", "null"] },
  groupKind: { type: ["string", "null"], enum: ["group", "captain", null] },
  creator: { type: ["string", "null"] },
  creatorName: { type: ["string", "null"] },
};

const ETA_EVENT_SPECS: readonly EtaEventSpec[] = [
  {
    catalogItem: {
      provider: ETA_EVENTS_PROVIDER_ID,
      source: TASKS_SOURCE_SLUG,
      sourceName: TASKS_SOURCE_NAME,
      trigger: TASK_STATUS_CHANGED_TRIGGER,
      name: "Task status changed",
      description:
        "Triggers when a task changes status (for example moving into in_review, done, or blocked).",
      modes: [],
      payloadSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          number: { type: "integer" },
          title: { type: "string" },
          from: { type: "string", enum: [...TASK_STATUSES] },
          to: { type: "string", enum: [...TASK_STATUSES] },
          assignee: { type: ["string", "null"] },
          assigneeName: { type: ["string", "null"] },
          actor: { type: "object" },
          reason: { type: ["string", "null"] },
          ...ORIGIN_PAYLOAD_PROPERTIES,
          occurredAt: { type: "integer" },
        },
      },
      accounts: [],
    },
    configProperties: {
      to: {
        type: "array",
        title: "Target statuses",
        description:
          "Optional target statuses to match (leave empty to match any status change).",
        items: {
          type: "string",
          enum: [...TASK_STATUSES],
        },
        examples: ["in_review, done, blocked"],
      },
      from: {
        type: "array",
        title: "Previous statuses",
        description:
          "Optional previous statuses to match (leave empty to match any).",
        items: {
          type: "string",
          enum: [...TASK_STATUSES],
        },
        examples: ["in_progress"],
      },
    },
    parseConfig(rawConfig) {
      checkAllowedKeys(
        rawConfig,
        ["to", "from", "group", "creator", "assignee"],
        TASK_STATUS_CHANGED_TRIGGER,
      );
      const to = parseEnumFilter(rawConfig.to, "to", TASK_STATUSES);
      const from = parseEnumFilter(rawConfig.from, "from", TASK_STATUSES);
      const group = parseStringFilter(rawConfig.group, "group");
      const creator = parseStringFilter(rawConfig.creator, "creator");
      const assignee = parseStringFilter(rawConfig.assignee, "assignee");
      const persistedConfig: Record<string, unknown> = {};
      if (to !== undefined && to.length > 0) persistedConfig.to = to;
      if (from !== undefined && from.length > 0) persistedConfig.from = from;
      if (group !== null) persistedConfig.group = group;
      if (creator !== null) persistedConfig.creator = creator;
      if (assignee !== null) persistedConfig.assignee = assignee;
      return {
        filter: { to, from, group, creator, assignee },
        persistedConfig,
      };
    },
    matches(filter, event) {
      if (event.type !== TASK_STATUS_CHANGED_TRIGGER) return false;
      const { payload } = event;
      if (
        filter.to !== undefined &&
        filter.to.length > 0 &&
        !filter.to.includes(payload.to)
      ) {
        return false;
      }
      if (
        filter.from !== undefined &&
        filter.from.length > 0 &&
        !filter.from.includes(payload.from)
      ) {
        return false;
      }
      if (!matchesOrigin(filter, payload)) return false;
      if (
        !matchesAssignee(
          filter.assignee ?? null,
          payload.assignee,
          payload.assigneeName,
        )
      ) {
        return false;
      }
      return true;
    },
  },
  {
    catalogItem: {
      provider: ETA_EVENTS_PROVIDER_ID,
      source: TASKS_SOURCE_SLUG,
      sourceName: TASKS_SOURCE_NAME,
      trigger: TASK_RUN_FINISHED_TRIGGER,
      name: "Task run finished",
      description:
        "Triggers when a task run ends (completed, failed, or interrupted).",
      modes: [],
      payloadSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          number: { type: "integer" },
          title: { type: "string" },
          runId: { type: "string" },
          status: { type: "string", enum: [...RUN_FINISHED_STATUSES] },
          reason: { type: ["string", "null"] },
          errorCode: { type: ["string", "null"] },
          agentId: { type: ["string", "null"] },
          assignee: { type: ["string", "null"] },
          assigneeName: { type: ["string", "null"] },
          ...ORIGIN_PAYLOAD_PROPERTIES,
          startedAt: { type: ["integer", "null"] },
          finishedAt: { type: ["integer", "null"] },
          occurredAt: { type: "integer" },
        },
      },
      accounts: [],
    },
    configProperties: {
      status: {
        type: "array",
        title: "Run statuses",
        description:
          "Optional run outcomes to match (leave empty to match any finished run).",
        items: {
          type: "string",
          enum: [...RUN_FINISHED_STATUSES],
        },
        examples: ["failed, interrupted"],
      },
    },
    parseConfig(rawConfig) {
      checkAllowedKeys(
        rawConfig,
        ["status", "group", "creator", "assignee"],
        TASK_RUN_FINISHED_TRIGGER,
      );
      const status = parseEnumFilter(
        rawConfig.status,
        "status",
        RUN_FINISHED_STATUSES,
      );
      const group = parseStringFilter(rawConfig.group, "group");
      const creator = parseStringFilter(rawConfig.creator, "creator");
      const assignee = parseStringFilter(rawConfig.assignee, "assignee");
      const persistedConfig: Record<string, unknown> = {};
      if (status !== undefined && status.length > 0)
        persistedConfig.status = status;
      if (group !== null) persistedConfig.group = group;
      if (creator !== null) persistedConfig.creator = creator;
      if (assignee !== null) persistedConfig.assignee = assignee;
      return {
        filter: { status, group, creator, assignee },
        persistedConfig,
      };
    },
    matches(filter, event) {
      if (event.type !== TASK_RUN_FINISHED_TRIGGER) return false;
      const { payload } = event;
      if (
        filter.status !== undefined &&
        filter.status.length > 0 &&
        !filter.status.includes(payload.status)
      ) {
        return false;
      }
      if (!matchesOrigin(filter, payload)) return false;
      if (
        !matchesAssignee(
          filter.assignee ?? null,
          payload.assignee,
          payload.assigneeName,
        )
      ) {
        return false;
      }
      return true;
    },
  },
];

const SPECS_BY_TRIGGER = new Map<string, EtaEventSpec>(
  ETA_EVENT_SPECS.map((spec) => [spec.catalogItem.trigger, spec]),
);

interface ParsedEtaEventsConfig {
  spec: EtaEventSpec;
  triggerSlug: string;
  filter: ParsedEventFilter;
  persistedConfig: Record<string, unknown>;
}

interface ArmedBinding {
  routineId: string;
  instanceId: string;
  parsed: ParsedEtaEventsConfig;
}

export interface EtaEventsTriggerProviderOptions {
  bus: EtaEventBus;
  /** Where the group dropdown reads its options from. */
  conversations: Pick<ConversationStore, "ofKind">;
  /** Where the creator and assignee dropdowns read their options from. */
  agents: Pick<AgentStore, "list">;
  now?: (() => number) | undefined;
  warn?: ((message: string) => void) | undefined;
}

export class EtaEventsTriggerProvider implements TriggerProvider {
  readonly id = ETA_EVENTS_PROVIDER_ID;

  readonly #bus: EtaEventBus;
  readonly #conversations: Pick<ConversationStore, "ofKind">;
  readonly #agents: Pick<AgentStore, "list">;
  readonly #now: () => number;
  readonly #warn: (message: string) => void;

  #host: TriggerProviderHost | undefined;
  #started = false;
  #stopped = false;
  #unsubscribe: (() => void) | undefined;

  readonly #armed = new Map<string, ArmedBinding>();

  constructor(options: EtaEventsTriggerProviderOptions) {
    this.#bus = options.bus;
    this.#conversations = options.conversations;
    this.#agents = options.agents;
    this.#now = options.now ?? Date.now;
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }

  status(): TriggerProviderStatus {
    return { provider: this.id, status: "ready" };
  }

  async listTriggers(filter?: {
    source?: string;
    query?: string;
    refresh?: boolean;
  }): Promise<TriggerCatalogItem[]> {
    const sourceFilter = filter?.source?.trim();
    const query = filter?.query?.trim().toLowerCase();
    const dropdowns = this.#dropdownProperties();
    return ETA_EVENT_SPECS.map(
      (spec): TriggerCatalogItem => ({
        ...spec.catalogItem,
        configSchema: {
          type: "object",
          properties: { ...spec.configProperties, ...dropdowns },
        },
      }),
    ).filter((item) => {
      if (
        sourceFilter !== undefined &&
        sourceFilter !== "" &&
        item.source !== sourceFilter
      ) {
        return false;
      }
      if (query !== undefined && query !== "") {
        const haystack = [
          item.provider,
          item.source,
          item.sourceName,
          item.trigger,
          item.name,
          item.description,
        ]
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }

  /** The group, creator and assignee fields, with the options as they are now. */
  #dropdownProperties(): Record<string, unknown> {
    const agents = this.#agents.list();
    const groups = [
      ...this.#conversations.ofKind("group").filter((group) => !group.archived),
      ...this.#conversations.ofKind(CAPTAIN_KIND),
    ];
    return {
      group: dropdownProperty(
        "Source group",
        "Optional group chat the task was proposed in, Captain's included (leave empty for any).",
        groups,
      ),
      creator: dropdownProperty(
        "Creator",
        "Optional agent that created the task (leave empty for any creator).",
        agents,
      ),
      assignee: dropdownProperty(
        "Assignee",
        "Optional executor agent to match (leave empty for any assignee).",
        agents.filter((agent) => agent.systemRole !== "captain"),
      ),
    };
  }

  async provision(input: {
    routineId: string;
    trigger: RoutineTrigger;
    enabled: boolean;
    existingInstanceId: string | null;
  }): Promise<TriggerProvisionResult> {
    const parsed = parseEtaEventsConfig(input.trigger);
    const instanceId = instanceIdOf(input.routineId);
    this.syncBindings();
    return {
      instanceId,
      accountId: null,
      mode: null,
      pollingIntervalMinutes: null,
      fallbackReason: null,
      active: input.enabled,
      config: parsed.persistedConfig,
    };
  }

  async setEnabled(instanceId: string, enabled: boolean): Promise<void> {
    const routineId = routineIdOf(instanceId);
    if (routineId === null) return;
    if (!enabled) {
      this.#armed.delete(routineId);
      return;
    }
    const binding = this.#host
      ?.bindings()
      .find(
        (item) =>
          item.routineId === routineId && item.trigger.provider === this.id,
      );
    if (binding !== undefined) {
      parseEtaEventsConfig(binding.trigger);
    }
    this.syncBindings();
  }

  async deleteInstance(instanceId: string): Promise<void> {
    const routineId = routineIdOf(instanceId);
    if (routineId === null) return;
    this.#armed.delete(routineId);
  }

  start(host: TriggerProviderHost): void {
    this.#host = host;
    this.#stopped = false;
    this.#started = true;
    if (this.#unsubscribe === undefined) {
      this.#unsubscribe = this.#bus.subscribe((event) => this.#onEvent(event));
    }
    this.syncBindings();
  }

  syncBindings(): void {
    if (!this.#started || this.#stopped) return;
    const bindings = this.#host?.bindings() ?? [];
    const next = new Map<string, ArmedBinding>();

    for (const binding of bindings) {
      if (
        binding.trigger.provider !== this.id ||
        !binding.enabled ||
        binding.instanceId === null
      ) {
        continue;
      }
      let parsed: ParsedEtaEventsConfig;
      try {
        parsed = parseEtaEventsConfig(binding.trigger);
      } catch (error) {
        this.#warn(
          `[eta] eta-events binding ${binding.routineId} has invalid config: ${errorMessage(error)}`,
        );
        continue;
      }
      next.set(binding.routineId, {
        routineId: binding.routineId,
        instanceId: binding.instanceId,
        parsed,
      });
    }

    this.#armed.clear();
    for (const [id, entry] of next) this.#armed.set(id, entry);
  }

  stop(): void {
    this.#stopped = true;
    this.#started = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#armed.clear();
  }

  /** Number of currently armed bindings (for diagnostics/tests). */
  armedCount(): number {
    return this.#armed.size;
  }

  #onEvent(event: EtaInternalEvent): void {
    if (!this.#started || this.#stopped || this.#host === undefined) return;
    for (const armed of this.#armed.values()) {
      if (armed.parsed.triggerSlug !== event.type) continue;
      if (!armed.parsed.spec.matches(armed.parsed.filter, event)) continue;
      try {
        this.#host.onEvent({
          provider: this.id,
          instanceId: armed.instanceId,
          routineId: armed.routineId,
          triggerSlug: event.type,
          source: armed.parsed.spec.catalogItem.source,
          accountId: null,
          eventId: event.eventId,
          occurredAt: Number.isFinite(event.occurredAt)
            ? event.occurredAt
            : this.#now(),
          payload: event.payload,
        });
      } catch (error) {
        this.#warn(
          `[eta] eta-events failed to deliver ${event.type} to routine ${armed.routineId}: ${errorMessage(error)}`,
        );
      }
    }
  }
}

function parseEtaEventsConfig(trigger: RoutineTrigger): ParsedEtaEventsConfig {
  const triggerSlug = trigger.trigger.trim();
  const spec = SPECS_BY_TRIGGER.get(triggerSlug);
  if (spec === undefined) {
    throw new Error(
      `Unsupported eta-events trigger "${trigger.trigger}". Supported events: ${ETA_EVENT_SPECS.map((s) => s.catalogItem.trigger).join(", ")}`,
    );
  }
  const source = trigger.source.trim();
  if (source !== spec.catalogItem.source) {
    throw new Error(
      `Unsupported source "${trigger.source}" for eta-events trigger "${triggerSlug}" (expected "${spec.catalogItem.source}")`,
    );
  }
  if (trigger.mode !== undefined && trigger.mode !== null) {
    throw new Error(
      `eta-events triggers are event-driven in-process and do not support delivery mode "${trigger.mode}"`,
    );
  }
  if (
    trigger.pollingIntervalMinutes !== undefined &&
    trigger.pollingIntervalMinutes !== null
  ) {
    throw new Error("eta-events triggers do not support polling intervals");
  }
  if (
    trigger.accountId !== undefined &&
    trigger.accountId !== null &&
    trigger.accountId.trim() !== ""
  ) {
    throw new Error("eta-events triggers do not use connected accounts");
  }

  const rawConfig = trigger.config ?? {};
  if (
    typeof rawConfig !== "object" ||
    rawConfig === null ||
    Array.isArray(rawConfig)
  ) {
    throw new Error("eta-events trigger config must be an object");
  }

  const { filter, persistedConfig } = spec.parseConfig(rawConfig);
  return {
    spec,
    triggerSlug,
    filter,
    persistedConfig,
  };
}

function checkAllowedKeys(
  rawConfig: Record<string, unknown>,
  allowed: readonly string[],
  triggerSlug: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(rawConfig)) {
    if (!allowedSet.has(key)) {
      throw new Error(
        `Unknown config field "${key}" for eta-events trigger "${triggerSlug}"`,
      );
    }
  }
}

function parseEnumFilter<T extends string>(
  raw: unknown,
  fieldName: string,
  allowed: readonly T[],
): T[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new TypeError(
      `Filter "${fieldName}" must be an array of values (${allowed.join(", ")})`,
    );
  }
  const allowedSet = new Set<string>(allowed);
  const out: T[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new TypeError(
        `Filter "${fieldName}" entries must be strings (${allowed.join(", ")})`,
      );
    }
    const trimmed = item.trim();
    if (!allowedSet.has(trimmed)) {
      throw new Error(
        `Invalid value "${item}" in "${fieldName}" filter; expected one of: ${allowed.join(", ")}`,
      );
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed as T);
    }
  }
  return out;
}

function parseStringFilter(raw: unknown, fieldName: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new TypeError(`Filter "${fieldName}" must be a string`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_ASSIGNEE_CHARS) {
    throw new Error(
      `Filter "${fieldName}" must be at most ${MAX_ASSIGNEE_CHARS} characters`,
    );
  }
  return trimmed;
}

function dropdownProperty(
  title: string,
  description: string,
  options: readonly { id: string; name: string }[],
): Record<string, unknown> {
  return {
    type: "string",
    title,
    description,
    enum: options.map((option) => option.id),
    enumNames: options.map((option) => option.name),
  };
}

function matchesOrigin(
  filter: ParsedEventFilter,
  payload: TaskOriginPayload,
): boolean {
  const group = filter.group ?? null;
  if (group !== null && group !== payload.groupId) return false;
  const creator = filter.creator ?? null;
  if (creator !== null && creator !== payload.creator) return false;
  return true;
}

function matchesAssignee(
  expected: string | null,
  assigneeId: string | null,
  assigneeName: string | null,
): boolean {
  if (expected === null) return true;
  const target = expected.toLowerCase();
  if (assigneeId !== null && assigneeId.toLowerCase() === target) return true;
  if (assigneeName !== null && assigneeName.toLowerCase() === target)
    return true;
  return false;
}

function instanceIdOf(routineId: string): string {
  return `${ETA_EVENTS_PROVIDER_ID}:${routineId}`;
}

function routineIdOf(instanceId: string): string | null {
  const prefix = `${ETA_EVENTS_PROVIDER_ID}:`;
  if (!instanceId.startsWith(prefix)) return null;
  const id = instanceId.slice(prefix.length).trim();
  return id === "" ? null : id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
