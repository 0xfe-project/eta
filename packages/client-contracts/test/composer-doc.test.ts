import { describe, expect, it } from "vitest";
import {
  classifyClipboard,
  docToDraft,
  draftToDoc,
  isBlankDoc,
  legacyDraftToDoc,
  lineCount,
  sentToDraft,
  serializeDoc,
} from "../src/composer-doc";
import { MAX_MESSAGE_CHARS } from "../src/composer-draft";
import { samples } from "./fixtures/clipboard";

const chat = { files: true };
const noFiles = { files: false };

describe("classifyClipboard", () => {
  it("folds code copied from VS Code and keeps its text, not its colours", () => {
    expect(classifyClipboard(samples.vscode, chat)).toEqual({
      kind: "text",
      text: "function add(a, b) {\n  return a + b;\n}\n",
    });
    // Three lines and the newline after the last: still three lines, typed in.
    expect(lineCount(samples.vscode.text)).toBe(3);
    expect(classifyClipboard(samples.vscodeLine, chat)).toEqual({
      kind: "text",
      text: "const answer = 42;\n",
    });
  });

  it("pastes a web page as its plain text, folded when it is long", () => {
    expect(classifyClipboard(samples.webPage, chat)).toEqual({
      kind: "block",
      text: samples.webPage.text,
    });
    expect(classifyClipboard(samples.webTable, chat)).toEqual({
      kind: "block",
      text: samples.webTable.text,
    });
  });

  it("takes a file manager's copy as files, though it carries the name as text and an icon", () => {
    expect(classifyClipboard(samples.finder, chat)).toEqual({ kind: "files" });
    expect(classifyClipboard(samples.twoFiles, chat)).toEqual({
      kind: "files",
    });
  });

  it("takes a screenshot as a file", () => {
    expect(classifyClipboard(samples.screenshot, chat)).toEqual({
      kind: "files",
    });
  });

  it("takes the text of a spreadsheet or Word copy, not the picture of it", () => {
    expect(classifyClipboard(samples.spreadsheet, chat)).toEqual({
      kind: "block",
      text: "Quarter\tRevenue\nQ1\t1200\nQ2\t1350\nQ3\t1500\nQ4\t1720\n",
    });
    expect(classifyClipboard(samples.word, chat)).toEqual({
      kind: "text",
      text: "Dear team,\n\nThe draft is attached.\n",
    });
  });

  it("folds a terminal's output by its lines", () => {
    expect(classifyClipboard(samples.terminal, chat)).toEqual({
      kind: "block",
      text: samples.terminal.text,
    });
  });

  it("turns Windows newlines into \\n", () => {
    expect(classifyClipboard(samples.windowsNewlines, chat)).toEqual({
      kind: "block",
      text: "one\ntwo\nthree\nfour\nfive",
    });
  });

  it("makes text longer than a message a .txt attachment, where files are taken", () => {
    const text = "x".repeat(MAX_MESSAGE_CHARS + 1);
    expect(classifyClipboard({ text }, chat)).toEqual({
      kind: "textFile",
      text,
    });
    expect(classifyClipboard({ text }, noFiles)).toEqual({
      kind: "block",
      text,
    });
  });

  it("ignores files where the box takes none, pasting the text that came with them", () => {
    expect(classifyClipboard(samples.screenshot, noFiles)).toEqual({
      kind: "nothing",
    });
    expect(classifyClipboard(samples.finder, noFiles)).toEqual({
      kind: "text",
      text: "notes.txt",
    });
  });
});

describe("document and draft", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "  look at " },
          {
            type: "attachment",
            attrs: {
              id: "f1",
              name: "shot.png",
              contentType: "image/png",
              size: 10,
            },
          },
          { type: "text", text: " and " },
          { type: "pasteBlock", attrs: { id: "p1", text: "a\nb\nc\nd" } },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "mention", attrs: { id: "agent-1", label: "Opus" } },
          { type: "text", text: " please " },
          { type: "mention", attrs: { id: "agent-1", label: "Opus" } },
        ],
      },
      { type: "paragraph" },
    ],
  };

  it("serializes to what conversations.send takes, the paste's range in the trimmed text", () => {
    const sent = serializeDoc(doc);
    expect(sent).toEqual({
      text: "look at  and a\nb\nc\nd\n@Opus please @Opus",
      blocks: [[13, 20]],
      mentions: ["agent-1"],
      files: ["f1"],
    });
    expect(sent.text.slice(...sent.blocks[0]!)).toBe("a\nb\nc\nd");
  });

  it("goes to a draft and back unchanged, mentions read as their text", () => {
    const { draft } = docToDraft(doc);
    expect(draft.map((part) => part.type)).toEqual([
      "text",
      "file",
      "text",
      "paste",
      "text",
    ]);
    const again = docToDraft(draftToDoc(draft)).draft;
    expect(again).toEqual(draft);
  });

  it("brings a sent message back with its pastes folded and its files", () => {
    const draft = sentToDraft({
      text: "see a\nb\nc\nd end",
      blocks: [[4, 11]],
      attachments: [
        { id: "f2", name: "log.txt", contentType: "text/plain", size: 3 },
      ],
    });
    expect(draft).toEqual([
      { type: "text", text: "see " },
      { type: "paste", id: "paste-4", text: "a\nb\nc\nd" },
      { type: "text", text: " end" },
      {
        type: "file",
        id: "f2",
        name: "log.txt",
        contentType: "text/plain",
        size: 3,
      },
    ]);
  });

  it("reads a draft saved by the old composer once", () => {
    const { doc: read, uploads } = legacyDraftToDoc({
      text: "and the rest",
      prefix: [
        { type: "text", text: "before " },
        { type: "paste", id: "p", text: "1\n2\n3\n4" },
      ],
      attachments: [
        { id: "a1", name: "x.pdf", contentType: "application/pdf", size: 5 },
      ],
    });
    expect(serializeDoc(read)).toEqual({
      text: "before 1\n2\n3\n4and the rest",
      blocks: [[7, 14]],
      mentions: [],
      files: ["a1"],
    });
    expect(uploads.a1).toEqual({
      state: "done",
      attachment: {
        id: "a1",
        name: "x.pdf",
        contentType: "application/pdf",
        size: 5,
      },
    });
  });

  it("knows a blank document", () => {
    expect(isBlankDoc({ type: "doc", content: [{ type: "paragraph" }] })).toBe(
      true,
    );
    expect(isBlankDoc(doc)).toBe(false);
  });
});
