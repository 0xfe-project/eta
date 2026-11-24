import { mount, signal, Text, View } from "nsh";
import { Button, dialogWidth, Modal } from "../../src/ui";

function App() {
  const open = signal(false);
  return (
    <View>
      <Button label="Open modal" onPress={() => open.set(true)} />
      <If when={open()}>
        <Modal
          title="Settings dialog"
          width={dialogWidth.sm}
          onClose={() => open.set(false)}
        >
          <Text>Dialog body</Text>
        </Modal>
      </If>
    </View>
  );
}

mount(() => <App />);
