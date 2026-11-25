import type {
  RoutineInfo,
  RoutineSummary,
  RunListing,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, signal, View, windowSize } from "nsh";
import { Screen } from "../../src/components";
import { Routines } from "../../src/pages/routines/routines";
import { createHost, Host } from "../../src/services/host";

// The Routines page on a Host that knows one routine, "Weekly digest", whose next run is minutes
// away: each row says how far off it is ("Next · in 5 minutes"). Under 600 wide it is the phone
// layout. Nothing here waits for a host: the page draws from the state it was given.

const now = Date.now();
const routine = (
  id: string,
  name: string,
  nextRunAt: number | null,
): RoutineSummary => ({
  id,
  name,
  schedule: { kind: "daily", time: "09:00" } as RoutineInfo["schedule"],
  timezone: "UTC",
  enabled: true,
  nextRunAt,
  revising: false,
  unseenReports: 0,
  unseenFailures: 0,
  createdAt: now - 86_400_000,
  updatedAt: now,
  runs: [] as RunListing[],
});

function Fixture() {
  const host = createHost();
  const layout = (): Layout => (windowSize().width < 600 ? "phone" : "desktop");
  const target = <T,>(sections: T) => ({ sections, revisions: {}, version: 0 });
  const items = [
    routine("digest", "Weekly digest", now + 5.5 * 60_000),
    routine("inbox", "Inbox sweep", now + 3.5 * 3_600_000),
  ];
  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: ["routines.update", "routines.run"],
    targets: {
      ...state.targets,
      agents: target({ list: [] }),
      routines: target({
        list: items,
        status: { captainOn: true, reason: null },
      }),
      ...Object.fromEntries(
        items.map((item) => [
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
            runs: [],
          }),
        ]),
      ),
    },
  }));
  return (
    <Host.Provider value={host}>
      <Screen.Provider value={layout}>
        <View style={{ flex: 1 }}>
          <Routines layout={layout()} onCaptain={() => {}} />
        </View>
      </Screen.Provider>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
