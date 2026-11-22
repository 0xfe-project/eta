import type { RichNodeViewProps } from "nsh/base";
import type { EtaPlugin } from "../editor";
import {
  DOC_NODES,
  lineCount,
  textToNodes,
} from "@eta/client-contracts/composer-doc";
import { defineExtension, insertContent, insertContentAt } from "nsh/base";
import { uiText } from "../../../i18n";
import { Chip } from "../chip";
import { oneStep } from "../step";

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

/**
 * Long pastes fold, where the caret is, into one block ("pasted · 42 lines"): pressing it puts the
 * text back. It goes out as the text it stands for, its place recorded as a `PasteRange`
 * (`serialize`). Copied, it is that text (`renderText`), so a paste of it anywhere is the text,
 * and into this editor folds again.
 */
export function pasteBlock(): EtaPlugin {
  return {
    name: "pasteBlock",
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
  };
}
