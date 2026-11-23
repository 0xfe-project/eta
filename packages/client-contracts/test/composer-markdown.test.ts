import type { DocNode } from "../src/composer-doc";
import { describe, expect, it } from "vitest";
import { draftToDoc, serializeDoc } from "../src/composer-doc";
import {
  docToMarkdown,
  markdownSource,
  restoreDoc,
  sameDoc,
} from "../src/composer-markdown";
import { isEditorCode, looksLikeMarkdown } from "../src/composer-paste";
import { samples } from "./fixtures/clipboard";

const text = (value: string, marks?: string[]): DocNode =>
  ({
    type: "text",
    text: value,
    ...(marks ? { marks: marks.map((type) => ({ type })) } : {}),
  }) as DocNode;
const p = (...content: DocNode[]): DocNode =>
  content.length ? { type: "paragraph", content } : { type: "paragraph" };
const doc = (...content: DocNode[]): DocNode => ({ type: "doc", content });
const mention = (id: string, label: string): DocNode => ({
  type: "mention",
  attrs: { id, label },
});
const paste = (value: string): DocNode => ({
  type: "pasteBlock",
  attrs: { id: "x", text: value },
});
const file = (id: string): DocNode => ({
  type: "attachment",
  attrs: { id, name: "a.png", contentType: "image/png", size: 3 },
});

describe("docToMarkdown", () => {
  it("writes plain lines as they were typed, the same text a plain draft sent", () => {
    const plain = doc(
      p(text("fix src/a_b.ts, 2*3*4 and C++ ")),
      p(),
      p(text("issue #786 <b>")),
    );
    expect(docToMarkdown(plain).text).toBe(
      "fix src/a_b.ts, 2*3*4 and C++ \n\nissue #786 <b>",
    );
    expect(docToMarkdown(plain).text).toBe(serializeDoc(plain).text);
  });

  it("keeps the wire format of mentions, pastes and files", () => {
    const value = doc(
      p(
        text("hi "),
        mention("m1", "Ada"),
        text(" see "),
        paste("l1\nl2\nl3\nl4"),
      ),
      p(file("f1"), text("end "), mention("m1", "Ada")),
    );
    const out = docToMarkdown(value);
    expect(out).toEqual(serializeDoc(value));
    expect(out.text).toBe("hi @Ada see l1\nl2\nl3\nl4\nend @Ada");
    expect(out.text.slice(...out.blocks[0]!)).toBe("l1\nl2\nl3\nl4");
    expect(out.mentions).toEqual(["m1"]);
    expect(out.files).toEqual(["f1"]);
  });

  it("writes formatting as Markdown", () => {
    const value = doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Plan")] },
      p(
        text("Keep the "),
        text("hover band", ["bold"]),
        text(" and "),
        text("Row", ["code"]),
        text(" "),
        text("gone", ["strike"]),
        text(" "),
        text("soft", ["italic"]),
      ),
      {
        type: "bulletList",
        content: [
          { type: "listItem", content: [p(text("one"))] },
          {
            type: "listItem",
            content: [
              p(text("two")),
              {
                type: "orderedList",
                attrs: { start: 3 },
                content: [{ type: "listItem", content: [p(text("deep"))] }],
              },
            ],
          },
        ],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [p(text("done"))],
          },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [p(text("todo"))],
          },
        ],
      },
      { type: "blockquote", content: [p(text("quoted")), p(text("twice"))] },
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [text("const a = `x`;\n```\nend")],
      },
      { type: "horizontalRule" },
      p({
        type: "text",
        text: "the PR",
        marks: [{ type: "link", attrs: { href: "https://x.y/1" } }],
      } as DocNode),
    );
    expect(docToMarkdown(value).text).toBe(
      [
        "## Plan",
        "",
        "Keep the **hover band** and `Row` ~~gone~~ *soft*",
        "",
        "- one",
        "- two",
        // A list starting past 1 may not interrupt a line: without the blank line it reads as
        // "two 3. deep".
        "",
        "  3. deep",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "> quoted",
        "> twice",
        "",
        "````ts",
        "const a = `x`;",
        "```",
        "end",
        "````",
        "",
        "---",
        "",
        "[the PR](https://x.y/1)",
      ].join("\n"),
    );
  });

  it("escapes a block when asked", () => {
    const value = doc(p(text("- not a list *really*")));
    expect(docToMarkdown(value, () => "escaped").text).toBe(
      "\\- not a list \\*really\\*",
    );
  });

  it("keeps spaces outside emphasis", () => {
    const value = doc(p(text("a"), text(" bold ", ["bold"]), text("b")));
    expect(docToMarkdown(value).text).toBe("a **bold** b");
  });
});

describe("markdownSource and restoreDoc", () => {
  it("stands in for pastes and mentions, so the parser reads neither", () => {
    const sent = "ask @Ada about **this**: *a*\n*b*";
    const { source, stands } = markdownSource({
      text: sent,
      blocks: [[25, 32]],
      mentions: [{ id: "m1", label: "Ada" }],
    });
    expect(source).toBe("ask \uE000 about **this**: \uE001");
    expect(stands).toEqual([
      { type: "mention", attrs: { id: "m1", label: "Ada" } },
      { type: "pasteBlock", attrs: { id: "paste-25", text: "*a*\n*b*" } },
    ]);
    // What nsh's parser makes of the source, put back.
    const parsed = doc({
      type: "paragraph",
      attrs: { textAlign: null },
      content: [
        text("ask \uE000 about "),
        text("this", ["bold"]),
        text(": \uE001"),
      ],
    } as DocNode);
    expect(restoreDoc(parsed, stands)).toEqual(
      doc(
        p(
          text("ask "),
          mention("m1", "Ada"),
          text(" about "),
          text("this", ["bold"]),
          text(": "),
          { type: "pasteBlock", attrs: { id: "paste-25", text: "*a*\n*b*" } },
        ),
      ),
    );
  });

  it("makes each line of a paragraph a paragraph, and caps headings at three", () => {
    const parsed = doc(
      { type: "paragraph", content: [text("one\ntwo")] },
      { type: "heading", attrs: { level: 5 }, content: [text("deep")] },
    );
    expect(restoreDoc(parsed, [])).toEqual(
      doc(p(text("one")), p(text("two")), {
        type: "heading",
        attrs: { level: 3 },
        content: [text("deep")],
      }),
    );
  });

  it("keeps characters of the private use area the text already had", () => {
    const { source, stands } = markdownSource({ text: "icon \uE0A0 here" });
    const parsed = doc(p(text(source)));
    expect(restoreDoc(parsed, stands)).toEqual(
      doc(p(text("icon \uE0A0 here"))),
    );
  });
});

describe("sameDoc", () => {
  it("ignores what Markdown does not keep: files, empty lines, mention ids", () => {
    expect(
      sameDoc(
        doc(p(text("a "), file("f")), p(), p(mention("m", "Ada"))),
        doc(p(text("a")), p(text("@Ada"))),
      ),
    ).toBe(true);
    expect(sameDoc(doc(p(text("a"))), doc(p(text("a", ["bold"]))))).toBe(false);
  });
});

describe("paste kinds", () => {
  it("tells Markdown from prose and logs", () => {
    expect(looksLikeMarkdown("## Rollout\n- week 1")).toBe(true);
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("Use **this** one")).toBe(true);
    expect(looksLikeMarkdown("call `run()` first")).toBe(true);
    expect(looksLikeMarkdown("Dear team,\nthe draft is attached.")).toBe(false);
    expect(looksLikeMarkdown(samples.terminal.text)).toBe(false);
    expect(looksLikeMarkdown("- just one dash")).toBe(false);
  });

  it("knows code copied from an editor by its HTML", () => {
    expect(isEditorCode(samples.vscode.html)).toBe(true);
    expect(
      isEditorCode(
        "<pre style=\"background-color:#2b2b2b;font-family:'JetBrains Mono',monospace;\">x</pre>",
      ),
    ).toBe(true);
    expect(isEditorCode(samples.webPage.html)).toBe(false);
    expect(isEditorCode(samples.word.html)).toBe(false);
    expect(isEditorCode(undefined)).toBe(false);
  });
});

it("writes a plain draft from before the rich editor as it was sent", () => {
  const old = draftToDoc([
    { type: "text", text: "see\n" },
    { type: "paste", id: "p", text: "a\nb\nc\nd" },
    { type: "text", text: "\nthanks" },
  ]);
  expect(docToMarkdown(old)).toEqual(serializeDoc(old));
});

describe("classifyClipboard in a rich editor", () => {
  const rich = { files: true, rich: true };
  it("makes code from an editor a code block, and a single line text", async () => {
    const { classifyClipboard } = await import("../src/composer-doc");
    expect(classifyClipboard(samples.vscode, rich)).toEqual({
      kind: "code",
      text: samples.vscode.text,
    });
    expect(classifyClipboard(samples.vscodeLine, rich).kind).toBe("text");
  });

  it("reads Markdown as Markdown, and still folds a long log", async () => {
    const { classifyClipboard } = await import("../src/composer-doc");
    const markdown = "## Rollout\n- week 1: **team only**\n- week 2: 10%";
    expect(classifyClipboard({ text: markdown }, rich)).toEqual({
      kind: "markdown",
      text: markdown,
    });
    expect(classifyClipboard(samples.terminal, rich).kind).toBe("block");
    expect(classifyClipboard({ text: markdown }, { files: true }).kind).toBe(
      "text",
    );
  });
});

describe("what the editor has no block for", () => {
  const literal = (source: string, stands: DocNode[]) =>
    [...source]
      .map((char) => {
        const at = char.charCodeAt(0) - 0xe000;
        return at >= 0 && at < stands.length ? `«${stands[at]!.text}»` : char;
      })
      .join("");

  it("keeps a table's rows and an image as their own text", () => {
    const { source, stands } = markdownSource({
      text: "Intro\n\n| a | b \\| c |\n| --- | :-: |\n| `x` | y |\n\nAfter ![shot](s.png) here",
    });
    expect(literal(source, stands)).toBe(
      "Intro\n\n«| a | b \\| c |»\n«| --- | :-: |»\n«| `x` | y |»\n\nAfter «![shot](s.png)» here",
    );
  });

  it("writes a table's rows, kept as lines, with a blank line around them", () => {
    const line = (text: string): DocNode => ({
      type: "paragraph",
      content: [{ type: "text", text }],
    });
    const doc: DocNode = {
      type: "doc",
      content: [
        "Intro",
        "| a | b |",
        "| --- | --- |",
        "| c | d |",
        "after",
        "more",
      ].map(line),
    };
    expect(docToMarkdown(doc).text).toBe(
      "Intro\n\n| a | b |\n| --- | --- |\n| c | d |\n\nafter\nmore",
    );
  });

  it("leaves code, a setext heading and a lone pipe as they are", () => {
    const text =
      "```\n| a | b |\n| - | - |\n![x](y)\n```\n\nTitle | x\n---\n\na | b";
    const { source, stands } = markdownSource({ text });
    expect(source).toBe(text);
    expect(stands).toEqual([]);
  });
});
