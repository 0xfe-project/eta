/** One Host observation on a member session. Spend is accounted for separately. */
export interface ContextReading {
  session: string;
  model: string;
  runId?: string | null;
  observation?: "live" | "last-observed";
  source: "oar" | "codex-last" | "acp" | "harness";
  observedAt: number;
  compactedAt: number | null;
  used: number | null;
  window: number | null;
  reason: ContextReason | null;
}

const reasons = {
  unverified: [
    "Context reading has no reliable source",
    "上下文读数缺少可靠来源",
  ],
  missing: ["No context reading reported", "尚未上报上下文读数"],
  codexLast: [
    "No reliable last-call reading and window",
    "缺少可靠的最近调用读数或窗口",
  ],
  window: ["No valid context window", "缺少有效的上下文窗口"],
  inconsistent: ["Context reading is out of range", "上下文读数超出有效范围"],
  compacted: ["Awaiting a reading after compaction", "等待压缩后的新读数"],
  model: ["Awaiting a reading for the new model", "等待新模型的读数"],
  nativeSession: [
    "Awaiting a reading for the new runtime session",
    "等待新原生会话的读数",
  ],
} as const;

type ContextReason = keyof typeof reasons;

export function contextReason(reading: ContextReading): ContextReason | null {
  if (reading.reason)
    return Object.hasOwn(reasons, reading.reason)
      ? reading.reason
      : "unverified";
  if (
    !reading.session ||
    !reading.model ||
    !Number.isFinite(reading.observedAt) ||
    !Number.isFinite(new Date(reading.observedAt).getTime()) ||
    (reading.observation !== undefined &&
      reading.observation !== "live" &&
      reading.observation !== "last-observed") ||
    !["acp", "oar", "codex-last", "harness"].includes(reading.source) ||
    ((reading.observation === "live" ||
      (reading.observation === undefined && reading.source !== "harness")) &&
      !reading.runId)
  )
    return "unverified";
  const { used, window } = reading;
  if (reading.source === "codex-last" && (used === null || window === null))
    return "codexLast";
  if (used === null) return "missing";
  if (window === null || !Number.isSafeInteger(window) || window <= 0)
    return "window";
  if (!Number.isSafeInteger(used) || used < 0 || used > window)
    return "inconsistent";
  return null;
}

/** All member views use the same text and unrounded fill, including for an older Host. */
export function displayContext(
  reading: ContextReading | undefined,
  session: string | null | undefined,
  locale: string,
) {
  const current = reading?.session === session ? reading : undefined;
  const reason = current ? contextReason(current) : "missing";
  const zh = locale.startsWith("zh");
  if (!current || reason !== null)
    return {
      label: "N/A",
      detail: `N/A · ${reasons[reason ?? "missing"][zh ? 1 : 0]}`,
      fraction: 0,
    };
  const used = current.used!;
  const window = current.window!;
  const fraction = used / window;
  const approx = current.source === "harness" ? (zh ? "约 " : "≈") : "";
  const percent = `${approx}${Math.round(fraction * 100)}%`;
  const last =
    current.observation === "last-observed"
      ? zh
        ? "上次查询"
        : "Last checked"
      : undefined;
  const label = last === undefined ? percent : `${percent} · ${last}`;
  const checkedAt =
    last === undefined
      ? ""
      : ` · ${last} ${new Date(current.observedAt).toLocaleString(zh ? "zh-CN" : "en-US")}`;
  return {
    label,
    detail: `${percent} · ${used.toLocaleString("en-US")} / ${window.toLocaleString("en-US")} tokens${checkedAt}`,
    fraction,
  };
}

export interface ReportedTokens {
  value: number;
  coverage: "complete" | "partial";
}

export type MemberSpend = Record<
  "input" | "output" | "cache",
  ReportedTokens | null
>;

/**
 * How fast a member's model writes: output tokens per second of one generation, timed from its
 * first output. `estimate` is counted from the text so far, `measured` from the output the
 * provider reported once the generation ended.
 */
export interface GenerationRate {
  tokensPerSec: number;
  basis: "estimate" | "measured";
}

export function displaySpend(
  field: ReportedTokens | null | undefined,
  locale: string,
) {
  if (!field) return "—";
  const count = field.value;
  const value =
    count >= 1_000_000
      ? `${(count / 1_000_000).toFixed(1)}M`
      : count >= 1000
        ? `${(count / 1000).toFixed(1)}k`
        : String(count);
  return field.coverage === "complete"
    ? value
    : `${value} (${locale.startsWith("zh") ? "部分" : "partial"})`;
}
