import { mount, Text, View } from "nsh";
import { Disclosure } from "../../src/ui";

mount(() => (
  <View>
    <Disclosure.Root>
      <Disclosure.Trigger label="More details" />
      <Disclosure.Content>
        <Text>Expanded content</Text>
      </Disclosure.Content>
    </Disclosure.Root>
  </View>
));
