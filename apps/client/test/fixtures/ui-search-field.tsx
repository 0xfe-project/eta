import { mount, signal, Text, View } from "nsh";
import { SearchField } from "../../src/ui";

function App() {
  const query = signal("");
  return (
    <View>
      <SearchField
        label="Search items"
        value={query()}
        compact
        onChange={query.set}
      />
      <Text>{`q:${query()}`}</Text>
    </View>
  );
}

mount(() => <App />);
