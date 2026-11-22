import type { DocNode } from "@eta/client-contracts/composer-doc";
import type { RichNodeJSON } from "nsh/base";
import { serializeDoc } from "@eta/client-contracts/composer-doc";
import { sameDoc } from "@eta/client-contracts/composer-markdown";
import { expect, test } from "nsh/test";
import {
  attachment,
  chatText,
  descriptionText,
  mention,
} from "../src/components/eta-editor";

// Markdown is what a message keeps: what is written in the editor goes out as Markdown and reads
// back as the same text. Each document is put through a real editor of the chat's text first, so
// only documents the editor can hold are tested.

const uploads = {
  state: () => undefined,
  start: () => {},
  retry: () => false,
  thumbnail: () => undefined,
};

function editor() {
  return chatText.createEditor({
    plugins: [mention({}), attachment({ uploads })],
  });
}

/** `doc` as the editor holds it (checked against its schema). */
function held(doc: DocNode): DocNode {
  const handle = editor();
  handle.session.setContent(doc as RichNodeJSON);
  return handle.doc();
}

const t = (text: string, ...marks: string[]): DocNode =>
  ({
    type: "text",
    text,
    ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
  }) as DocNode;
const p = (...content: DocNode[]): DocNode =>
  content.length ? { type: "paragraph", content } : { type: "paragraph" };
const doc = (...content: DocNode[]): DocNode => ({ type: "doc", content });

const samples = [
  "Plain words, a path src/a_b.ts and 2*3*4",
  "two lines\nof plain text",
  "## Rollout\n\n- week 1: **team only**\n- week 2: 10%",
  "# Title\n\nSome *soft* and ~~gone~~ text with `code` and [a link](https://example.com/a_b).",
  "1. one\n2. two\n   - nested\n3. three",
  "- [x] done\n- [ ] todo",
  "> quoted\n> twice\n\nanswer",
  "```ts\nconst x = 1;\n\nx++\n```\n\nafter",
  "above\n\n---\n\nbelow",
];

test("Markdown read into the editor writes back as itself", () => {
  for (const sample of samples) {
    const written = chatText.write(held(chatText.read({ text: sample })));
    expect(written.text).toBe(sample);
  }
});

test("what is edited reads back the same from its Markdown", () => {
  const edited = held(
    doc(
      { type: "heading", attrs: { level: 2 }, content: [t("Plan")] },
      p(t("Keep the "), t("hover band", "bold"), t(" and "), t("Row", "code")),
      p(t("- not a list, typed after the list was undone")),
      p(t("snake_case * and # stay as typed")),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [p(t("one"))] },
          { type: "listItem", content: [p(t("two "), t("bold", "bold"))] },
        ],
      },
      {
        type: "codeBlock",
        attrs: { language: "tsx" },
        content: [t("<Row inset={12} />\n**not bold**")],
      },
      { type: "blockquote", content: [p(t("a quote")), p(t("on two lines"))] },
    ),
  );
  const written = chatText.write(edited);
  expect(
    sameDoc(
      chatText.read({ text: written.text, blocks: written.blocks }),
      edited,
    ),
  ).toBe(true);
  // The line that would read as a list is escaped; the rest is as typed.
  expect(written.text).toContain("\\- not a list");
  expect(written.text).toContain("snake_case * and # stay as typed");
});

test("inline blocks go as mentions, pastes and files, and read back as blocks", () => {
  const edited = held(
    doc(
      p(
        t("ask "),
        { type: "mention", attrs: { id: "m1", label: "Ada" } },
        t(" about "),
        { type: "pasteBlock", attrs: { id: "p1", text: "*a*\n# b\n- c\nd" } },
      ),
      p(
        {
          type: "attachment",
          attrs: {
            id: "f1",
            name: "shot.png",
            contentType: "image/png",
            size: 9,
          },
        },
        t("thanks "),
        { type: "mention", attrs: { id: "m1", label: "Ada" } },
      ),
    ),
  );
  const written = chatText.write(edited);
  expect(written.text).toBe("ask @Ada about *a*\n# b\n- c\nd\nthanks @Ada");
  expect(written.blocks).toEqual([[15, 28]]);
  expect(written.text.slice(15, 28)).toBe("*a*\n# b\n- c\nd");
  expect(written.mentions).toEqual(["m1"]);
  expect(written.files).toEqual(["f1"]);
  const back = held(
    chatText.read({
      text: written.text,
      blocks: written.blocks,
      mentions: [{ id: "m1", label: "Ada" }],
    }),
  );
  const first = back.content?.[0]?.content ?? [];
  expect(first.map((node) => node.type)).toEqual([
    "text",
    "mention",
    "text",
    "pasteBlock",
  ]);
  expect(first[3]?.attrs?.text).toBe("*a*\n# b\n- c\nd");
});

test("a plain message goes out as it did before formatting", () => {
  const plain = held(
    doc(
      p(t("hi "), { type: "mention", attrs: { id: "m1", label: "Ada" } }),
      p(),
      p(t("fix src/a_b.ts, a*b and C++ ")),
      p({ type: "pasteBlock", attrs: { id: "p", text: "l1\nl2\nl3\nl4" } }),
    ),
  );
  expect(chatText.write(plain)).toEqual(serializeDoc(plain));
});

test("only what would read as formatting is escaped", () => {
  const typed = held(doc(p(t("2*3*4 in src/a_b.ts"))));
  // `*3*` would be emphasis; one escape is enough, the rest stays as typed.
  expect(chatText.write(typed).text).toBe("2*3\\*4 in src/a_b.ts");
});

test("a list in an item that starts past 1 keeps its place, and the rest stays unescaped", () => {
  const edited = held(
    doc(p(t("Steps with snake_case")), {
      type: "orderedList",
      attrs: { start: 1 },
      content: [
        { type: "listItem", content: [p(t("check"))] },
        {
          type: "listItem",
          content: [
            p(t("ship")),
            {
              type: "orderedList",
              attrs: { start: 3 },
              content: [
                { type: "listItem", content: [p(t("verify", "bold"))] },
              ],
            },
          ],
        },
      ],
    }),
  );
  const written = chatText.write(edited);
  expect(sameDoc(chatText.read({ text: written.text }), edited)).toBe(true);
  expect(written.text).toBe(
    "Steps with snake_case\n\n1. check\n2. ship\n\n   3. **verify**",
  );
});

test("a description's table and image survive an edit, row for row", () => {
  const old =
    "Intro\n\n| browser | ok |\n| --- | :-: |\n| `Safari` | no |\n\nSee ![shot](https://example.com/s.png) there";
  const editor = descriptionText.createEditor({ text: { text: old } });
  editor.session.setContent({
    type: "doc",
    content: [...(editor.doc().content ?? []), p(t("Added"))],
  } as RichNodeJSON);
  expect(descriptionText.write(editor.doc()).text).toBe(`${old}\nAdded`);
});
