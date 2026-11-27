/**
 * Multi-channel routine event trigger hub (`TriggerHub`) and provider interface (`TriggerProvider`).
 *
 * Each external event source (Composio first; future Webhook/Slack/GitHub adapters later)
 * registers a thin `TriggerProvider`. `TriggerHub` owns the cross-provider concerns:
 * - Aggregating & filtering the available trigger catalog (`routines.triggers` / `list_triggers`)
 * - Reconciling remote trigger instances on routine create / update / enable / disable / delete
 *   without blocking host startup on remote failures (`status: "error"`, `lastError`)
 * - Idempotent persistence into `routine_trigger_event` with 24h TTL and per-routine backlog cap
 * - Coalescing bursts & holding events while a run is going or Captain is off, then draining the
 *   pending batch into one `runPrompt` as soon as the routine slot is free and Captain is on.
 */
import type {
  RoutinesStatus,
  RoutineTrigger,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { RoutineRunner } from "./runner";
import type { RoutineStore, RoutineTriggerRecord } from "./store";
import { Buffer } from "node:buffer";
import { redactText } from "../captain/redact";

const DEFAULT_TRIGGER_COALESCE_MS = 50;
const DEFAULT_TRIGGER_EVENT_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_TRIGGER_MAX_PENDING = 20;
const DEFAULT_TRIGGER_MAX_BATCH = 20;
const MAX_STORED_PAYLOAD_BYTES = 32 * 1024;
const MAX_STORED_PREVIEW_CHARS = 16_000;
const MAX_ERROR_CHARS = 500;

export interface TriggerProvisionResult {
  instanceId: string;
  accountId: string | null;
  mode: "webhook" | "poll" | null;
  pollingIntervalMinutes: number | null;
  fallbackReason: string | null;
  active: boolean;
}

export interface IncomingTriggerEvent {
  provider: string;
  instanceId?: string | null;
  routineId?: string | null;
  triggerSlug: string;
  source?: string | null;
  accountId?: string | null;
  eventId: string;
  occurredAt: number;
  payload: unknown;
}

export interface TriggerBinding {
  routineId: string;
  enabled: boolean;
  trigger: RoutineTrigger;
  instanceId: string | null;
}

export interface TriggerProviderHost {
  bindings: () => TriggerBinding[];
  onEvent: (event: IncomingTriggerEvent) => void;
  onBindingsChanged: () => void;
  onTriggerError?: (routineId: string, error: string) => void;
  onTriggerRecovered?: (routineId: string) => void;
}

export interface TriggerProvider {
  readonly id: string;
  status: () => TriggerProviderStatus;
  listTriggers: (filter?: {
    source?: string;
    query?: string;
    refresh?: boolean;
  }) => Promise<TriggerCatalogItem[]>;
  provision: (input: {
    routineId: string;
    trigger: RoutineTrigger;
    enabled: boolean;
    existingInstanceId: string | null;
  }) => Promise<TriggerProvisionResult>;
  setEnabled: (instanceId: string, enabled: boolean) => Promise<void>;
  deleteInstance: (instanceId: string) => Promise<void>;
  start: (host: TriggerProviderHost) => void;
  syncBindings: () => void;
  stop: () => Promise<void> | void;
}

export interface TriggerHubOptions {
  store: RoutineStore;
  runner: RoutineRunner;
  captainStatus: () => RoutinesStatus;
  now?: () => number;
  changed: (routineId: string) => void;
  warn: (message: string) => void;
  coalesceMs?: number | undefined;
  eventTtlMs?: number | undefined;
  maxPendingPerRoutine?: number | undefined;
  maxBatch?: number | undefined;
}

export class TriggerHub {
  readonly #store: RoutineStore;
  readonly #runner: RoutineRunner;
  readonly #captainStatus: () => RoutinesStatus;
  readonly #now: () => number;
  readonly #changed: (routineId: string) => void;
  readonly #warn: (message: string) => void;
  readonly #coalesceMs: number;
  readonly #eventTtlMs: number;
  readonly #maxPending: number;
  readonly #maxBatch: number;

  readonly #providers = new Map<string, TriggerProvider>();
  readonly #drainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #draining = new Set<string>();
  readonly #syncLocks = new Map<string, Promise<void>>();
  #started = false;
  #stopped = false;
  #reconciling: Promise<void> | undefined;

  constructor(options: TriggerHubOptions) {
    this.#store = options.store;
    this.#runner = options.runner;
    this.#captainStatus = options.captainStatus;
    this.#now = options.now ?? Date.now;
    this.#changed = options.changed;
    this.#warn = options.warn;
    this.#coalesceMs = options.coalesceMs ?? DEFAULT_TRIGGER_COALESCE_MS;
    this.#eventTtlMs = options.eventTtlMs ?? DEFAULT_TRIGGER_EVENT_TTL_MS;
    this.#maxPending =
      options.maxPendingPerRoutine ?? DEFAULT_TRIGGER_MAX_PENDING;
    this.#maxBatch = options.maxBatch ?? DEFAULT_TRIGGER_MAX_BATCH;
  }

  register(provider: TriggerProvider): void {
    this.#providers.set(provider.id, provider);
    if (this.#started && !this.#stopped) {
      this.#startProvider(provider);
      void this.#reconcileProvider(provider.id).catch((error: unknown) => {
        this.#warn(
          `[eta] trigger provider ${provider.id} reconcile failed: ${errorText(error)}`,
        );
      });
    }
  }

  hasProvider(id: string): boolean {
    return this.#providers.has(id);
  }

  provider(id: string): TriggerProvider | undefined {
    return this.#providers.get(id);
  }

  start(): void {
    if (this.#started && !this.#stopped) return;
    this.#started = true;
    this.#stopped = false;
    for (const provider of this.#providers.values())
      this.#startProvider(provider);
    // Reconcile any enabled triggers that have not yet provisioned or errored in background so
    // host startup never waits on external API calls.
    void this.reconcileAll().catch((error: unknown) => {
      this.#warn(`[eta] trigger reconcile failed: ${errorText(error)}`);
    });
    this.drainAllSoon();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#started = false;
    for (const timer of this.#drainTimers.values()) clearTimeout(timer);
    this.#drainTimers.clear();
    await Promise.allSettled(
      [...this.#providers.values()].map((provider) =>
        Promise.resolve(provider.stop()),
      ),
    );
  }

  #startProvider(provider: TriggerProvider): void {
    provider.start({
      bindings: () => this.#bindingsFor(provider.id),
      onEvent: (event) => this.ingest(event),
      onBindingsChanged: () => {
        void this.#reconcileProvider(provider.id)
          .then(() => provider.syncBindings())
          .catch((error: unknown) => {
            this.#warn(
              `[eta] trigger provider ${provider.id} sync failed: ${errorText(error)}`,
            );
          });
      },
      onTriggerError: (routineId, error) => {
        const routine = this.#store.get(routineId);
        const current = this.#store.trigger(routineId);
        if (
          routine === undefined ||
          !routine.enabled ||
          current?.provider !== provider.id
        ) {
          return;
        }
        const message = errorText(error);
        if (current.status === "error" && current.lastError === message) return;
        this.#store.updateTriggerState(routineId, {
          status: "error",
          lastError: message,
        });
        this.#changed(routineId);
      },
      onTriggerRecovered: (routineId) => {
        const routine = this.#store.get(routineId);
        const current = this.#store.trigger(routineId);
        if (
          routine === undefined ||
          !routine.enabled ||
          current?.provider !== provider.id
        ) {
          return;
        }
        if (current.status !== "error" && current.lastError === null) return;
        this.#store.updateTriggerState(routineId, {
          status: "active",
          lastError: null,
        });
        this.#changed(routineId);
      },
    });
  }

  #bindingsFor(providerId: string): TriggerBinding[] {
    const routines = new Map(this.#store.list().map((r) => [r.id, r]));
    return this.#store.triggers(providerId).flatMap((record) => {
      const routine = routines.get(record.routineId);
      if (routine === undefined) return [];
      return [
        {
          routineId: record.routineId,
          enabled: routine.enabled,
          trigger: {
            provider: record.provider,
            source: record.source,
            trigger: record.triggerSlug,
            accountId: record.accountId,
            config: record.config,
            mode: record.requestedMode,
            pollingIntervalMinutes: record.requestedPollingInterval,
          },
          instanceId: record.instanceId,
        },
      ];
    });
  }

  /* --------------------------------------------------------------- catalog */

  async listTriggers(
    filter: {
      provider?: string | undefined;
      source?: string | undefined;
      query?: string | undefined;
      refresh?: boolean | undefined;
    } = {},
  ): Promise<{
    triggers: TriggerCatalogItem[];
    providers: TriggerProviderStatus[];
  }> {
    const selected =
      filter.provider === undefined
        ? [...this.#providers.values()]
        : [this.#providers.get(filter.provider)].filter(
            (p): p is TriggerProvider => p !== undefined,
          );
    if (filter.provider !== undefined && selected.length === 0)
      throw new Error(`unknown trigger provider: ${filter.provider}`);

    const providers: TriggerProviderStatus[] = [];
    const items: TriggerCatalogItem[] = [];
    await Promise.all(
      selected.map(async (provider) => {
        try {
          const found = await provider.listTriggers({
            ...(filter.source === undefined ? {} : { source: filter.source }),
            ...(filter.query === undefined ? {} : { query: filter.query }),
            ...(filter.refresh === undefined
              ? {}
              : { refresh: filter.refresh }),
          });
          providers.push(provider.status());
          items.push(...found);
        } catch (error) {
          providers.push({
            provider: provider.id,
            status: "error",
            error: errorText(error),
          });
        }
      }),
    );

    const query = filter.query?.trim().toLowerCase();
    const filtered =
      query === undefined || query === ""
        ? items
        : items.filter((item) =>
            [
              item.provider,
              item.source,
              item.sourceName,
              item.trigger,
              item.name,
              item.description,
            ]
              .join("\n")
              .toLowerCase()
              .includes(query),
          );
    filtered.sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.source.localeCompare(b.source) ||
        a.trigger.localeCompare(b.trigger),
    );
    providers.sort((a, b) => a.provider.localeCompare(b.provider));
    return { triggers: filtered, providers };
  }

  /* --------------------------------------------------------- routine sync */

  async onCreated(routineId: string): Promise<void> {
    await this.#withSyncLock(routineId, async () => {
      const routine = this.#store.get(routineId);
      const trigger = this.#store.trigger(routineId);
      if (routine === undefined || trigger === undefined) return;
      await this.#syncRoutine(routine.id, routine.enabled, trigger);
    });
  }

  async onUpdated(input: {
    routineId: string;
    previousTrigger: RoutineTriggerRecord | undefined;
    triggerPatch: RoutineTrigger | null | undefined;
    enabledBefore: boolean;
    enabledAfter: boolean;
  }): Promise<void> {
    await this.#withSyncLock(input.routineId, async () => {
      const prev = input.previousTrigger;
      const current = this.#store.trigger(input.routineId);

      // If the previous trigger was removed or replaced, drop its remote instance first (if unshared)
      // and retire any stale pending events from the old trigger definition.
      // Same-provider inbound webhook edits keep their persisted URL token and secret intact,
      // while leaving/deleting a disabled webhook still cleans up SettingStore credentials.
      if (
        prev !== undefined &&
        (input.triggerPatch === null || input.triggerPatch !== undefined)
      ) {
        this.#clearPendingOnTriggerChange(input.routineId);
        const targetInstanceId =
          prev.instanceId ??
          (prev.provider === "webhook" ? `webhook:${prev.routineId}` : null);
        if (
          targetInstanceId !== null &&
          !(
            current !== undefined &&
            prev.provider === "webhook" &&
            current.provider === "webhook"
          )
        )
          await this.#deleteUnshared(
            prev.provider,
            targetInstanceId,
            prev.routineId,
          );
      }

      if (current === undefined) {
        this.#providers.get(prev?.provider ?? "")?.syncBindings();
        return;
      }

      const needSync =
        input.triggerPatch !== undefined ||
        input.enabledBefore !== input.enabledAfter ||
        (input.enabledAfter &&
          (current.status === "error" || current.instanceId === null));
      if (needSync) {
        await this.#syncRoutine(input.routineId, input.enabledAfter, current, {
          forceProvision: input.triggerPatch !== undefined,
        });
      }
      if (input.enabledAfter) this.drainSoon(input.routineId, 0);
    });
  }

  async onRemoved(previousTrigger: RoutineTriggerRecord): Promise<void> {
    await this.#withSyncLock(previousTrigger.routineId, async () => {
      const timer = this.#drainTimers.get(previousTrigger.routineId);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.#drainTimers.delete(previousTrigger.routineId);
      }
      const targetInstanceId =
        previousTrigger.instanceId ??
        (previousTrigger.provider === "webhook"
          ? `webhook:${previousTrigger.routineId}`
          : null);
      if (targetInstanceId !== null) {
        await this.#deleteUnshared(
          previousTrigger.provider,
          targetInstanceId,
          previousTrigger.routineId,
        );
      }
      this.#providers.get(previousTrigger.provider)?.syncBindings();
    });
  }

  #withSyncLock(routineId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.#syncLocks.get(routineId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(fn);
    const settled = next.finally(() => {
      if (this.#syncLocks.get(routineId) === settled)
        this.#syncLocks.delete(routineId);
    });
    this.#syncLocks.set(routineId, settled);
    return next;
  }

  async reconcileAll(): Promise<void> {
    if (this.#reconciling !== undefined) return await this.#reconciling;
    this.#reconciling = (async () => {
      for (const provider of this.#providers.keys())
        await this.#reconcileProvider(provider);
    })().finally(() => {
      this.#reconciling = undefined;
    });
    return await this.#reconciling;
  }

  async #reconcileProvider(providerId: string): Promise<void> {
    const provider = this.#providers.get(providerId);
    if (provider === undefined || this.#stopped) return;
    const status = provider.status();
    if (status.status !== "ready") {
      provider.syncBindings();
      return;
    }
    for (const initial of this.#store.triggers(providerId)) {
      if (this.#stopped) return;
      await this.#withSyncLock(initial.routineId, async () => {
        if (this.#stopped) return;
        const routine = this.#store.get(initial.routineId);
        const record = this.#store.trigger(initial.routineId);
        if (
          routine === undefined ||
          record === undefined ||
          record.provider !== providerId
        )
          return;
        if (
          routine.enabled &&
          (record.status !== "active" || record.instanceId === null)
        ) {
          await this.#syncRoutine(routine.id, true, record);
        }
      });
    }
    provider.syncBindings();
  }

  async #syncRoutine(
    routineId: string,
    enabled: boolean,
    record: RoutineTriggerRecord,
    options?: { forceProvision?: boolean },
  ): Promise<void> {
    const provider = this.#providers.get(record.provider);
    if (provider === undefined) {
      this.#store.updateTriggerState(routineId, {
        status: "error",
        lastError: `unknown trigger provider: ${record.provider}`,
      });
      this.#changed(routineId);
      return;
    }
    const trigger: RoutineTrigger = {
      provider: record.provider,
      source: record.source,
      trigger: record.triggerSlug,
      accountId: record.accountId,
      config: record.config,
      mode: record.requestedMode,
      pollingIntervalMinutes: record.requestedPollingInterval,
    };
    try {
      if (!enabled) {
        if (
          record.instanceId !== null &&
          this.#store.countSharedInstance(
            record.provider,
            record.instanceId,
            routineId,
            { enabledOnly: true },
          ) === 0
        ) {
          await provider.setEnabled(record.instanceId, false);
        }
        this.#store.updateTriggerState(routineId, {
          status: "disabled",
          lastError: null,
        });
      } else if (
        !options?.forceProvision &&
        record.instanceId !== null &&
        record.status === "disabled"
      ) {
        try {
          await provider.setEnabled(record.instanceId, true);
          this.#store.updateTriggerState(routineId, {
            status: "active",
            lastError: null,
          });
        } catch {
          // If the remote instance was removed or stale, fall back to full provision/upsert.
          const result = await provider.provision({
            routineId,
            trigger,
            enabled: true,
            existingInstanceId: record.instanceId,
          });
          this.#applyProvisioned(routineId, result);
        }
      } else {
        const result = await provider.provision({
          routineId,
          trigger,
          enabled: true,
          existingInstanceId: record.instanceId,
        });
        this.#applyProvisioned(routineId, result);
      }
    } catch (error) {
      const message = errorText(error);
      this.#store.updateTriggerState(routineId, {
        status: "error",
        lastError: message,
      });
      this.#warn(
        `[eta] routine ${routineId} trigger sync failed (${record.provider}/${record.triggerSlug}): ${message}`,
      );
    } finally {
      provider.syncBindings();
      this.#changed(routineId);
    }
  }

  #applyProvisioned(routineId: string, result: TriggerProvisionResult): void {
    this.#store.updateTriggerState(routineId, {
      accountId: result.accountId,
      instanceId: result.instanceId,
      effectiveMode: result.mode,
      pollingInterval: result.pollingIntervalMinutes,
      fallbackReason: result.fallbackReason,
      status: result.active ? "active" : "disabled",
      lastError: null,
    });
  }

  async #deleteUnshared(
    providerId: string,
    instanceId: string,
    routineId: string,
  ): Promise<void> {
    const provider = this.#providers.get(providerId);
    if (provider === undefined) return;
    if (
      this.#store.countSharedInstance(providerId, instanceId, routineId) > 0
    ) {
      if (
        this.#store.countSharedInstance(providerId, instanceId, routineId, {
          enabledOnly: true,
        }) === 0
      ) {
        await provider.setEnabled(instanceId, false).catch((error: unknown) => {
          this.#warn(
            `[eta] failed to disable shared remote trigger ${providerId}:${instanceId}: ${errorText(error)}`,
          );
        });
      }
      return;
    }
    try {
      await provider.deleteInstance(instanceId);
    } catch (error) {
      this.#warn(
        `[eta] failed to delete remote trigger ${providerId}:${instanceId}: ${errorText(error)}`,
      );
    }
  }

  #clearPendingOnTriggerChange(routineId: string): void {
    this.#store.expireAllPending(routineId);
  }

  /* -------------------------------------------------------- event pipeline */

  /** Ingest an incoming event from any provider: idempotently store, cap, and schedule drain. */
  ingest(event: IncomingTriggerEvent): number {
    if (this.#stopped) return 0;
    const eventId = event.eventId.trim();
    if (eventId === "") return 0;
    const matched = this.#store
      .findTriggerRoutines({
        provider: event.provider,
        instanceId: event.instanceId,
        routineId: event.routineId,
        source: event.source,
        triggerSlug: event.triggerSlug,
        accountId: event.accountId,
      })
      .filter((routine) => routine.enabled);
    if (matched.length === 0) return 0;

    const payloadJson = boundPayloadJson(event.payload);
    const occurredAt = Number.isFinite(event.occurredAt)
      ? event.occurredAt
      : this.#now();

    let queued = 0;
    for (const routine of matched) {
      const result = this.#store.enqueueTriggerEvent({
        routineId: routine.id,
        provider: event.provider,
        eventId,
        instanceId: event.instanceId ?? null,
        triggerSlug: event.triggerSlug,
        occurredAt,
        payloadJson,
        ttlMs: this.#eventTtlMs,
        maxPending: this.#maxPending,
      });
      if (!result.inserted) continue;
      queued++;
      this.#changed(routine.id);
      this.drainSoon(routine.id, this.#coalesceMs);
    }
    return queued;
  }

  /** Called when Captain's availability or settings move; drains pending batches once Captain is on. */
  captainChanged(): void {
    if (this.#stopped || !this.#captainStatus().captainOn) return;
    this.drainAllSoon();
  }

  /** Called when any run of `routineId` ends, so queued events from while it ran drain at once. */
  onRunFinished(routineId: string): void {
    if (this.#stopped || !this.#captainStatus().captainOn) return;
    this.drainSoon(routineId, 0);
  }

  drainAllSoon(): void {
    if (this.#stopped || !this.#captainStatus().captainOn) return;
    for (const routineId of this.#store.pendingTriggerRoutines(
      this.#eventTtlMs,
    ))
      this.drainSoon(routineId, 0);
  }

  drainSoon(routineId: string, delayMs = this.#coalesceMs): void {
    if (this.#stopped) return;
    if (!this.#captainStatus().captainOn) return;
    const existing = this.#drainTimers.get(routineId);
    if (existing !== undefined) {
      if (delayMs > 0) return;
      clearTimeout(existing);
      this.#drainTimers.delete(routineId);
    }
    if (delayMs <= 0) {
      this.#drainNow(routineId);
      return;
    }
    const timer = setTimeout(() => {
      this.#drainTimers.delete(routineId);
      this.#drainNow(routineId);
    }, delayMs);
    timer.unref?.();
    this.#drainTimers.set(routineId, timer);
  }

  #drainNow(routineId: string): void {
    if (this.#stopped || this.#draining.has(routineId)) return;
    if (!this.#captainStatus().captainOn || !this.#runner.canStart()) return;
    const routine = this.#store.get(routineId);
    if (routine === undefined || !routine.enabled) return;
    if (this.#store.runningRun(routineId) !== undefined) return;

    this.#draining.add(routineId);
    try {
      const claimed = this.#store.claimTriggerBatch({
        routineId,
        ttlMs: this.#eventTtlMs,
        maxBatch: this.#maxBatch,
      });
      if (claimed === undefined) return;
      this.#runner.launchTrigger(routine, claimed.run, {
        events: claimed.events.map((item) => ({
          eventId: item.eventId,
          occurredAt: item.occurredAt,
          triggerSlug: item.triggerSlug,
          source: this.#store.trigger(routineId)?.source ?? null,
          payload: item.payload,
        })),
        droppedCount: claimed.droppedCount,
      });
    } finally {
      this.#draining.delete(routineId);
    }
  }
}

function boundPayloadJson(payload: unknown): string {
  try {
    const raw = JSON.stringify(payload ?? {});
    if (raw === undefined) return "{}";
    if (Buffer.byteLength(raw, "utf8") <= MAX_STORED_PAYLOAD_BYTES) return raw;
    return JSON.stringify({
      _truncated: true,
      preview: raw.slice(0, MAX_STORED_PREVIEW_CHARS),
    });
  } catch {
    return JSON.stringify({ _unserializable: true, text: String(payload) });
  }
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const clean = redactText(raw).trim();
  if (clean.length <= MAX_ERROR_CHARS) return clean;
  return `${clean.slice(0, MAX_ERROR_CHARS - 1)}…`;
}
