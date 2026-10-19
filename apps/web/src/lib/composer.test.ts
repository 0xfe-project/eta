import type { Attachment, Draft } from "./composer";
import { describe, expect, it } from "@rstest/core";
import {
  afterCommand,
  charCount,
  draftOf,
  isBlank,
  isLongPaste,
  LONG_PASTE,
  messageParts,
} from "./composer";

const csv: Attachment = {
  id: "a1",
  name: "data.csv",
  content_type: "text/csv",
  size: 8,
};

describe("long pastes", () => {
  it("count characters as people see them, and lines", () => {
    expect(charCount("😀字a")).toBe(3);
    expect(isLongPaste("字".repeat(LONG_PASTE.chars))).toBe(false);
    expect(isLongPaste("字".repeat(LONG_PASTE.chars + 1))).toBe(true);
    expect(isLongPaste("x\n".repeat(LONG_PASTE.lines - 1))).toBe(false);
    expect(isLongPaste("x\n".repeat(LONG_PASTE.lines))).toBe(true);
  });
});

describe("a draft as a message", () => {
  const draft: Draft = [
    { type: "text", text: "看：" },
    { type: "paste", id: "p", text: "很长\n的日志" },
    { type: "text", text: "和" },
    {
      type: "file",
      id: "f",
      name: "data.csv",
      contentType: "text/csv",
      size: 8,
    },
  ];

  it("keeps the order, a paste as its own text, files as attachments", () => {
    expect(messageParts(draft, (id) => (id === "f" ? csv : undefined))).toEqual(
      [
        { type: "text", text: "看：" },
        { type: "text", text: "很长\n的日志" },
        { type: "text", text: "和" },
        { type: "attachment", attachment: csv },
      ],
    );
  });

  it("waits for every file's upload", () => {
    expect(messageParts(draft, () => undefined)).toBeUndefined();
  });

  it("is blank without text or files", () => {
    expect(isBlank([{ type: "text", text: " \n" }])).toBe(true);
    expect(isBlank([draft[3]])).toBe(false);
  });

  it("drops a slash command's name, keeping what follows", () => {
    expect(
      afterCommand(
        [
          { type: "text", text: "/steer " },
          { type: "attachment", attachment: csv },
        ],
        "/steer",
      ),
    ).toEqual([{ type: "attachment", attachment: csv }]);
  });

  it("comes back as a draft to edit, long text folded again", () => {
    const long = "x\n".repeat(LONG_PASTE.lines + 1);
    const { draft: back, attachments } = draftOf([
      { type: "text", text: "短" },
      { type: "text", text: long },
      { type: "attachment", attachment: csv },
    ]);
    expect(back.map((p) => p.type)).toEqual(["text", "paste", "file"]);
    const file = back[2] as Extract<Draft[number], { type: "file" }>;
    expect(attachments[file.id]).toEqual(csv);
  });
});

describe("a file becomes a reference", () => {
  it("says where it is, so the agent can open it", () => {
    const withPath: Attachment = {
      ...csv,
      path: ".eta/uploads/20261017-data.csv",
    };
    const parts = messageParts(
      [
        {
          type: "file",
          id: "a1",
          name: "data.csv",
          contentType: "text/csv",
          size: 8,
        },
      ],
      () => withPath,
    );
    expect(parts?.[0]).toEqual({
      type: "text",
      text: "@.eta/uploads/20261017-data.csv",
    });
    expect(parts?.[1]?.type).toBe("attachment");
  });

  it("an upload with no path adds nothing to the text", () => {
    const parts = messageParts(
      [
        {
          type: "file",
          id: "a1",
          name: "data.csv",
          contentType: "text/csv",
          size: 8,
        },
      ],
      () => csv,
    );
    expect(parts).toEqual([{ type: "attachment", attachment: csv }]);
  });
});

describe("a long paste is a file too", () => {
  it("carries the path when the paste was written into the project", () => {
    const stored: Attachment = {
      ...csv,
      name: "pasted.txt",
      path: ".eta/uploads/20261017-pasted.txt",
    };
    const parts = messageParts(
      [{ type: "paste", id: "p1", text: "很多行" }],
      (id) => (id === "p1" ? stored : undefined),
    );
    expect(parts).toEqual([
      { type: "text", text: "@.eta/uploads/20261017-pasted.txt" },
      { type: "text", text: "很多行" },
    ]);
  });

  it("and is just text when the write did not happen", () => {
    const parts = messageParts(
      [{ type: "paste", id: "p1", text: "很多行" }],
      () => undefined,
    );
    expect(parts).toEqual([{ type: "text", text: "很多行" }]);
  });
});
