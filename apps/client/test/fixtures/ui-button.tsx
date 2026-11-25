import { mount, signal, Text, View } from "nsh";
import { BackButton, Button, CloseButton } from "../../src/ui";

function App() {
  const count = signal(0);
  const busy = signal(false);
  const nav = signal("");
  return (
    <View>
      <Button
        label="Save"
        tone="primary"
        busy={busy()}
        onPress={() => count.update((n) => n + 1)}
      />
      <Button label="Toggle busy" onPress={() => busy.set(!busy())} />
      <BackButton onPress={() => nav.set("back")} />
      <CloseButton onPress={() => nav.set("close")} />
      <Text>{`count:${count()} nav:${nav()}`}</Text>
    </View>
  );
}

mount(() => <App />);
