import { mount, signal, Text, View } from "nsh";
import { space } from "../../src/components/tokens";
import { Card, Separator } from "../../src/ui";

function App() {
  const picked = signal(false);
  return (
    <View>
      <Card surface="surface" padding={space[12]}>
        <Text>Static card</Text>
      </Card>
      <Separator />
      <Card
        accessibilityLabel="Pick me"
        selected={picked()}
        padding={space[12]}
        onPress={() => picked.set(!picked())}
      >
        <Text>{picked() ? "Picked" : "Unpicked"}</Text>
      </Card>
    </View>
  );
}

mount(() => <App />);
