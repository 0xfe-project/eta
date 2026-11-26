import { mount, signal, Storage, Text, View } from "nsh";
import { NotificationHost } from "../../src/components/notifications";
import { openAgentChat } from "../../src/pages/templates/agent-chat";
import { TemplateGallery } from "../../src/pages/templates/gallery";
import { createHost, Host } from "../../src/services/host";

// The template gallery over a host with one model, `source:model`. Storage `phone` opens the
// phone layout, `initial` the template a link named, `models` "0" takes the models away and
// `create` "fail" makes the host refuse the agent and `chat` "fail" the chat made for it. What the
// gallery asked the host is listed under "Sent:" (target.action and the arguments as JSON), the
// agent the host made under "Created:" and the conversation opened for it under "Opened:".
function Fixture(props: {
  phone: boolean;
  initial?: string;
  models: boolean;
  fail: boolean;
  chatFail: boolean;
}) {
  const host = createHost();
  const sent = signal<string[]>([]);
  const created = signal("");
  const opened = signal("");
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
    if (target === "agents" && action === "create") {
      if (props.fail) throw new Error("name taken");
      created.set("new-agent");
      return { agent: { id: "new-agent", homeProjectId: "home-new-agent" } };
    }
    if (target === "conversations" && action === "create") {
      if (props.chatFail) throw new Error("no such project");
      return { conversation: { id: "new-conversation" } };
    }
    return {};
  }) as typeof host.call;
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <Text>{`Sent: ${sent().join(" | ")}`}</Text>
        <Text>{`Created: ${created()}`}</Text>
        <Text>{`Opened: ${opened()}`}</Text>
        <TemplateGallery
          phone={props.phone}
          initialId={props.initial}
          onClose={noop}
          onCreated={(agent) =>
            void openAgentChat(host, agent).then((id) => opened.set(id ?? ""))
          }
          onModelServices={noop}
        />
        <NotificationHost />
      </View>
    </Host.Provider>
  );
}

void Promise.all([
  Storage.getItem("phone"),
  Storage.getItem("initial"),
  Storage.getItem("models"),
  Storage.getItem("create"),
  Storage.getItem("chat"),
]).then(([phone, initial, models, create, chat]) =>
  mount(() => (
    <Fixture
      phone={phone === "1"}
      initial={initial || undefined}
      models={models !== "0"}
      fail={create === "fail"}
      chatFail={chat === "fail"}
    />
  )),
);
