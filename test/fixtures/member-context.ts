import type {
  ContextReading,
  MemberSpend,
} from "../../packages/client-contracts/src/context-usage";

export const lastObservedAt = Date.UTC(2024, 5, 15, 12);

/** Wire replays shared by the three member views. */
export const memberReadings = {
  acp: { source: "acp", used: 64000 },
  codex: { source: "codex-last", used: 32000 },
  missing: { used: null, reason: "missing" },
  legacy: { source: "codex-last", used: 240000, window: null },
  noWindow: { window: 0 },
  compacted: { used: null, reason: "compacted", compactedAt: 2 },
  overflow: { used: 152081 },
  empty: { used: 0 },
  full: { used: 128000 },
  switched: { model: "next", used: null, reason: "model" },
  estimated: { source: "harness", used: 16000 },
  lastObserved: {
    observation: "last-observed",
    runId: null,
    used: 19_010,
    observedAt: lastObservedAt,
  },
} satisfies Record<string, Partial<ContextReading>>;

export type Replay = keyof typeof memberReadings;
export function memberSnapshot(session: string, scenario: Replay) {
  const context: ContextReading = {
    session,
    source: "oar",
    model: "m",
    runId: "r",
    observedAt: 1,
    compactedAt: null,
    used: 64000,
    window: 128000,
    reason: null,
    ...memberReadings[scenario],
  };
  const spend: MemberSpend =
    scenario === "codex"
      ? {
          input: { value: 240000, coverage: "complete" },
          output: { value: 0, coverage: "complete" },
          cache: { value: 1000, coverage: "partial" },
        }
      : { input: null, output: null, cache: null };
  return { context, spend };
}
