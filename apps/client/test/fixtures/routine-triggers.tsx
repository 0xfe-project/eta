import type {
  CaptainOperationView,
  RoutineInfo,
  RoutineSummary,
  RunView,
  TriggerCatalogItem,
  TriggerProviderStatus,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, signal, Text, View, windowSize } from "nsh";
import { Button, colors, Screen, SmoothScroll } from "../../src/components";
import { Proposal } from "../../src/pages/chat/approvals";
import { Routines } from "../../src/pages/routines/routines";
import { createHost, Host } from "../../src/services/host";

const now = Date.now();

type CatalogScenario =
  | "ready"
  | "needs_key"
  | "key_rejected"
  | "disabled"
  | "error"
  | "empty"
  | "partial_empty";

const catalogItems: TriggerCatalogItem[] = [
  {
    provider: "composio",
    source: "github",
    sourceName: "GitHub",
    trigger: "GITHUB_COMMIT_EVENT",
    name: "Commit Pushed",
    description: "Fires when commits are pushed to a repository.",
    instructions: "Select the target repository owner and name.",
    modes: ["webhook", "poll"],
    requiresWebhookSetup: true,
    configSchema: {
      type: "object",
      required: ["owner", "repo"],
      properties: {
        owner: { type: "string", title: "Owner" },
        repo: { type: "string", title: "Repository" },
        max_commits: {
          type: "integer",
          title: "Max commits",
          minimum: 1,
          default: 10,
        },
        branch_mode: {
          type: "string",
          title: "Branch scope",
          enum: ["all", "default"],
          default: "all",
        },
        include_bots: {
          type: "boolean",
          title: "Include bot commits",
          default: true,
        },
        legacy_secret: {
          type: "string",
          title: "Legacy secret",
          deprecated: true,
        },
      },
    },
    payloadSchema: {},
    accounts: [
      { id: "ca_work", label: "Work GitHub" },
      { id: "ca_personal", label: "Personal GitHub" },
    ],
  },
  {
    provider: "composio",
    source: "github",
    sourceName: "GitHub",
    trigger: "GITHUB_RELEASE_EVENT",
    name: "Release Published",
    description: "Fires when a release is published.",
    modes: ["poll"],
    configSchema: {},
    payloadSchema: {},
    accounts: [{ id: "ca_work", label: "Work GitHub" }],
  },
  {
    provider: "webhook",
    source: "linear",
    sourceName: "Linear",
    trigger: "ISSUE_CREATED",
    name: "Issue Created",
    description: "Fires when a new Linear issue is opened.",
    modes: ["webhook"],
    configSchema: {
      type: "object",
      required: ["team"],
      properties: {
        team: { type: "string", title: "Team key" },
      },
    },
    payloadSchema: {},
    accounts: [{ id: "lin_1", label: "Linear Workspace" }],
  },
];

const eventRoutineRuns: RunView[] = [
  {
    id: "run-trigger-1",
    routineId: "r-event",
    startedBy: "trigger",
    status: "sent",
    startedAt: now - 30 * 60_000,
    finishedAt: now - 29 * 60_000,
    title: "3 new commits on main",
    sessionId: null,
    report: "Reviewed 3 commits pushed by @ada.",
    error: null,
    seenAt: now - 20 * 60_000,
    feedback: [],
  },
  {
    id: "run-user-1",
    routineId: "r-event",
    startedBy: "user",
    status: "sent",
    startedAt: now - 3 * 3_600_000,
    finishedAt: now - 3 * 3_600_000 + 20_000,
    title: "Manual repository check",
    sessionId: null,
    report: "Manual check completed with no issues.",
    error: null,
    seenAt: now - 2 * 3_600_000,
    feedback: [],
  },
  {
    id: "run-schedule-1",
    routineId: "r-event",
    startedBy: "schedule",
    status: "failed",
    startedAt: now - 24 * 3_600_000,
    finishedAt: now - 24 * 3_600_000 + 5_000,
    title: null,
    sessionId: null,
    report: null,
    error: "Upstream API timed out",
    seenAt: null,
    feedback: [],
  },
];

const initialRoutines: RoutineSummary[] = [
  {
    id: "r-event",
    name: "Commit Watcher",
    schedule: null,
    trigger: {
      provider: "composio",
      source: "github",
      trigger: "GITHUB_COMMIT_EVENT",
      accountId: "ca_work",
      config: {
        owner: "eta-dev",
        repo: "eta",
        max_commits: 5,
        branch_mode: "default",
        include_bots: false,
      },
      instanceId: "ti_commit_1",
      mode: "webhook",
      pollingIntervalMinutes: null,
      fallbackReason: null,
      status: "active",
      lastError: null,
      lastEventAt: now - 10 * 60_000,
    },
    timezone: "UTC",
    enabled: true,
    nextRunAt: null,
    revising: false,
    unseenReports: 0,
    unseenFailures: 0,
    createdAt: now - 86_400_000,
    updatedAt: now,
    runs: eventRoutineRuns.map(
      ({ report: _r, error: _e, seenAt: _s, feedback: _f, ...listing }) =>
        listing,
    ),
  },
  {
    id: "r-both",
    name: "Issue Digest",
    schedule: { kind: "daily", time: "09:00" },
    trigger: {
      provider: "composio",
      source: "github",
      trigger: "GITHUB_RELEASE_EVENT",
      accountId: "ca_work",
      config: {},
      instanceId: "ti_release_1",
      mode: "poll",
      pollingIntervalMinutes: 5,
      fallbackReason: "Webhook unsupported, fell back to polling",
      status: "active",
      lastError: null,
      lastEventAt: null,
    },
    timezone: "UTC",
    enabled: true,
    nextRunAt: now + 2 * 3_600_000,
    revising: false,
    unseenReports: 0,
    unseenFailures: 0,
    createdAt: now - 86_400_000,
    updatedAt: now,
    runs: [],
  },
  {
    id: "r-error",
    name: "Broken Hook",
    schedule: null,
    trigger: {
      provider: "webhook",
      source: "linear",
      trigger: "ISSUE_CREATED",
      accountId: "lin_1",
      config: { team: "ENG" },
      instanceId: null,
      mode: "webhook",
      pollingIntervalMinutes: null,
      fallbackReason: null,
      status: "error",
      lastError: "Webhook registration failed (403)",
      lastEventAt: null,
    },
    timezone: "UTC",
    enabled: true,
    nextRunAt: null,
    revising: false,
    unseenReports: 0,
    unseenFailures: 0,
    createdAt: now - 86_400_000,
    updatedAt: now,
    runs: [],
  },
];

const routineProposals: CaptainOperationView[] = [
  {
    id: "op-schedule",
    kind: "create_routine",
    actorAgentId: "captain",
    requiresApproval: true,
    status: "pending",
    payload: {
      originConversationId: "c1",
      messageId: "m1",
      name: "Morning Brief",
      brief: "Summarize overnight updates.",
      schedule: { kind: "daily", time: "09:00" },
      trigger: null,
      timezone: "UTC",
      scheduleText: "every day at 09:00",
    },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "op-trigger",
    kind: "create_routine",
    actorAgentId: "captain",
    requiresApproval: true,
    status: "pending",
    payload: {
      originConversationId: "c1",
      messageId: "m2",
      name: "PR Watcher",
      brief: "Review incoming commits.",
      schedule: null,
      trigger: {
        provider: "composio",
        source: "github",
        trigger: "GITHUB_COMMIT_EVENT",
        mode: "webhook",
        config: { owner: "eta-dev", repo: "eta" },
      },
      timezone: "Asia/Shanghai",
      scheduleText: "on composio/github: GITHUB_COMMIT_EVENT",
    },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  },
  {
    id: "op-both",
    kind: "create_routine",
    actorAgentId: "captain",
    requiresApproval: true,
    status: "pending",
    payload: {
      originConversationId: "c1",
      messageId: "m3",
      name: "Release Sweep",
      brief: "Watch releases with daily fallback.",
      schedule: { kind: "daily", time: "20:00" },
      trigger: {
        provider: "composio",
        source: "github",
        trigger: "GITHUB_RELEASE_EVENT",
        mode: "poll",
        pollingIntervalMinutes: 15,
      },
      timezone: "UTC",
      scheduleText:
        "every day at 20:00 + composio/github: GITHUB_RELEASE_EVENT",
    },
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  },
];

function Fixture() {
  const host = createHost();
  const layout = (): Layout => {
    const width = windowSize().width;
    if (width < 600) return "phone";
    if (width < 960) return "tablet";
    return "desktop";
  };
  const scenario = signal<CatalogScenario>("ready");
  const viewMode = signal<"routines" | "proposals">("routines");
  const hideControls = signal(false);
  const lastCreate = signal("");
  const lastUpdate = signal("");
  const lastTriggersCall = signal("");
  const navLog = signal<string[]>([]);

  const target = <T,>(sections: T) => ({ sections, revisions: {}, version: 0 });
  const setRoutines = (items: RoutineSummary[]) => {
    host.state.update((state) => ({
      ...state,
      targets: {
        ...state.targets,
        routines: target({
          list: items,
          status: { captainOn: true, reason: null },
        }),
        ...Object.fromEntries(
          items.map((item) => [
            `routines.${item.id}`,
            target({
              info: item as RoutineInfo,
              briefs: [
                {
                  version: 1,
                  text: "Inspect events and summarize.",
                  createdAt: now,
                  feedback: null,
                },
              ],
              runs: item.id === "r-event" ? eventRoutineRuns : [],
            }),
          ]),
        ),
      },
    }));
  };

  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: [
      "routines.create",
      "routines.update",
      "routines.delete",
      "routines.run",
      "routines.triggers",
      "captain.decideOperation",
    ],
    targets: {
      ...state.targets,
      agents: target({ list: [] }),
    },
  }));
  setRoutines(initialRoutines);

  host.call = (async (targetName: string, action: string, args: unknown) => {
    if (targetName === "routines" && action === "triggers") {
      lastTriggersCall.set(JSON.stringify(args ?? {}));
      const mode = scenario();
      const providers: Record<CatalogScenario, TriggerProviderStatus[]> = {
        ready: [
          { provider: "composio", status: "ready" },
          { provider: "webhook", status: "ready" },
        ],
        needs_key: [{ provider: "composio", status: "needs_key" }],
        key_rejected: [
          {
            provider: "composio",
            status: "key_rejected",
            error: "Invalid Composio API key",
          },
        ],
        disabled: [{ provider: "composio", status: "disabled" }],
        error: [
          {
            provider: "webhook",
            status: "error",
            error: "Trigger service unreachable",
          },
        ],
        empty: [{ provider: "composio", status: "ready" }],
        partial_empty: [
          { provider: "composio", status: "ready" },
          { provider: "webhook", status: "ready" },
        ],
      };
      return {
        triggers:
          mode === "ready"
            ? catalogItems
            : mode === "partial_empty"
              ? catalogItems.filter((item) => item.provider === "webhook")
              : [],
        providers: providers[mode],
      };
    }
    if (targetName === "routines" && action === "create") {
      lastCreate.set(JSON.stringify(args ?? {}));
      const input = args as {
        name: string;
        schedule: RoutineInfo["schedule"];
        trigger?: RoutineInfo["trigger"];
        timezone: string;
      };
      const created: RoutineSummary = {
        id: "r-created",
        name: input.name,
        schedule: input.schedule,
        trigger: input.trigger
          ? {
              ...input.trigger,
              accountId: input.trigger.accountId ?? null,
              config: input.trigger.config ?? {},
              instanceId: "ti_new",
              mode: input.trigger.mode ?? null,
              pollingIntervalMinutes:
                input.trigger.pollingIntervalMinutes ?? null,
              fallbackReason: null,
              status: "active",
              lastError: null,
              lastEventAt: null,
            }
          : null,
        timezone: input.timezone,
        enabled: true,
        nextRunAt: input.schedule ? now + 3_600_000 : null,
        revising: false,
        unseenReports: 0,
        unseenFailures: 0,
        createdAt: now,
        updatedAt: now,
        runs: [],
      };
      const list = host.list<RoutineSummary>("routines");
      setRoutines([created, ...list]);
      return { routine: created };
    }
    if (targetName === "routines" && action === "update") {
      lastUpdate.set(JSON.stringify(args ?? {}));
      const input = args as {
        routineId: string;
        name?: string;
        schedule?: RoutineInfo["schedule"];
        trigger?: RoutineInfo["trigger"];
        timezone?: string;
      };
      const list = host.list<RoutineSummary>("routines");
      const next = list.map((item) => {
        if (item.id !== input.routineId) return item;
        return {
          ...item,
          name: input.name ?? item.name,
          schedule:
            input.schedule !== undefined ? input.schedule : item.schedule,
          nextRunAt:
            (input.schedule !== undefined ? input.schedule : item.schedule) !==
            null
              ? now + 3_600_000
              : null,
          trigger:
            input.trigger === undefined
              ? item.trigger
              : input.trigger === null
                ? null
                : {
                    ...input.trigger,
                    accountId: input.trigger.accountId ?? null,
                    config: input.trigger.config ?? {},
                    instanceId: item.trigger?.instanceId ?? "ti_upd",
                    mode: input.trigger.mode ?? null,
                    pollingIntervalMinutes:
                      input.trigger.pollingIntervalMinutes ?? null,
                    fallbackReason: null,
                    status: "active" as const,
                    lastError: null,
                    lastEventAt: item.trigger?.lastEventAt ?? null,
                  },
          timezone: input.timezone ?? item.timezone,
        };
      });
      setRoutines(next);
      return {
        routine: next.find((item) => item.id === input.routineId)!,
      };
    }
    return {};
  }) as typeof host.call;

  return (
    <Host.Provider value={host}>
      <Screen.Provider value={layout}>
        <View style={{ flex: 1, backgroundColor: colors()().canvas }}>
          <If when={!hideControls()}>
            <View
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: 4,
                padding: 4,
              }}
            >
              <Button
                label="View: routines"
                onPress={() => viewMode.set("routines")}
              />
              <Button
                label="View: proposals"
                onPress={() => viewMode.set("proposals")}
              />
              <Button
                label="Scenario: ready"
                onPress={() => scenario.set("ready")}
              />
              <Button
                label="Scenario: needs_key"
                onPress={() => scenario.set("needs_key")}
              />
              <Button
                label="Scenario: key_rejected"
                onPress={() => scenario.set("key_rejected")}
              />
              <Button
                label="Scenario: disabled"
                onPress={() => scenario.set("disabled")}
              />
              <Button
                label="Scenario: error"
                onPress={() => scenario.set("error")}
              />
              <Button
                label="Scenario: empty"
                onPress={() => scenario.set("empty")}
              />
              <Button
                label="Scenario: partial_empty"
                onPress={() => scenario.set("partial_empty")}
              />
              <Button
                label="Hide controls"
                onPress={() => hideControls.set(true)}
              />
              <Text>{`Create:${lastCreate()}`}</Text>
              <Text>{`Update:${lastUpdate()}`}</Text>
              <Text>{`Triggers:${lastTriggersCall()}`}</Text>
              <Text>{`Nav:${navLog().join(",")}`}</Text>
            </View>
          </If>
          <If
            when={viewMode() === "routines"}
            else={
              <SmoothScroll style={{ flex: 1 }}>
                <View style={{ padding: 16, gap: 16 }}>
                  <Each of={routineProposals} key={(op) => op.id}>
                    {(op) => <Proposal operation={op()} />}
                  </Each>
                  <View
                    style={{ borderTopWidth: 1, paddingTop: 12, height: 360 }}
                  >
                    <Proposal operation={routineProposals[1]!} sheet />
                  </View>
                </View>
              </SmoothScroll>
            }
          >
            <Routines
              layout={layout()}
              onCaptain={() => {}}
              onPlugins={() => navLog.set([...navLog(), "plugins"])}
              onPluginSettings={() =>
                navLog.set([...navLog(), "plugin-settings"])
              }
            />
          </If>
        </View>
      </Screen.Provider>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
