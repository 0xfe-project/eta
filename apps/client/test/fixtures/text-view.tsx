import type { TextPlugin } from "../../src/components/eta-editor";
import { mount, signal, Text, View } from "nsh";
import { createTextSystem } from "../../src/components/eta-editor";
import { richText } from "../../src/components/eta-editor/plugins/rich-text";

// A plugin with both halves: in the editor it counts the editors made with it, where the text is
// shown it draws `#12` as a ticket.
const editors = signal(0);
const ticket: TextPlugin = {
  name: "ticket",
  editor: { setup: () => editors.set(editors() + 1) },
  view: {
    extensions: [{ name: "ticket", pattern: "#(\\d+)" }],
    renderCustom: {
      ticket: (node) => (
        <Text accessibilityLabel={`Ticket ${node.attributes?.["1"] ?? ""}`}>
          {node.text ?? ""}
        </Text>
      ),
    },
  },
};
const system = createTextSystem([richText(), ticket]);

function Fixture() {
  system.createEditor({ text: { text: "see #12" } });
  return (
    <View style={{ padding: 16, gap: 8 }}>
      <Text>{`editors: ${editors()}`}</Text>
      <system.View
        text={{ text: "Fixed in #12, see\nthe log." }}
        label="Shown"
      />
    </View>
  );
}

mount(Fixture);
