import { mount, signal, Text, View } from "nsh";
import { space } from "../../src/components/tokens";
import { CheckControl, ToggleSwitch } from "../../src/ui";

function App() {
  const agreed = signal(false);
  const enabled = signal(true);
  return (
    <View>
      <CheckControl
        label="Agree"
        checked={agreed()}
        size={space[16]}
        onChange={agreed.set}
      />
      <ToggleSwitch
        label="Enable sync"
        checked={enabled()}
        compact
        onChange={enabled.set}
      />
      <Text>{`agreed:${agreed()} enabled:${enabled()}`}</Text>
    </View>
  );
}

mount(() => <App />);
