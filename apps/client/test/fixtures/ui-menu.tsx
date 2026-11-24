import { mount, signal, Text, View } from "nsh";
import { ActionItem, ActionMenu } from "../../src/ui";

function App() {
  const chosen = signal("none");
  return (
    <View>
      <ActionMenu label="Options" value={chosen()}>
        <ActionItem
          label="Rename"
          checked={chosen() === "Rename"}
          onSelect={() => chosen.set("Rename")}
        />
        <ActionItem
          label="Archive"
          tone="red"
          onSelect={() => chosen.set("Archive")}
        />
      </ActionMenu>
      <Text>{`chosen:${chosen()}`}</Text>
    </View>
  );
}

mount(() => <App />);
