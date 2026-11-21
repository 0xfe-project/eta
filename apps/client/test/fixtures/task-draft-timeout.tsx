import type { TaskBoardSettings } from "@eta/client-contracts";
import { mount, signal, Text, View } from "nsh";
import { ArchiveSettings } from "../../src/pages/settings/archive";
import { createHost, Host } from "../../src/services/host";

// The Archived tab of Settings against a host that keeps what it is sent, as the real one does: every
// change is listed under "Sent:" and shows on the controls once the host has it.
const kept: TaskBoardSettings = {
  archiveAfterDays: 7,
  draftTimeout: { enabled: false, minutes: 10, action: "discard" },
};

function Fixture() {
  const host = createHost();
  const sent = signal<string[]>([]);
  host.state.update((state) => ({
    ...state,
    status: "open",
    ops: ["tasks.setSettings"],
    targets: {
      ...state.targets,
      tasks: { version: 1, revisions: {}, sections: { settings: kept } },
    },
  }));
  host.call = (async (target: string, action: string, args: unknown) => {
    sent.set([...sent(), `${target}.${action} ${JSON.stringify(args)}`]);
    const change = (args as { draftTimeout?: object }).draftTimeout ?? {};
    const next: TaskBoardSettings = {
      ...kept,
      draftTimeout: { ...kept.draftTimeout!, ...change },
    };
    Object.assign(kept, next);
    host.state.update((state) => ({
      ...state,
      targets: {
        ...state.targets,
        tasks: {
          version: 1,
          revisions: {},
          sections: { settings: { ...next } },
        },
      },
    }));
    return { settings: next };
  }) as typeof host.call;
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Sent: ${sent().join(" | ")}`}</Text>
        <ArchiveSettings />
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
