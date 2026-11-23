import type {
  DocNode,
  SerializedDraft,
} from "@eta/client-contracts/composer-doc";
import type { JSX, ViewStyle } from "nsh";
import type { TextViewSelectionEvent } from "nsh/base";
import type { EtaEditorHandle } from "./editor";
import type { StoredText } from "./markdown";
import type { TextPlugin, ViewContext, ViewPart } from "./plugin";
import type { ShownText } from "./view-source";
import { Text, View } from "nsh";
import { TextView } from "nsh/base";
import { createEtaEditor, EtaEditor } from "./editor";
import { baseText, partsOf, useTextTheme, viewLook } from "./look";
import { docToStoredMarkdown, markdownToDoc } from "./markdown";
import { lineEnds, viewDocument, viewSource } from "./view-source";

export type { TextPlugin } from "./plugin";

/** What the view of a text takes. */
interface TextViewProps {
  /** The text as kept (Markdown, with its pastes and mentions), and the files sent with it. */
  text: ShownText;
  /** The place's own plugins (mentions, files), as `createEditor` takes them. */
  plugins?: TextPlugin[];
  label?: string;
  variant?: "body" | "small";
  /** The text is still being written (an agent's reply): what its end leaves open is shown
   * closed, and only the block being written is drawn again. */
  streaming?: boolean;
  /** Its text can be selected and copied (default true). */
  selectable?: boolean;
  /** The selection changed (to quote a part of it). */
  onSelectionChange?: (event: TextViewSelectionEvent) => void;
  style?: ViewStyle;
}

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
  /** The editor's view. */
  Editor: typeof EtaEditor;
  /** Text as kept, shown (nsh `TextView`) with the view half of the system's plugins. */
  View: (props: TextViewProps) => JSX.Element;
  /** Markdown (with its pastes and mentions) as a document. */
  read: (text: StoredText) => DocNode;
  /** A document as Markdown to keep or send. */
  write: (doc: DocNode) => SerializedDraft;
}

/** The view half of `plugins`: their syntax, their drawings by node name, the code blocks'. */
function viewOf(plugins: TextPlugin[]) {
  const extensions = [
    lineEnds,
    ...plugins.flatMap((plugin) => plugin.view?.extensions ?? []),
  ];
  const renderers: NonNullable<ViewPart["renderCustom"]> = {};
  for (const plugin of plugins)
    Object.assign(renderers, plugin.view?.renderCustom);
  const codeBlock = plugins.find((plugin) => plugin.view?.renderCodeBlock)?.view
    ?.renderCodeBlock;
  return { plugins, extensions, renderers, codeBlock };
}

/**
 * The text system: one set of plugins for writing a text (nsh `RichEditor`) and for showing it
 * (nsh `TextView`), each plugin saying both halves and their look. Markdown is what is kept
 * (`write`, read back with `read`); the editor's document lives only while it is edited. Places
 * use only this: neither editor's nor view's API.
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
      const theme = useTextTheme();
      const own = viewOf([...plugins, ...(props.plugins ?? [])]);
      const { extensions, renderers, codeBlock } = own;
      const context = (): ViewContext => ({
        theme: theme(),
        parts: partsOf(own.plugins, theme()),
        variant: props.variant ?? "body",
      });
      const document = () => {
        const { markdown, stands } = viewSource(props.text);
        return viewDocument(
          TextView.parse(
            markdown,
            { html: false, streaming: props.streaming },
            extensions,
          ),
          stands,
        );
      };
      return (
        <View
          accessibilityLabel={props.label}
          testID="eta-text"
          style={props.style}
        >
          <TextView
            document={document()}
            options={{ html: false, streaming: props.streaming }}
            selectable={props.selectable ?? true}
            onSelectionChange={props.onSelectionChange}
            links="open"
            styles={{
              ...viewLook(own.plugins, theme()),
              // A column of blocks with nothing between them, as the editor's.
              root: { ...baseText(theme(), props.variant), gap: 0 },
              paragraph: { marginTop: 0, marginBottom: 0 },
            }}
            renderCustom={(node) =>
              renderers[node.name]?.(node, context()) ?? (
                <Text>{node.text ?? ""}</Text>
              )
            }
            renderCodeBlock={
              codeBlock ? (code) => codeBlock(code, context()) : undefined
            }
            codeBlockActions={codeBlock ? undefined : [{ id: "copy" }]}
          />
        </View>
      );
    },
    read,
    write: docToStoredMarkdown,
  };
}
