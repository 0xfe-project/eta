import { mount, signal, Text, View } from "nsh";
import { Chip } from "../../src/ui";

function App() {
  const tags = signal(["design", "client"]);
  const active = signal("design");
  return (
    <View>
      <Each of={tags()}>
        {(tag) => (
          <Chip
            label={tag()}
            selected={active() === tag()}
            onPress={() => active.set(tag())}
            onRemove={() =>
              tags.update((all) => all.filter((item) => item !== tag()))
            }
          />
        )}
      </Each>
      <Text>{`active:${active()} count:${tags().length}`}</Text>
    </View>
  );
}

mount(() => <App />);
