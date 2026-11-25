import { mount, signal, Text, View } from "nsh";
import { Button, Popover } from "../../src/ui";

function App() {
  const open = signal(false);
  return (
    <View>
      <Popover
        open={open()}
        onOpenChange={open.set}
        trigger={
          <Button label="Open popover" onPress={() => open.set(!open())} />
        }
      >
        <Text>Popover content</Text>
      </Popover>
    </View>
  );
}

mount(() => <App />);
