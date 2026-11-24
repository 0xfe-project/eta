import { mount, signal, Text, View } from "nsh";
import { Field, FormField } from "../../src/ui";

function App() {
  const name = signal("");
  const error = () =>
    name().length > 0 && name().length < 3 ? "Too short" : "";
  return (
    <View>
      <FormField
        label="Project name"
        hint="Use at least 3 characters"
        error={error()}
      >
        <Field
          label="Project name"
          placeholder="eta"
          value={name()}
          invalid={!!error()}
          compact
          onChange={name.set}
        />
      </FormField>
      <Text>{`value:${name()}`}</Text>
    </View>
  );
}

mount(() => <App />);
