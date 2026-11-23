import type { AttachmentView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { UploadState } from "@eta/client-contracts/composer-doc";
import { DOC_NODES } from "@eta/client-contracts/composer-doc";
import { mount, Scroll, Text, View, windowSize } from "nsh";
import { colors, Screen } from "../../src/components";
import {
  attachment,
  chatText,
  mention,
  shownFiles,
} from "../../src/components/eta-editor";
import { createHost, Host } from "../../src/services/host";
import { rememberPicture } from "../../src/services/pictures";

// One text, as the editor holds it (left) and as it is shown (right): the check that both halves
// of the text plugins draw it alike — headings, lists, code, quotes, a mention, a folded paste, a
// file and a picture. Under 900 wide it is laid out as on a phone.

/** A 4 × 3 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAEElEQVR4nGNwaDgARww4OQBZNhIB0175YwAAAABJRU5ErkJggg==";

const pasted = Array.from(
  { length: 24 },
  (_, line) => `[12:00:${String(line).padStart(2, "0")}] worker ${line} ok`,
).join("\n");

const before = `# Rollout plan
## Week 1
Ask @Ada to review the **rollout** and *ping* me, see [the doc](https://example.com/plan) and \`src/a_b.ts\`.
A second line of the same paragraph, ~~struck~~.

- team only
- 10% of users
  - then 50%

1. ship it
2. watch the graphs

- [x] flag added
- [ ] old flag removed

> Keep the old flag
> until week 3.

\`\`\`ts
const rollout = 0.1;
\`\`\`

---

The crash log: `;
const after = ` from last night.`;

export const sample = {
  text: before + pasted + after,
  blocks: [[before.length, before.length + pasted.length] as [number, number]],
  mentions: [{ id: "ada", label: "Ada" }],
};

export const files: AttachmentView[] = [
  { id: "f1", name: "notes.pdf", contentType: "application/pdf", size: 48213 },
  { id: "f2", name: "shot.png", contentType: "image/png", size: 70 },
];

const uploads = {
  state: (id: string): UploadState | undefined => {
    const file = files.find((item) => item.id === id);
    return file ? { state: "done", attachment: file } : undefined;
  },
  start: () => {},
  retry: () => false,
  thumbnail: (id: string) =>
    id === "f2" ? `data:image/png;base64,${PNG}` : undefined,
};

function Side(props: { title: string; children: JSX.Element }) {
  const c = colors();
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 8 }}>
      <Text style={{ fontSize: 11, color: c().muted, letterSpacing: 1 }}>
        {props.title}
      </Text>
      <View
        style={{
          borderWidth: 1,
          borderColor: c().border,
          padding: 12,
          backgroundColor: c().canvas,
        }}
      >
        {props.children}
      </View>
    </View>
  );
}

function Compare() {
  const c = colors();
  const editor = chatText.createEditor({
    text: sample,
    plugins: [mention({}), attachment({ uploads })],
  });
  const doc = editor.doc();
  editor.setDoc({
    ...doc,
    content: [
      ...(doc.content ?? []),
      {
        type: DOC_NODES.paragraph,
        content: files.map((file) => ({
          type: DOC_NODES.file,
          attrs: { ...file },
        })),
      },
    ],
  });
  return (
    <Scroll style={{ flex: 1, backgroundColor: c().surface }}>
      <View style={{ flexDirection: "row", gap: 16, padding: 16 }}>
        <Side title="EDITOR · chatText.Editor">
          <chatText.Editor
            editor={editor}
            label="Editor"
            padding={{ top: 0, bottom: 0, left: 0, right: 0 }}
          />
        </Side>
        <Side title="VIEW · chatText.View">
          <chatText.View
            text={{ ...sample, files }}
            plugins={[mention({}), shownFiles()]}
            label="View"
          />
        </Side>
      </View>
    </Scroll>
  );
}

function Fixture() {
  const host = createHost();
  host.address.set({ origin: "http://example.invalid" });
  host.state.update((state) => ({ ...state, status: "open" }));
  // The sent picture, as if fetched from the host.
  rememberPicture(
    "http://example.invalid",
    "f2",
    Uint8Array.from(atob(PNG), (char) => char.charCodeAt(0)),
    "image/png",
  );
  const layout = () => (windowSize().width < 900 ? "phone" : "desktop");
  return (
    <Host.Provider value={host}>
      <Screen.Provider value={layout}>
        <Compare />
      </Screen.Provider>
    </Host.Provider>
  );
}

mount(Fixture);
