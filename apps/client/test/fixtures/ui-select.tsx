import { mount, signal, Text, View } from "nsh";
import { Screen } from "../../src/components/theme";
import { Label, LayoutSelect } from "../../src/ui";

const choices = [
  { value: "alpha", title: "Alpha" },
  { value: "beta", title: "Beta" },
  { value: "gamma", title: "Gamma" },
];

function App() {
  const desktopValue = signal("alpha");
  const phoneValue = signal("alpha");
  return (
    <View>
      <LayoutSelect
        accessibilityLabel="Desktop select"
        items={choices}
        value={desktopValue()}
        onChange={({ value }) => desktopValue.set(value ?? "alpha")}
        trigger={<Label>{desktopValue()}</Label>}
      />
      <Text>{`desktop:${desktopValue()}`}</Text>

      <Screen.Provider value={() => "phone"}>
        <LayoutSelect
          accessibilityLabel="Phone select"
          items={choices}
          value={phoneValue()}
          onChange={({ value }) => phoneValue.set(value ?? "alpha")}
          trigger={<Label>{phoneValue()}</Label>}
        />
      </Screen.Provider>
      <Text>{`phone:${phoneValue()}`}</Text>
    </View>
  );
}

mount(() => <App />);
