import type { RichNodeViewProps, TextViewInline } from "nsh/base";
import type { ShownPart, TextPlugin } from "../plugin";
import {
  DOC_NODES,
  lineCount,
  textToNodes,
} from "@eta/client-contracts/composer-doc";
import { signal } from "nsh";
import { defineExtension, insertContent, insertContentAt } from "nsh/base";
import { uiText } from "../../../i18n";
import { Chip, PastePreview } from "../chip";
import { oneStep } from "../step";
import { standIn, swapInline } from "../view-source";

/** Puts the folded paste back as its text, in its place: one undoable change. */
function unfold(props: RichNodeViewProps) {
  const pos = props.getPos();
  if (pos == null) return;
  props.editor.run(
    oneStep(
      insertContentAt(
        { from: pos, to: pos + 1 },
        textToNodes(String(props.node.attrs.text)),
      ),
    ),
  );
  props.editor.focus();
}

function PasteView(props: RichNodeViewProps) {
  const lines = () => lineCount(String(props.node.attrs.text));
  return (
    <Chip
      icon="lines"
      kind={uiText("pastedKind")}
      label={uiText("pastedLines", { count: lines() })}
      selected={props.selected}
      accessibilityLabel={uiText("unfoldPaste", { count: lines() })}
      onPress={() => unfold(props)}
      removeLabel={uiText("removePaste")}
      onRemove={() => props.deleteNode()}
    />
  );
}

/** A paste's text as a line's content: its lines with breaks between them, as written. */
function asLines(text: string): TextViewInline[] {
  return text
    .split("\n")
    .flatMap((line, at): TextViewInline[] => [
      ...(at ? [{ type: "break" } as const] : []),
      ...(line ? [{ type: "text", text: line } as const] : []),
    ]);
}

/** Folded pastes in one shown text: the block, its first lines on hover; a press opens it, in
 * its place, as the text it stands for (not read as Markdown, as it was never written as such). */
function shownPastes(): ShownPart {
  const opened = signal<ReadonlySet<string>>(new Set());
  return {
    touches: () => opened().size > 0,
    document: (document) =>
      opened().size
        ? swapInline(document, (node) =>
            node.type === "custom" &&
            node.name === DOC_NODES.paste &&
            opened().has(node.attributes?.id ?? "")
              ? asLines(node.text ?? "")
              : undefined,
          )
        : document,
    renderCustom: {
      [DOC_NODES.paste]: (node) => {
        const text = node.text ?? "";
        const lines = lineCount(text);
        const id = node.attributes?.id ?? "";
        return (
          <Chip
            icon="lines"
            kind={uiText("pastedKind")}
            label={uiText("pastedLines", { count: lines })}
            tooltip={<PastePreview text={text} />}
            accessibilityLabel={uiText("unfoldPaste", { count: lines })}
            onPress={() => opened.set(new Set([...opened(), id]))}
          />
        );
      },
    },
  };
}

/**
 * Long pastes fold, where the caret is, into one block ("pasted · 42 lines"): pressing it puts the
 * text back. It goes out as the text it stands for, its place recorded as a `PasteRange`
 * (`serialize`). Copied, it is that text (`renderText`), so a paste of it anywhere is the text,
 * and into this editor folds again. Shown, it is the same block: its first lines show on hover, a
 * press opens it in place.
 */
export function pasteBlock(): TextPlugin {
  return {
    name: "pasteBlock",
    view: {
      extensions: [standIn(DOC_NODES.paste)],
      shown: shownPastes,
    },
    editor: {
      extensions: [
        defineExtension({
          name: DOC_NODES.paste,
          node: {
            group: "inline",
            inline: true,
            atom: true,
            selectable: true,
            attrs: { id: { default: "" }, text: { default: "" } },
            renderText: "{text}",
            parseDOM: [
              {
                tag: "span[data-eta=paste]",
                getAttrs: { id: "data-id", text: "data-text" },
              },
            ],
            toDOM: [
              "span",
              {
                "data-eta": "paste",
                "data-id": { attr: "id" },
                "data-text": { attr: "text" },
              },
            ],
          },
          addNodeView: () => PasteView,
        }),
      ],
      paste(action, editor) {
        if (action.kind !== "block") return false;
        editor.session.run(
          oneStep(
            insertContent({
              type: DOC_NODES.paste,
              attrs: { id: crypto.randomUUID(), text: action.text },
            }),
          ),
        );
        return true;
      },
    },
  };
}
