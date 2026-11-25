import { mount, signal, Text, View } from "nsh";
import { Segmented, Tabs } from "../../src/ui";

function App() {
  const tab = signal<"models" | "connection">("models");
  const view = signal<"board" | "list" | "plan">("board");
  return (
    <View>
      <Tabs
        value={tab()}
        options={[
          { value: "models", label: "Models", count: 4 },
          { value: "connection", label: "Connection" },
        ]}
        onChange={tab.set}
      />
      <Segmented
        value={view()}
        options={[
          { value: "board", label: "Board" },
          { value: "list", label: "List" },
          { value: "plan", label: "Plan" },
        ]}
        onChange={view.set}
      />
      <Text>{`tab:${tab()} view:${view()}`}</Text>
    </View>
  );
}

mount(() => <App />);
