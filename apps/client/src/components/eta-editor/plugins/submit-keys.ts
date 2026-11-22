import type { RichCommand } from "nsh/base";
import type { EtaEditorHandle, EtaPlugin } from "../editor";
import { effect } from "nsh";
import {
  chain,
  command,
  defineExtension,
  deleteRange,
  first,
  keymap,
  liftListItem,
  RichEditorPlugin,
  setBlockType,
  splitListItem,
} from "nsh/base";

interface Parent {
  pos: number;
  start: number;
  node: { textContent?: string; content?: { text?: string }[] };
}

const textOf = (found: Parent) =>
  found.node.textContent ??
  (found.node.content ?? []).map((child) => child.text ?? "").join("");

/** A new item in a list: on an empty item, out of the list. */
const listLine: RichCommand = first([
  splitListItem("listItem"),
  splitListItem("taskItem"),
  liftListItem("listItem"),
  liftListItem("taskItem"),
]);

/** A new line where the caret is: in code a line of code, in a list an item, else a paragraph. */
const newLine: RichCommand = first([
  command("newlineInCode"),
  listLine,
  command("liftEmptyBlock"),
  command("splitBlock"),
]);

/** ⏎ in a code block: a new line; on the second empty line at its end, out of the block. */
function codeLine(editor: EtaEditorHandle, block: Parent): boolean {
  const text = textOf(block);
  const end = block.start + text.length;
  const caret = (editor.session.selection as { head?: number }).head;
  if (caret === end && text.endsWith("\n\n"))
    return editor.session.run(
      chain([deleteRange({ from: end - 2, to: end }), command("exitCode")]),
    );
  return editor.session.run(command("newlineInCode"));
}

/** A paragraph that is only a fence (```` ```ts ````) as an empty code block of that language. */
function fence(editor: EtaEditorHandle): boolean {
  const found = editor.session.findParentNode("paragraph") as Parent | null;
  if (!found) return false;
  const text = textOf(found);
  const match = /^```([\w#+.-]*)$/.exec(text);
  if (!match) return false;
  return editor.session.run(
    chain([
      deleteRange({ from: found.start, to: found.start + text.length }),
      setBlockType("codeBlock", { language: match[1] || null }),
    ]),
  );
}

/**
 * What ⏎ does in formatted text before it sends: inside a code block a new line (twice on an
 * empty line leaves the block), inside a list a new item (on an empty one, out of the list), and
 * on a line that is only a fence the code block. Whether it did something.
 */
function enterInPlace(editor: EtaEditorHandle): boolean {
  if (!editor.rich) return false;
  const session = editor.session;
  const code = session.findParentNode("codeBlock") as Parent | null;
  if (code) return codeLine(editor, code);
  if (session.findParentNode("listItem") || session.findParentNode("taskItem"))
    return session.run(listLine);
  return fence(editor);
}

/**
 * ⏎ sends, ⇧⏎ starts a new line. In formatted text ⏎ is the line's own inside a list (a new
 * item; on an empty one, out of the list) and a code block (a new line; ⌘⏎, or ⏎ on a second
 * empty line at its end, leaves it), and ⏎ on a line that is only a fence makes the code block.
 * Enter is always this plugin's, on every platform, so what it does never depends on the
 * platform's own Enter (an Android keyboard's does nothing in a list). While an input method
 * composes, its Enter is the input method's (it commits the text) and never reaches here on the
 * platforms we checked — `editor.composing` is checked as well, so a platform that does pass it
 * on still does not send. Escape is taken only while `escape` says there is something for it to
 * do (stopping the replies under an empty box).
 */
export function submitKeys(options: {
  onSubmit: () => void;
  /** Whether Escape is this plugin's now, and what it does. */
  escape?: () => (() => void) | undefined;
}): EtaPlugin {
  let handle: EtaEditorHandle | undefined;
  const enter = new RichEditorPlugin("submitKeys").captureKeys(
    ["Enter"],
    () => {
      if (!handle || handle.session.composing || handle.composing()) return;
      if (enterInPlace(handle)) return;
      options.onSubmit();
    },
  );
  enter.capturing = true;
  let onEscape: (() => void) | undefined;
  const escape = new RichEditorPlugin("escapeKey").captureKeys(["Escape"], () =>
    onEscape?.(),
  );
  return {
    name: "submitKeys",
    extensions: ({ rich }) => [
      defineExtension({
        name: "submitKeys",
        // Above the base keymap (Enter splits the paragraph there), below the suggestion list.
        priority: 1000,
        addProseMirrorPlugins: () => [
          enter,
          escape,
          keymap(
            rich
              ? {
                  "Shift-Enter": newLine,
                  // Out of a code block; elsewhere a new line, as ⇧⏎.
                  "Mod-Enter": first([command("exitCode"), newLine]),
                }
              : { "Shift-Enter": command("splitBlock") },
          ),
        ],
      }),
    ],
    setup(editor) {
      handle = editor;
      effect(() => {
        onEscape = options.escape?.();
        escape.capturing = !!onEscape;
      });
    },
  };
}
