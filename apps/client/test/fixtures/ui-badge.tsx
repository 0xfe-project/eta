import { mount, View } from "nsh";
import { colors } from "../../src/components";
import { Badge, dotSize, StatusDot } from "../../src/ui";

function App() {
  const c = colors();
  return (
    <View>
      <Badge label="Running" tone="blue" />
      <Badge
        label="Needs setup"
        tone="warning"
        variant="outline"
        size="caption"
      />
      <Badge label="Locked" tone="neutral" variant="outline" icon="lock" />
      <StatusDot color={c().green} size={dotSize} />
    </View>
  );
}

mount(() => <App />);
