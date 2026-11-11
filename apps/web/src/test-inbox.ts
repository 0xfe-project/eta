// The inbox, usage and memory targets for component tests: fixtures for what the host publishes
// and a fake host with the product's four plugins plus these mounted. Tests add the calls they
// expect with `host.handle("inbox.answer", ...)`.

import type {
  AgentUsage,
  InteractionView,
  UsageTotals,
  UsageWindow,
} from "@eta/client-contracts";
import type { ProductSeed } from "@/test-product";
import type { FakeHost } from "@/test-wire";
import { buildProductHost } from "@/test-product";

export const interactionView = (
  fields: Partial<InteractionView> & { id: string },
): InteractionView => ({
  sessionId: `s-${fields.id}`,
  questionId: fields.id,
  agentId: "a1",
  conversationId: "g1",
  replyId: null,
  prompt: "tasks request confirmation\nDelete branch?",
  options: ["Allow", "Deny"],
  multi: false,
  status: "pending",
  answer: null,
  revision: 1,
  createdAt: 1000,
  updatedAt: 1000,
  ...fields,
});

export const totals = (
  total: number,
  requests = 1,
  fields: Partial<UsageTotals> = {},
): UsageTotals => ({
  requests,
  failed: 0,
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  total,
  cost: 0,
  ...fields,
});

export const agentUsage = (
  agentId: string | null,
  windows: Partial<Record<UsageWindow, UsageTotals>>,
): AgentUsage => ({
  agentId,
  windows: {
    "5h": totals(0, 0),
    "24h": totals(0, 0),
    "7d": totals(0, 0),
    "30d": totals(0, 0),
    ...windows,
  },
  models: [],
});

export interface SurfaceSeed extends ProductSeed {
  interactions?: InteractionView[];
  approvals?: string[];
  /** Left out, the host has no usage plugin. */
  usage?: AgentUsage[];
}

/**
 * A host with the product plugins and the inbox (always, it is eager) mounted, plus usage when
 * seeded; installed as the page's connection and connected.
 */
export function surfaceHost(seed: SurfaceSeed = {}): FakeHost {
  const mounted = ["inbox"];
  if (seed.usage !== undefined) mounted.push("usage");
  const host = buildProductHost(seed, mounted).target(
    "inbox",
    {
      list: seed.interactions ?? [],
      approvals: { tools: seed.approvals ?? [] },
    },
    { eager: true },
  );
  if (seed.usage !== undefined)
    host.target("usage", { agents: seed.usage, models: [], days: [] });
  host.install();
  host.hello();
  return host;
}
