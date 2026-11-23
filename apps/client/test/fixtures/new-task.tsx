import { mount, signal, Text, View } from "nsh";
import { NewTask } from "../../src/pages/tasks/new-task";
import { createHost, Host } from "../../src/services/host";

// The New task dialog over a host with two agents. What it creates is listed under "Calls:".
function Fixture() {
  const host = createHost();
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      agents: {
        version: 1,
        revisions: {},
        sections: {
          list: [
            { id: "ada", name: "Ada" },
            { id: "lin", name: "Lin" },
          ],
        },
      },
    },
  }));
  const calls = signal<string[]>([]);
  host.call = async <T,>(target: string, action: string, args?: unknown) => {
    calls.update((log) => [
      ...log,
      `${target}.${action} ${JSON.stringify(args)}`,
    ]);
    return undefined as T;
  };
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Calls: ${calls().join(", ")}`}</Text>
        <NewTask phone={false} onOpen={() => {}} onClose={() => {}} />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
