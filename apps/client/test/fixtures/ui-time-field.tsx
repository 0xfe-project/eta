import { mount, signal, Text, View } from "nsh";
import { TimeField } from "../../src/ui";

function App() {
  const at = signal("09:30");
  return (
    <View>
      <TimeField label="Run time" value={at()} onChange={at.set} />
      <Text>{`at:${at()}`}</Text>
    </View>
  );
}

mount(() => <App />);
