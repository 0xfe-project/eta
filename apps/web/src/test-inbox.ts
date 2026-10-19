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
import { conversationSections } from "@/test-product";
import { FakeHost } from "@/test-wire";

export const interactionView = (
  fields: Partial<InteractionView> & { id: string },
): InteractionView => ({
  sessionId: `s-${fields.id}`,
  questionId: fields.id,
  agentId: "a1",
  conversationId: "g1",
  replyId: null,
  prompt: "tasks 请求确认\n删除分支？",
  options: ["允许", "拒绝"],
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
  /** The host runs with a memory sidecar. */
  memory?: boolean;
}

/**
 * A host with the product plugins and the inbox (always, it is eager) mounted, plus usage and
 * memory when seeded; installed as the page's connection and connected.
 */
export function surfaceHost(seed: SurfaceSeed = {}): FakeHost {
  const mounted = ["agents", "machines", "projects", "conversations", "inbox"];
  const host = new FakeHost()
    .target("agents", { list: seed.agents ?? [] }, { eager: true })
    .target("machines", { list: seed.machines ?? [] }, { eager: true })
    .target("projects", { list: seed.projects ?? [] }, { eager: true })
    .target(
      "conversations",
      { list: seed.conversations ?? [] },
      { eager: true },
    )
    .target(
      "inbox",
      {
        list: seed.interactions ?? [],
        approvals: { tools: seed.approvals ?? [] },
      },
      { eager: true },
    );
  if (seed.usage !== undefined) {
    mounted.push("usage");
    host.target("usage", { agents: seed.usage, models: [], days: [] });
  }
  if (seed.memory === true) mounted.push("memory");
  host.plugins(mounted.map((name) => ({ name, source: "bundled" as const })));
  for (const summary of seed.conversations ?? []) {
    host.target(
      `conversations.${summary.id}`,
      conversationSections(summary, seed.messages?.[summary.id]),
    );
  }
  host.install();
  host.hello();
  return host;
}
