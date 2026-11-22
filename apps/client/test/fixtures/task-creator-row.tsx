import { mount, View } from "nsh";
import { ActorName } from "../../src/pages/tasks/creator";
import { createHost, Host } from "../../src/services/host";

// The task page's creator row for each kind of maker: the user, a known agent, a deleted one.
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
        sections: { list: [{ id: "ada", name: "Ada" }] },
      },
    },
  }));
  return (
    <Host.Provider value={host}>
      <View style={{ width: 280, gap: 8 }}>
        <ActorName actor={{ kind: "user", agentId: null }} size={16} />
        <ActorName actor={{ kind: "agent", agentId: "ada" }} size={16} />
        <ActorName actor={{ kind: "agent", agentId: "gone" }} size={16} />
      </View>
    </Host.Provider>
  );
}

mount(() => <Fixture />);
