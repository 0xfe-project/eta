import { mount, Text, View } from "nsh";
import { colors } from "../../src/components";
import { hint, Tooltip } from "../../src/ui";

function App() {
  const c = colors();
  return (
    <View>
      <View tooltip={hint("Quick hint", c)}>
        <Text>Hover target</Text>
      </View>
      <View
        tooltip={
          <Tooltip>
            <Text>Rich tip</Text>
          </Tooltip>
        }
      >
        <Text>Rich target</Text>
      </View>
    </View>
  );
}

mount(() => <App />);
