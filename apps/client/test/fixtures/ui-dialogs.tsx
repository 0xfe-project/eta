import { mount, signal, Text, View } from "nsh";
import { Button, ConfirmDialog, FieldDialog } from "../../src/ui";

function App() {
  const confirmOpen = signal(false);
  const fieldOpen = signal(false);
  const confirmed = signal(false);
  const name = signal("Alpha");
  const saved = signal("");
  return (
    <View>
      <Button label="Ask confirm" onPress={() => confirmOpen.set(true)} />
      <Button label="Ask rename" onPress={() => fieldOpen.set(true)} />
      <If when={confirmOpen()}>
        <ConfirmDialog
          title="Delete item?"
          description="This cannot be undone."
          confirmLabel="Delete"
          tone="danger"
          phone={false}
          onConfirm={() => {
            confirmed.set(true);
            confirmOpen.set(false);
          }}
          onClose={() => confirmOpen.set(false)}
        />
      </If>
      <If when={fieldOpen()}>
        <FieldDialog
          title="Rename"
          label="Name"
          value={name()}
          phone={false}
          busy={false}
          valid={name().trim().length > 0}
          onChange={name.set}
          onSave={() => {
            saved.set(name());
            fieldOpen.set(false);
          }}
          onClose={() => fieldOpen.set(false)}
        />
      </If>
      <Text>{`confirmed:${confirmed()} saved:${saved()}`}</Text>
    </View>
  );
}

mount(() => <App />);
