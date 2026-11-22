import type { AgentView } from "@eta/client-contracts";
import { mount, signal, Storage, Text, View } from "nsh";
import { AgentEditor } from "../../src/pages/settings/agents/editor";
import { createHost, Host } from "../../src/services/host";

// The agent editor over one agent, Ada (id `a1`). Storage `seeds` is the faces she wore, newest
// first, comma-separated (none: she never drew one and wears her id); storage `save` is how the
// host answers a save: `ok` (it keeps the face as the host's store does: at the front, once, the
// last 8), `fail`, or `hold` (it never answers). Storage `phone` opens the phone editor. Drawn seeds are `face0001`, `face0002`,
// ... in order, each listed under "Drawn:" with the milliseconds since the first; what the editor
// asked the host is listed under "Sent:", the faces the host keeps under "Kept:".
const drawn = signal<string[]>([]);
let first = 0;
crypto.randomUUID = (() => {
  const seed = `face${String(drawn().length + 1).padStart(4, "0")}`;
  if (drawn().length === 0) first = Date.now();
  drawn.set([...drawn(), `${seed}+${Date.now() - first}`]);
  return `${seed}-0000-4000-8000-000000000000`;
}) as typeof crypto.randomUUID;

function agentWith(seeds: string[]): AgentView {
  return {
    id: "a1",
    name: "Ada",
    instructions: "",
    persona: "",
    runtime: "eta",
    model: null,
    thinkingLevel: null,
    machineId: null,
    plugins: [],
    skippedPlugins: [],
    systemRole: null,
    avatarSeed: seeds[0] ?? null,
    avatarSeeds: seeds,
  } as unknown as AgentView;
}

function Fixture(props: { seeds: string[]; save: string; phone: boolean }) {
  const host = createHost();
  const sent = signal<string[]>([]);
  const agent = signal(agentWith(props.seeds));
  const put = (next: AgentView) => {
    agent.set(next);
    host.state.update((state) => ({
      ...state,
      status: "open",
      targets: {
        ...state.targets,
        agents: { version: 1, revisions: {}, sections: { list: [next] } },
      },
    }));
  };
  put(agent());
  host.call = (async (target: string, action: string, args: unknown) => {
    const { avatarSeed } = args as { avatarSeed?: string };
    sent.set([...sent(), `${target}.${action} ${avatarSeed ?? ""}`]);
    if (target !== "agents" || action !== "update") return undefined;
    if (props.save === "fail") throw new Error("disk full");
    if (props.save === "hold") return new Promise(() => {});
    const current = agent();
    const worn = current.avatarSeeds.length ? current.avatarSeeds : ["a1"];
    put({
      ...current,
      avatarSeed: avatarSeed!,
      avatarSeeds: [avatarSeed!, ...worn.filter((s) => s !== avatarSeed)].slice(
        0,
        8,
      ),
    });
    return { agent: agent() };
  }) as typeof host.call;
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Sent: ${sent().join(", ")}`}</Text>
        <Text>{`Kept: ${agent().avatarSeeds.join(" ")}`}</Text>
        <Text>{`Drawn: ${drawn().join(" ")}`}</Text>
        <AgentEditor
          id="a1"
          phone={props.phone}
          onClose={noop}
          onModelServices={noop}
        />
      </View>
    </Host.Provider>
  );
}

void Promise.all([
  Storage.getItem("seeds"),
  Storage.getItem("save"),
  Storage.getItem("phone"),
]).then(([seeds, save, phone]) =>
  mount(() => (
    <Fixture
      seeds={seeds ? seeds.split(",") : []}
      save={save ?? "ok"}
      phone={phone === "1"}
    />
  )),
);
