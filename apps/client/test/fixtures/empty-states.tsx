import type { BoardTaskView } from "@eta/client-contracts";
import { mount, signal, View } from "nsh";
import { Button } from "../../src/components";
import { Tasks } from "../../src/pages/tasks/tasks";
import { createHost, Host } from "../../src/services/host";

// The Tasks page while its list is on its way (#378), then as each button leaves it: the host has
// no task list for it (did not load), an empty list, or two tasks. Retry is counted, not sent.
const now = Date.now();
const task = (number: number, title: string) =>
  ({
    id: `t${number}`,
    number,
    title,
    status: "todo",
    createdBy: { kind: "agent", agentId: "ada" },
    assigneeAgentId: "ada",
    conversationId: "group",
    runStatus: null,
    comments: 0,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
  }) as unknown as BoardTaskView;

function Fixture() {
  const host = createHost();
  const retries = signal(0);
  host.retry = () => retries.set(retries() + 1);
  host.wake = () => retries.set(retries() + 1);
  host.state.update((state) => ({ ...state, status: "open" }));
  const list = (tasks: BoardTaskView[]) =>
    host.state.update((state) => ({
      ...state,
      missing: {},
      targets: {
        ...state.targets,
        tasks: { version: 1, revisions: {}, sections: { list: tasks } },
      },
    }));
  return (
    <Host.Provider value={host}>
      <View style={{ flexDirection: "row" }}>
        <Button
          label="Fail"
          onPress={() =>
            host.state.update((state) => ({
              ...state,
              missing: { ...state.missing, tasks: true },
            }))
          }
        />
        <Button label="Load none" onPress={() => list([])} />
        <Button
          label="Load two"
          onPress={() =>
            list([task(1, "Fix the footer"), task(2, "Write the notes")])
          }
        />
        <Button label={`Retries ${retries()}`} onPress={() => {}} />
      </View>
      <View style={{ flex: 1 }}>
        <Tasks layout="desktop" onOpen={() => {}} onCreate={() => {}} />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
