import type { Draft } from "@/lib/composer";
import { afterEach, describe, expect, it } from "@rstest/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LONG_PASTE } from "@/lib/composer";
import { ComposerEditor } from "./composer-editor";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let draft: Draft = [];

async function render(value: Draft = []) {
  draft = value;
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    createRoot(container).render(
      <ComposerEditor
        value={value}
        onChange={(next) => (draft = next)}
        onKeyDown={() => {}}
        placeholder="发消息"
      />,
    );
  });
  const editor = container.querySelector<HTMLElement>("[contenteditable]")!;
  await act(async () => editor.focus());
  return editor;
}

/** A paste of these clipboard types. */
async function paste(
  editor: HTMLElement,
  data: Record<string, string>,
  files: File[] = [],
) {
  const clipboardData = {
    types: [...Object.keys(data), ...(files.length ? ["Files"] : [])],
    files,
    items: [],
    getData: (type: string) => data[type] ?? "",
  };
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: clipboardData });
  await act(async () => {
    editor.dispatchEvent(event);
  });
}

describe("pasting into the composer", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("folds long text into one block holding all of it", async () => {
    const editor = await render([{ type: "text", text: "看：" }]);
    const long = Array.from(
      { length: LONG_PASTE.lines + 1 },
      (_, i) => `第 ${i} 行`,
    ).join("\r\n");
    await paste(editor, { "text/plain": long, "text/html": "<b>x</b>" });
    expect(draft).toEqual([
      { type: "text", text: "看：" },
      {
        type: "paste",
        id: expect.any(String),
        text: long.replaceAll("\r\n", "\n"),
      },
    ]);
    expect(editor.textContent).toContain(
      `粘贴文本 · ${long.replaceAll("\r\n", "\n").length} 字符`,
    );
  });

  it("never puts a page's HTML in", async () => {
    const editor = await render();
    await paste(editor, {
      "text/plain": "短的",
      "text/html": "<img src=x onerror=alert(1)><script>alert(2)</script>短的",
    });
    expect(editor.querySelector("img, script, b")).toBeNull();
  });

  it("leaves a pasted file alone: the host has nowhere to put an attachment", async () => {
    const editor = await render();
    const shot = new File(["png"], "image.png", { type: "image/png" });
    await paste(editor, { "text/html": '<img src="blob:x">' }, [shot]);
    expect(draft).toEqual([]);
    expect(editor.querySelector("img")).toBeNull();
  });

  it("shows a draft set from outside, blocks and line breaks included", async () => {
    const editor = await render([
      { type: "text", text: "一\n二" },
      { type: "paste", id: "p", text: "x".repeat(2000) },
    ]);
    expect(
      editor.querySelectorAll("br:not([data-lexical-managed-linebreak])")
        .length,
    ).toBe(1);
    expect(editor.textContent).toContain("粘贴文本 · 2000 字符");
  });
});
