import type {
  RoutineInfo,
  RoutineSummary,
  RunListing,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, signal, Text, View, windowSize } from "nsh";
import { Button, Screen } from "../../src/components";
import { Routines } from "../../src/pages/routines/routines";
import { createHost, Host } from "../../src/services/host";

// The Routines page, opened on "Weekly digest", on a Host that answers `routines.delete` as the
// real one does: the routine leaves the list and its target goes. "Delete elsewhere" is another
// window or device deleting it, "Read-only" a connection without `routines.delete`. Under 600
// wide it is the phone layout. "Calls" lists the routines.delete calls made.

const now = Date.now();
const routine = (
  id: string,
  name: string,
  running = false,
): RoutineSummary => ({
  id,
  name,
  schedule: { kind: "daily", time: "09:00" } as RoutineInfo["schedule"],
  timezone: "UTC",
  enabled: true,
  // No next time: its distance needs Intl.RelativeTimeFormat, which the NSH runtime lacks.
  nextRunAt: null,
  revising: false,
  unseenReports: 0,
  unseenFailures: 0,
  createdAt: now - 86_400_000,
  updatedAt: now,
  runs: running
    ? [
        {
          id: `${id}-run`,
          routineId: id,
          startedBy: "user",
          status: "running",
          startedAt: now,
          finishedAt: null,
          title: null,
          sessionId: null,
        } satisfies RunListing,
      ]
    : [],
});

function Fixture() {
  const host = createHost();
  const layout = (): Layout => (windowSize().width < 600 ? "phone" : "desktop");
  const calls = signal<string[]>([]);
  const target = <T,>(sections: T) => ({ sections, revisions: {}, version: 0 });
  const items = [
    routine("digest", "Weekly digest"),
    routine("inbox", "Inbox sweep"),
  ];
  const set = (next: RoutineSummary[]) =>
    host.state.update((state) => {
      const targets = { ...state.targets };
      for (const key of Object.keys(targets))
        if (
          key.startsWith("routines.") &&
          !next.some((item) => `routines.${item.id}` === key)
        )
          delete targets[key];
      return {
        ...state,
        targets: {
          ...targets,
          routines: target({
            list: next,
            status: { captainOn: true, reason: null },
          }),
          ...Object.fromEntries(
            next.map((item) => [
              `routines.${item.id}`,
              target({
                info: item,
                briefs: [
                  {
                    version: 1,
                    text: "Sum up the week.",
                    createdAt: now,
                    feedback: null,
                  },
                ],
                runs: item.runs.map((run) => ({
                  ...run,
                  report: null,
                  error: null,
                  seenAt: null,
                  feedback: [],
                })),
              }),
            ]),
          ),
        },
      };
    });
  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: ["routines.update", "routines.run", "routines.delete"],
    targets: { ...state.targets, agents: target({ list: [] }) },
  }));
  set(items);
  const list = () => host.list<RoutineSummary>("routines");
  const remove = (id: string) => set(list().filter((item) => item.id !== id));
  host.call = (async (
    name: string,
    action: string,
    args: { routineId: string },
  ) => {
    if (name !== "routines") return {};
    if (action === "delete") {
      calls.set([...calls(), args.routineId]);
      remove(args.routineId);
      return { routineId: args.routineId };
    }
    return {};
  }) as typeof host.call;
  const readOnly = () =>
    host.state.update((state) => ({
      ...state,
      ops: state.ops.filter((op) => op !== "routines.delete"),
    }));
  return (
    <Host.Provider value={host}>
      <Screen.Provider value={layout}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", gap: 8, padding: 4 }}>
            <Button label="Delete elsewhere" onPress={() => remove("digest")} />
            <Button label="Read-only" onPress={readOnly} />
            <Text>{`Calls: ${calls().join(",") || "none"}`}</Text>
          </View>
          <Routines layout={layout()} initialId="digest" onCaptain={() => {}} />
        </View>
      </Screen.Provider>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
