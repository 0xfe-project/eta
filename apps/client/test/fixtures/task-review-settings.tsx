import type { TaskBoardSettings } from "@eta/client-contracts";
import { mount, signal, Text, View } from "nsh";
import { Button } from "../../src/components";
import { TaskSettings } from "../../src/pages/settings/tasks";
import { createHost, Host } from "../../src/services/host";

// Settings > Tasks fixture: tracks every `tasks.setSettings` call and mirrors the host state.
const kept: TaskBoardSettings = {
  archiveAfterDays: 7,
  autoAnswerAsks: false,
  reactToResults: false,
  reviewMaxRounds: 3,
  draftTimeout: { enabled: false, minutes: 10, action: "discard" },
};

function Fixture() {
  const host = createHost();
  const sent = signal<string[]>([]);
  const mode = signal("current");
  const publish = (settings: TaskBoardSettings) =>
    host.state.update((state) => ({
      ...state,
      status: "open",
      ops: ["tasks.setSettings"],
      targets: {
        ...state.targets,
        tasks: { version: 1, revisions: {}, sections: { settings } },
      },
    }));
  publish(kept);
  host.call = (async (target: string, action: string, args: unknown) => {
    sent.set([...sent(), `${target}.${action} ${JSON.stringify(args)}`]);
    const body = args as Partial<TaskBoardSettings>;
    const next: TaskBoardSettings = {
      ...kept,
      ...body,
      draftTimeout: { ...kept.draftTimeout!, ...(body.draftTimeout ?? {}) },
    };
    Object.assign(kept, next);
    publish({ ...next });
    return { settings: next };
  }) as typeof host.call;
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Sent: ${sent().join(" | ")}`}</Text>
        <Text>{`Mode: ${mode()}`}</Text>
        <Button
          label="Simulate legacy host"
          onPress={() => {
            const { reviewMaxRounds: _, ...legacy } = kept;
            mode.set("legacy");
            publish(legacy);
          }}
        />
        <TaskSettings />
      </View>
    </Host.Provider>
  );
}

mount(Fixture);
