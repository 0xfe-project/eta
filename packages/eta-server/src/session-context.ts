import type { ContextReading, MemberSpend } from "@eta/client-contracts";
import type { Usage } from "@eta/core";
import type { UsageRow } from "@eta/core/storage";
import type { OpenSession } from "@eta/harness";
import type { SessionMeta } from "./store";
import { contextReason } from "@eta/client-contracts";
import { kernelOn, reportedField } from "@eta/core";
import { estimateContextTokens } from "@eta/harness";
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

/** Installed before a session's pump starts. Every listener belongs to that session's kernel. */
export async function attachSessionContext(
  session: OpenSession,
  meta: SessionMeta,
): Promise<void> {
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
  let model = configured();
  let active: string | null = null;
  let runtimeModel: string | undefined;
  let latestRuntimeAt = 0;
  const history = session.log.graph.pathOldestFirst().reverse();
  let reading: ContextReading = {
    session: meta.id,
    source,
    model,
    runId: null,
    used: null,
    window: null,
    observedAt: Date.now(),
    compactedAt:
      history.find((entry) => entry.type === "compaction")?.timestamp ?? null,
    reason: "missing",
  };
  function reset(reason: ContextReading["reason"], at = Date.now()) {
    reading = {
      ...reading,
      model,
      runId: active,
      used: null,
      window: null,
      observedAt: at,
      reason,
    };
  }
  function estimate() {
    const { provider, modelId } = session.config.model;
    const resolved = session.models.getModel(provider, modelId);
    const window =
      resolved && !("assumedContextWindow" in resolved)
        ? (resolved.contextWindow ?? null)
        : null;
    const used = estimateContextTokens(session.runner.getTranscript()).tokens;
    reading = {
      ...reading,
      model,
      runId: active,
      used,
      window,
      observedAt: Date.now(),
      reason: null,
    };
    reading.reason = contextReason(reading);
  }
  if (source === "harness") {
    // A retained tail may contain the previous model call. On reopen, only a completion
    // written after the last compaction can establish a new baseline.
    const last = history.find(
      (entry) =>
        entry.type === "compaction" ||
        (entry.type === "message" && entry.message.role === "assistant"),
    );
    if (last?.type === "compaction") reset("compacted", last.timestamp);
    else if (
      last?.type === "message" &&
      last.message.role === "assistant" &&
      formatModelId({
        provider: last.message.provider,
        modelId: last.message.model,
      }) !== model
    )
      reset("model");
    else estimate();
  }
  on("state:config-update", () => {
    if (model === configured()) return;
    model = configured();
    active = null;
    reset("model");
  });
  on("turn:run-start", ({ runId }) => {
    active = runId;
    runtimeModel = undefined;
    if (source !== "harness")
      reset(
        reading.reason === "compacted" || reading.reason === "model"
          ? reading.reason
          : "missing",
      );
  });
  on("turn:run-end", ({ runId }) => {
    if (active === runId) active = null;
  });
  on("context:observed", (sample) => {
    if (
      source === "harness" ||
      sample.runId !== active ||
      sample.observedAt < latestRuntimeAt ||
      (runtimeModel !== undefined &&
        sample.model !== runtimeModel &&
        sample.reason !== "model")
    )
      return;
    latestRuntimeAt = sample.observedAt;
    runtimeModel = sample.model;
    const { reason, ...fields } = sample;
    reading = {
      ...reading,
      ...fields,
      model: `${runtime}:${sample.model}`,
      reason:
        reason ??
        (sample.used === null && reading.reason === "compacted"
          ? "compacted"
          : null),
    };
    reading.reason = contextReason(reading);
  });
  on(
    "context:invalidated",
    ({ reason, at, compactedAt, model: nativeModel }) => {
      if (
        at < latestRuntimeAt ||
        (nativeModel && reading.model === `${runtime}:${nativeModel}`)
      )
        return;
      latestRuntimeAt = at;
      if (nativeModel) runtimeModel = nativeModel;
      reset(reason, at);
      if (nativeModel) reading.model = `${runtime}:${nativeModel}`;
      if (compactedAt !== undefined) reading.compactedAt = compactedAt;
    },
  );
  on("compaction:start", () => reset("compacted"));
  on("compaction:end", ({ status, endedAt }) => {
    if (status !== "completed") return;
    reset("compacted", endedAt);
    reading.compactedAt = endedAt;
  });
  if (source === "harness") {
    on("message:end", ({ message, runId }) => {
      // A retained completion on the old model must not seed the new model's estimate.
      if (reading.reason === "model" || reading.reason === "compacted") {
        if (
          message.role !== "assistant" ||
          message.model !== session.config.model.modelId ||
          message.provider !== session.config.model.provider ||
          runId !== active
        )
          return;
      }
      estimate();
    });
  }
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
}
