import { mount, signal, Storage, Text, View } from "nsh";
import { TemplateGallery } from "../../src/pages/templates/gallery";
import { createHost, Host } from "../../src/services/host";

// The template gallery over a host with one model, `source:model`. Storage `phone` opens the
// phone layout, `initial` the template a link named, `models` "0" takes the models away and
// `create` "fail" makes the host refuse. What the gallery asked the host is listed under "Sent:"
// (target.action and the arguments as JSON), and the agent it made under "Created:".
function Fixture(props: {
  phone: boolean;
  initial?: string;
  models: boolean;
  fail: boolean;
}) {
  const host = createHost();
  const sent = signal<string[]>([]);
  const created = signal("");
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      providers: {
        version: 1,
        revisions: {},
        sections: {
          config: {
            revision: "r1",
            providers: [
              {
                id: "source",
                kind: "deepseek",
                name: "Source",
                baseUrl: "https://api.deepseek.com",
                hasApiKey: true,
                models: props.models ? [{ id: "model" }] : [],
              },
            ],
          },
        },
      },
    },
  }));
  host.call = (async (target: string, action: string, args: unknown) => {
    sent.set([...sent(), `${target}.${action} ${JSON.stringify(args)}`]);
    if (action === "create") {
      if (props.fail) throw new Error("name taken");
      return { agent: { id: "new-agent" } };
    }
    return {};
  }) as typeof host.call;
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Sent: ${sent().join(" | ")}`}</Text>
        <Text>{`Created: ${created()}`}</Text>
        <TemplateGallery
          phone={props.phone}
          initialId={props.initial}
          onClose={noop}
          onCreated={(id) => created.set(id)}
          onModelServices={noop}
        />
      </View>
    </Host.Provider>
  );
}

void Promise.all([
  Storage.getItem("phone"),
  Storage.getItem("initial"),
  Storage.getItem("models"),
  Storage.getItem("create"),
]).then(([phone, initial, models, create]) =>
  mount(() => (
    <Fixture
      phone={phone === "1"}
      initial={initial || undefined}
      models={models !== "0"}
      fail={create === "fail"}
    />
  )),
);
