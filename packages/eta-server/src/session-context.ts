import type {
  ContextReading,
  GenerationRate,
  MemberSpend,
} from "@eta/client-contracts";
import type { Usage } from "@eta/core";
import type { UsageRow } from "@eta/core/storage";
import type { OpenSession } from "@eta/harness";
import type { SessionMeta } from "./store";
import { contextReason } from "@eta/client-contracts";
import { kernelOn, reportedField } from "@eta/core";
import { deleteValue, setValue, value } from "@eta/core/storage";
import { estimateContextTokens, estimateTokens } from "@eta/harness";
import { formatModelId } from "./model-id";

function spendFor(usage: Usage): MemberSpend {
  const input = reportedField(usage, "input");
  const output = reportedField(usage, "output");
  const read = reportedField(usage, "cacheRead");
  const write = reportedField(usage, "cacheWrite");
  return {
    input: input === null ? null : { value: input, coverage: "complete" },
    output: output === null ? null : { value: output, coverage: "complete" },
    cache:
      read === null && write === null
        ? null
        : {
            value: (read ?? 0) + (write ?? 0),
            coverage: read === null || write === null ? "partial" : "complete",
          },
  };
}

/** The journal can correct a usage row under the same id. Replace its contribution atomically. */
class SpendLedger {
  private readonly rows = new Map<string, MemberSpend>();
  private readonly sums = {
    input: { value: 0, known: 0, complete: 0 },
    output: { value: 0, known: 0, complete: 0 },
    cache: { value: 0, known: 0, complete: 0 },
  };
  record(row: UsageRow): void {
    if ("billedWithPrompt" in row.usage && row.usage.billedWithPrompt === true)
      return;
    const previous = this.rows.get(row.id);
    const next = spendFor(row.usage);
    this.rows.set(row.id, next);
    for (const key of ["input", "output", "cache"] as const) {
      const old = previous?.[key];
      const field = next[key];
      const sum = this.sums[key];
      sum.value += (field?.value ?? 0) - (old?.value ?? 0);
      sum.known += Number(!!field) - Number(!!old);
      sum.complete +=
        Number(field?.coverage === "complete") -
        Number(old?.coverage === "complete");
    }
  }
  view(): MemberSpend {
    const field = (key: keyof MemberSpend): MemberSpend["input"] => {
      const { known, complete, value } = this.sums[key];
      return known
        ? {
            value,
            coverage: complete === this.rows.size ? "complete" : "partial",
          }
        : null;
    };
    return {
      input: field("input"),
      output: field("output"),
      cache: field("cache"),
    };
  }
}

interface SessionContextRecord {
  reading: ContextReading;
  configuredModel: string;
  nativeSessionId: string | null;
  journalCompactionId: string | null;
}

const CONTEXT_VALUE = value<SessionContextRecord>("eta.session-context");
const WRITE_INTERVAL = 5_000;
/** The shortest time between two estimates of a generation in flight. */
const RATE_INTERVAL = 1_000;

function sameMeasurement(a: ContextReading, b: ContextReading): boolean {
  return a.used === b.used && a.window === b.window && a.model === b.model;
}

/** Installed before the pump starts. The returned callback follows the runtime's resume id. */
export async function attachSessionContext(
  session: OpenSession,
  meta: SessionMeta,
  warn: (message: string) => void,
): Promise<(nativeSessionId: string) => void> {
  const on = kernelOn(session.kernel.ctx);
  const runtime = meta.runtime ?? "eta";
  const source =
    runtime === "eta"
      ? "harness"
      : runtime === "codex"
        ? "codex-last"
        : runtime.startsWith("acp.")
          ? "acp"
          : "oar";
  const configured = () =>
    source !== "harness" && session.config.model.provider !== runtime
      ? `${runtime}:default`
      : formatModelId(session.config.model);
  let configuredModel = configured();
  let nativeSessionId = meta.runtimeSession ?? null;
  let active: string | null = null;
  let accepting = false;
  let runtimeModel: string | undefined;
  let latestRuntimeAt = 0;
  const history = session.log.graph.pathOldestFirst().reverse();
  const compaction = history.find((entry) => entry.type === "compaction");
  let journalCompactionId = compaction?.id ?? null;
  let reading: ContextReading = {
    session: meta.id,
    source,
    model: configuredModel,
    runId: null,
    used: null,
    window: null,
    observedAt: Date.now(),
    compactedAt: compaction?.timestamp ?? null,
    reason: "missing",
  };
  let pending: SessionContextRecord | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastQueued = reading;
  function clearPending() {
    const final = pending;
    pending = undefined;
    clearTimeout(timer);
    timer = undefined;
    return final;
  }
  function record(): SessionContextRecord {
    return {
      reading,
      configuredModel,
      nativeSessionId,
      journalCompactionId,
    };
  }
  async function write(snapshot: SessionContextRecord) {
    await session.journaling.writeValues([setValue(CONTEXT_VALUE, snapshot)]);
  }
  function observe(next: ContextReading) {
    reading = next;
    pending = record();
    if (timer !== undefined || sameMeasurement(lastQueued, next)) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (pending === undefined) return;
      lastQueued = pending.reading;
      // Keep the run's last snapshot for its durability boundary.
      void write(pending);
    }, WRITE_INTERVAL);
    timer.unref?.();
  }
  function invalidate(
    reason: NonNullable<ContextReading["reason"]>,
    at = Date.now(),
    model = configuredModel,
    compactedAt = reading.compactedAt,
  ) {
    reading = {
      session: meta.id,
      source,
      model,
      runId: active,
      used: null,
      window: null,
      observedAt: at,
      compactedAt,
      reason,
    };
    clearPending();
    lastQueued = reading;
    // A boundary must survive even when it has no next sample or occurs between runs.
    return write(record());
  }
  function estimate() {
    const { provider, modelId } = session.config.model;
    const resolved = session.models.getModel(provider, modelId);
    const window =
      resolved && !("assumedContextWindow" in resolved)
        ? (resolved.contextWindow ?? null)
        : null;
    const used = estimateContextTokens(session.runner.getTranscript()).tokens;
    const next: ContextReading = {
      ...reading,
      model: configuredModel,
      runId: active,
      observation: active === null ? "last-observed" : "live",
      used,
      window,
      observedAt: Date.now(),
      reason: null,
    };
    next.reason = contextReason(next);
    if (active === null) reading = next;
    else observe(next);
  }

  const stored = await session.log.storage.getValue(CONTEXT_VALUE).catch(() => {
    warn("[eta-session-context] journal read failed");
    return undefined;
  });
  const saved = stored?.value;
  const previous = saved?.reading;
  if (stored !== undefined) {
    if (
      !previous ||
      previous.session !== meta.id ||
      previous.source !== source ||
      typeof previous.model !== "string" ||
      !previous.model ||
      (source !== "harness" && !previous.model.startsWith(`${runtime}:`)) ||
      !Number.isFinite(previous.observedAt) ||
      previous.observedAt > Date.now()
    ) {
      await session.journaling.writeValues([deleteValue(CONTEXT_VALUE)]);
    } else if (saved.journalCompactionId !== journalCompactionId) {
      await invalidate("compacted", compaction?.timestamp);
    } else if (saved.nativeSessionId !== nativeSessionId) {
      await invalidate("nativeSession");
    } else if (saved.configuredModel !== configuredModel) {
      await invalidate(
        "model",
        Date.now(),
        configuredModel,
        previous.compactedAt,
      );
    } else if (previous.reason !== null) {
      const { observation: _observation, ...fields } = previous;
      reading = { ...fields, reason: contextReason(previous) ?? "unverified" };
    } else if (runtime === "claude" && previous.used === 0) {
      // Older Claude projections persisted the assistant's zero placeholders.
      await invalidate(
        "missing",
        previous.observedAt,
        previous.model,
        previous.compactedAt,
      );
    } else if (
      (source === "harness" || nativeSessionId !== null) &&
      previous.observedAt >= (previous.compactedAt ?? 0) &&
      previous.observedAt >= (compaction?.timestamp ?? 0) &&
      (source !== "harness" || previous.model === configuredModel) &&
      contextReason({ ...previous, observation: "last-observed" }) === null
    ) {
      reading = { ...previous, observation: "last-observed" };
    } else {
      await session.journaling.writeValues([deleteValue(CONTEXT_VALUE)]);
    }
  } else if (source === "harness") {
    // A retained tail can predate compaction. A completion after the cut can seed an estimate.
    const last = history.find(
      (entry) =>
        entry.type === "compaction" ||
        (entry.type === "message" && entry.message.role === "assistant"),
    );
    if (last?.type === "compaction")
      await invalidate("compacted", last.timestamp);
    else if (
      last?.type === "message" &&
      last.message.role === "assistant" &&
      formatModelId({
        provider: last.message.provider,
        modelId: last.message.model,
      }) !== configuredModel
    )
      await invalidate("model");
    else estimate();
  }
  latestRuntimeAt = reading.reason === "missing" ? 0 : reading.observedAt;
  lastQueued = reading;

  on("state:config-update", () => {
    if (configuredModel === configured()) return;
    configuredModel = configured();
    runtimeModel = undefined;
    if (source !== "harness") accepting = false;
    const at = Date.now();
    latestRuntimeAt = Math.max(latestRuntimeAt, at);
    void invalidate("model", at);
  });
  on("turn:run-start", ({ runId }) => {
    active = runId;
    accepting = true;
    runtimeModel = undefined;
    if (reading.observation === "live")
      reading = { ...reading, observation: "last-observed" };
  });
  session.journaling.onRunEnd(async (runId) => {
    if (active !== runId) return;
    accepting = false;
    const final = clearPending();
    if (final?.reading.runId === runId) {
      lastQueued = final.reading;
      await write(final);
    }
  });
  on("turn:run-end", ({ runId }) => {
    if (active !== runId) return;
    active = null;
    accepting = false;
    if (reading.observation === "live")
      reading = { ...reading, observation: "last-observed" };
  });
  on("context:observed", (sample) => {
    if (
      source === "harness" ||
      !accepting ||
      sample.runId !== active ||
      sample.nativeSessionId !== nativeSessionId ||
      sample.observedAt < latestRuntimeAt ||
      (runtimeModel !== undefined &&
        sample.model !== runtimeModel &&
        sample.reason !== "model")
    )
      return;
    latestRuntimeAt = sample.observedAt;
    runtimeModel = sample.model;
    const model = `${runtime}:${sample.model}`;
    // An empty report carries no replacement for a compatible observation.
    if (
      sample.reason === undefined &&
      reading.reason === null &&
      reading.model === model &&
      (sample.used === null || sample.window === null) &&
      (sample.used === null || sample.used === reading.used) &&
      (sample.window === null || sample.window === reading.window)
    )
      return;
    const next: ContextReading = {
      ...reading,
      runId: sample.runId,
      model,
      used: sample.used,
      window: sample.window,
      observedAt: sample.observedAt,
      observation: "live",
      reason: sample.reason ?? null,
    };
    const reason = contextReason(next);
    if (reason === null) {
      observe(next);
    } else if (reason === "compacted" || reason === "model") {
      void invalidate(reason, sample.observedAt, model, sample.compactedAt);
    } else if (
      reason === "inconsistent" ||
      (reading.reason !== "compacted" &&
        reading.reason !== "model" &&
        reading.reason !== "nativeSession")
    ) {
      const { observation: _observation, ...fields } = next;
      observe({ ...fields, reason });
    }
  });
  on("context:invalidated", (event) => {
    if (
      event.at < latestRuntimeAt ||
      (event.nativeSessionId !== undefined &&
        event.nativeSessionId !== nativeSessionId) ||
      (event.runId !== undefined && (event.runId !== active || !accepting))
    )
      return;
    if (event.model !== undefined) {
      runtimeModel = event.model;
      if (
        reading.model === `${runtime}:${event.model}` ||
        (event.runId !== undefined &&
          (reading.reason === "missing" || reading.reason === "nativeSession"))
      )
        return;
    }
    latestRuntimeAt = event.at;
    void invalidate(
      event.reason,
      event.at,
      event.model === undefined ? reading.model : `${runtime}:${event.model}`,
      event.compactedAt,
    );
  });
  on("compaction:start", () => {
    void invalidate("compacted");
  });
  on("compaction:end", ({ status, endedAt }) => {
    if (status !== "completed") return;
    journalCompactionId =
      session.log.graph
        .pathOldestFirst()
        .reverse()
        .find((entry) => entry.type === "compaction")?.id ?? null;
    void invalidate("compacted", endedAt, configuredModel, endedAt);
  });
  if (source === "harness") {
    on("message:end", ({ message, runId }) => {
      if (active !== null && (!accepting || runId !== active)) return;
      if (reading.reason === "model" || reading.reason === "compacted") {
        if (
          active === null ||
          message.role !== "assistant" ||
          message.model !== session.config.model.modelId ||
          message.provider !== session.config.model.provider
        )
          return;
      }
      estimate();
    });
  }
  session.kernel.ctx.effect(() => () => {
    clearPending();
  });
  session.view.contribute({
    name: "context",
    project: () => reading,
    revision: () => JSON.stringify(reading),
  });
  const ledger = new SpendLedger();
  for (const row of await session.log.storage.scanUsage({})) ledger.record(row);
  let spend = ledger.view();
  on("usage:recorded", ({ row }) => {
    ledger.record(row);
    spend = ledger.view();
  });
  session.view.contribute({
    name: "spend",
    project: () => spend,
    revision: () => JSON.stringify(spend),
  });
  // The rate of the generation in flight, timed from its first output; null until its first
  // estimate, and the last generation's measured rate between two generations of a turn.
  let rate: GenerationRate | null = null;
  let firstOutputAt: number | undefined;
  let lastOutputAt = 0;
  let estimatedAt = 0;
  const restart = () => {
    firstOutputAt = undefined;
    estimatedAt = 0;
    rate = null;
  };
  on("message:start", restart);
  on("generation:interrupted", restart);
  on("turn:run-end", restart);
  on("message:update", ({ message, event }) => {
    if (
      event.type === "start" ||
      event.type === "done" ||
      event.type === "error"
    )
      return;
    const now = Date.now();
    lastOutputAt = now;
    if (firstOutputAt === undefined) {
      firstOutputAt = estimatedAt = now;
      return;
    }
    if (now - estimatedAt < RATE_INTERVAL) return;
    estimatedAt = now;
    rate = {
      tokensPerSec: (estimateTokens(message) * 1000) / (now - firstOutputAt),
      basis: "estimate",
    };
  });
  on("message:end", ({ message }) => {
    if (message.role !== "assistant" || firstOutputAt === undefined) return;
    const elapsed = lastOutputAt - firstOutputAt;
    firstOutputAt = undefined;
    if (elapsed > 0) {
      // A provider that reported no output leaves the generation counted from its text.
      const output = reportedField(message.usage, "output");
      rate = output
        ? { tokensPerSec: (output * 1000) / elapsed, basis: "measured" }
        : {
            tokensPerSec: (estimateTokens(message) * 1000) / elapsed,
            basis: "estimate",
          };
    }
  });
  session.view.contribute({
    name: "rate",
    project: () => rate,
    revision: () => JSON.stringify(rate),
  });
  return (next) => {
    if (nativeSessionId === next) return;
    const previous = nativeSessionId;
    nativeSessionId = next;
    runtimeModel = undefined;
    latestRuntimeAt = 0;
    if (previous !== null)
      void invalidate("nativeSession", Date.now(), configuredModel, null);
  };
}
