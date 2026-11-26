import type { LlmModel } from "@eta/client-contracts";
import { mount, signal, Text, View } from "nsh";
import { Screen } from "../../src/components/theme";
import { SkillSelect } from "../../src/pages/plugins/skills/select";
import { createHost, Host } from "../../src/services/host";
import { Label, LayoutSelect, ModelSelect } from "../../src/ui";

const choices = [
  { value: "alpha", title: "Alpha" },
  { value: "beta", title: "Beta" },
  { value: "gamma", title: "Gamma" },
];

const skillChoices = [
  { value: "macbook", title: "MacBook Pro", suffix: "Primary" },
  { value: "linux-box", title: "Linux Box" },
];

const models: LlmModel[] = [
  {
    id: "claude-sonnet",
    connector: "anthropic",
    name: "Claude Sonnet",
    status: "available",
    available: true,
  },
  {
    id: "gpt-5",
    connector: "openai",
    name: "GPT-5",
    status: "available",
    available: true,
  },
];

function App() {
  const host = createHost();
  host.state.update((state) => ({
    ...state,
    status: "open",
    targets: {
      ...state.targets,
      llm: {
        version: 1,
        revisions: {},
        sections: { models },
      },
    },
  }));
  const desktopValue = signal("alpha");
  const phoneValue = signal("alpha");
  const skillValue = signal("macbook");
  const desktopModel = signal("llm:claude-sonnet");
  const phoneModel = signal("llm:claude-sonnet");
  return (
    <Host.Provider value={host}>
      <View style={{ padding: 16, gap: 12 }}>
        <LayoutSelect
          accessibilityLabel="Desktop select"
          items={choices}
          value={desktopValue()}
          onChange={({ value }) => desktopValue.set(value ?? "alpha")}
          trigger={<Label>{desktopValue()}</Label>}
        />
        <Text>{`desktop:${desktopValue()}`}</Text>

        <View testID="desktop-model">
          <ModelSelect value={desktopModel()} onChange={desktopModel.set} />
        </View>
        <Text>{`desktop-model:${desktopModel()}`}</Text>

        <Screen.Provider value={() => "phone"}>
          <LayoutSelect
            accessibilityLabel="Phone select"
            items={choices}
            value={phoneValue()}
            onChange={({ value }) => phoneValue.set(value ?? "alpha")}
            trigger={<Label>{phoneValue()}</Label>}
          />
          <SkillSelect
            label="Phone skill"
            items={skillChoices}
            value={skillValue()}
            placeholder="Select device"
            onChange={skillValue.set}
          />
          <View testID="phone-model">
            <ModelSelect value={phoneModel()} onChange={phoneModel.set} />
          </View>
        </Screen.Provider>
        <Text>{`phone:${phoneValue()}`}</Text>
        <Text>{`skill:${skillValue()}`}</Text>
        <Text>{`phone-model:${phoneModel()}`}</Text>
      </View>
    </Host.Provider>
  );
}

mount(() => <App />);
