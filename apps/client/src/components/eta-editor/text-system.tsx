import type {
  DocNode,
  SerializedDraft,
} from "@eta/client-contracts/composer-doc";
import type { ViewStyle } from "nsh";
import type { EtaEditorHandle, EtaPlugin } from "./editor";
import type { StoredText } from "./markdown";
import { untracked } from "nsh";
import { createEtaEditor, EtaEditor } from "./editor";
import { docToStoredMarkdown, markdownToDoc } from "./markdown";

/**
 * A text plugin: what it adds to editing (nodes and their views, keys, paste and file handling,
 * a list over the box) and the look of it (`styles`: one set for the editor and for the same text
 * shown read-only, the editor's own parts apart). Its nodes' views draw it in both: a read-only
 * view is the same editor, not editable.
 */
export type TextPlugin = EtaPlugin;

/** What a place's text is made with: its plugins, and Markdown in and out. */
export interface TextSystem {
  plugins: readonly TextPlugin[];
  /** An editor with the system's plugins and the place's own (a draft store, the send keys). */
  createEditor: (options?: {
    plugins?: TextPlugin[];
    /** The first document: a saved draft. */
    doc?: DocNode | null;
    /** Or the first text, as kept (Markdown, with its pastes and mentions). */
    text?: StoredText;
  }) => EtaEditorHandle;
  /** The editor's view (`EtaEditor`). */
  Editor: typeof EtaEditor;
  /** Text as kept, shown with the system's plugins: the editor, not editable. */
  View: (props: {
    text: StoredText;
    label: string;
    variant?: "body" | "small";
    style?: ViewStyle;
  }) => ReturnType<typeof EtaEditor>;
  /** Markdown (with its pastes and mentions) as a document. */
  read: (text: StoredText) => DocNode;
  /** A document as Markdown to keep or send. */
  write: (doc: DocNode) => SerializedDraft;
}

/**
 * The text system: one set of plugins for writing a text and for showing it. Markdown is what is
 * kept (`write`, read back with `read`); the editor's document lives only while it is edited.
 */
export function createTextSystem(plugins: TextPlugin[]): TextSystem {
  const names = new Set<string>();
  for (const plugin of plugins) {
    if (names.has(plugin.name))
      throw new Error(`text plugin ${plugin.name} is given twice`);
    names.add(plugin.name);
  }
  const read = (text: StoredText) => markdownToDoc(text);
  const createEditor: TextSystem["createEditor"] = (options = {}) =>
    createEtaEditor({
      plugins: [...plugins, ...(options.plugins ?? [])],
      doc: options.doc ?? (options.text ? read(options.text) : undefined),
    });
  return {
    plugins,
    createEditor,
    Editor: EtaEditor,
    View(props) {
      const editor = untracked(() => createEditor({ text: props.text }));
      return (
        <EtaEditor
          editor={editor}
          label={props.label}
          editable={false}
          variant={props.variant}
          padding={{ top: 0, bottom: 0, left: 0, right: 0 }}
          style={props.style}
        />
      );
    },
    read,
    write: docToStoredMarkdown,
  };
}
