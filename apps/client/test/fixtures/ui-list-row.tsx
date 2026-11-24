import { mount, signal, Text, View } from "nsh";
import { Icon, ListRow, SectionHeader } from "../../src/ui";

function App() {
  const opened = signal("");
  return (
    <View>
      <SectionHeader
        title="Preferences"
        count={2}
        description="Client options"
      />
      <ListRow
        title="Appearance"
        detail="Theme and layout"
        leading={<Icon name="settings" />}
        onPress={() => opened.set("appearance")}
      />
      <Text>{`opened:${opened()}`}</Text>
    </View>
  );
}

mount(() => <App />);
