import { mount, platform, signal, Text, View } from "nsh";
import { chatText } from "../../src/components/eta-editor";

// A chat's shape: replies shown above a composer. One reply is on its own, one is in a view that
// takes the keyboard focus when pressed (the transcript is one, for keyboard navigation). What the
// user selects in a reply, and what ⌘C / Ctrl+C then copies.

const first = "Ship the **rollout** on Monday.";
const second = "Keep the *old* flag until week 3.";

function CopyAround() {
  const editor = chatText.createEditor({});
  const selected = signal("");
  const pick = (event: { text: string }) => selected.set(event.text);
  return (
    <View style={{ flex: 1, padding: 16, gap: 16 }}>
      <chatText.View
        text={{ text: first }}
        label="Reply"
        onSelectionChange={pick}
      />
      <View focusable accessibilityLabel="Transcript">
        <chatText.View
          text={{ text: second }}
          label="Reply in the transcript"
          onSelectionChange={pick}
        />
      </View>
      <Text>{`selected: ${selected()}`}</Text>
      <Text>{`platform: ${platform.os}`}</Text>
      <chatText.Editor editor={editor} label="Message" />
    </View>
  );
}

mount(CopyAround);
