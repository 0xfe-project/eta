import type {
  DocNode,
  SerializedDraft,
} from "@eta/client-contracts/composer-doc";
import type { JSX, ViewStyle } from "nsh";
import type {
  TextViewDocument,
  TextViewSelectionEvent,
  TextViewStyles,
} from "nsh/base";
import type { EtaEditorHandle } from "./editor";
import type { TextTheme } from "./look";
import type { StoredText } from "./markdown";
import type { TextPlugin, ViewContext, ViewPart } from "./plugin";
import type { ShownText } from "./view-source";
import { computed, Text, untracked, View } from "nsh";
import { TextView } from "nsh/base";
import { createEtaEditor, EtaEditor } from "./editor";
import { baseText, partsOf, useTextTheme, viewLook } from "./look";
import { docToStoredMarkdown, markdownToDoc } from "./markdown";
import { selectedText } from "./selected-text";
import { selectShown, takeShownCopies } from "./shown-selection";
import {
  lineEnds,
  neededExtensions,
  readsDirectly,
  standNode,
  viewDocument,
  viewSource,
} from "./view-source";

const EMPTY: TextViewDocument = { blocks: [] };

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
  onSelectionChange?: (event: TextSelection) => void;
  style?: ViewStyle;
}

/** A selection in a shown text. */
export interface TextSelection extends TextViewSelectionEvent {
  /** The selected text as the text reads: a mention is `@Ada` (a platform's selection leaves
   * such blocks out), lines are the text's own (not where it wrapped), no list markers. */
  read: () => string;
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
  const actions = plugins.find((plugin) => plugin.view?.codeBlockActions)?.view;
  return {
    plugins,
    extensions,
    renderers,
    codeBlockActions: actions?.codeBlockActions,
  };
}

/** The view's styles for a theme, made once per theme, plugins and size: a transcript shows many
 * texts. */
const looks = new WeakMap<object, Map<string, TextViewStyles>>();
function styles(
  plugins: readonly TextPlugin[],
  theme: TextTheme,
  variant: "body" | "small",
): TextViewStyles {
  let byTheme = looks.get(theme.colors);
  if (!byTheme) {
    byTheme = new Map();
    looks.set(theme.colors, byTheme);
  }
  const key = [
    theme.font,
    theme.mono,
    variant,
    ...plugins.map((plugin) => plugin.name),
  ].join("|");
  let look = byTheme.get(key);
  if (!look) {
    look = {
      ...viewLook(plugins, theme),
      // A column of blocks with nothing between them, as the editor's.
      root: { ...baseText(theme, variant), gap: 0 },
      paragraph: { marginTop: 0, marginBottom: 0 },
    };
    byTheme.set(key, look);
  }
  return look;
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
      const { extensions } = own;
      // Read as it is used, so a drawing follows the theme.
      const context: ViewContext = {
        get theme() {
          return theme();
        },
        get parts() {
          return partsOf(own.plugins, theme());
        },
        get variant() {
          return props.variant ?? "body";
        },
      };
      // Each plugin's part in this text, made once, here (where contexts can be read).
      const shown = own.plugins.flatMap((plugin) => {
        const part = plugin.view?.shown?.(context);
        return part ? [part] : [];
      });
      const renderers = { ...own.renderers };
      for (const part of shown)
        for (const [name, draw] of Object.entries(part.renderCustom ?? {}))
          renderers[name] = (node) => draw(node);
      /** The text as the view reads it: its Markdown, and what its blocks stand for. */
      const source = computed(() => {
        let text = props.text;
        for (const part of shown) if (part.source) text = part.source(text);
        return viewSource(text);
      });
      /** Whether the view reads the Markdown itself (as it does fastest), its blocks taken back
       * as they are drawn: no plugin has anything to change in this text's document. */
      const direct = computed(() => {
        const current = source();
        return (
          readsDirectly(current.markdown, current.stands) &&
          shown.every((part) =>
            part.document || part.after
              ? part.touches?.(current) === false
              : true,
          )
        );
      });
      /** The document as read: its blocks with their attributes, before plugins arrange it. */
      const read = computed(() => {
        if (direct()) return EMPTY;
        const { markdown, stands } = source();
        return viewDocument(
          TextView.parse(
            markdown,
            { html: false, streaming: props.streaming },
            extensions,
          ),
          stands,
        );
      });
      const document = computed(() => {
        if (direct()) return undefined;
        let doc = read();
        for (const part of shown) if (part.document) doc = part.document(doc);
        return doc;
      });
      function readSelection(text: string) {
        const { markdown, stands } = source();
        const whole = direct()
          ? viewDocument(
              TextView.parse(markdown, { html: false }, extensions),
              stands,
            )
          : read();
        return selectedText(text, whole) ?? text;
      }
      // This text's selection, for an editor that keeps the focus meanwhile (./shown-selection).
      const self = {};
      takeShownCopies(self);
      return (
        <View
          accessibilityLabel={props.label}
          testID="eta-text"
          style={props.style}
        >
          <TextView
            markdown={direct() ? source().markdown : undefined}
            document={document()}
            extensions={
              direct()
                ? neededExtensions(extensions, source().stands)
                : undefined
            }
            options={{ html: false, streaming: props.streaming }}
            selectable={props.selectable ?? true}
            onSelectionChange={(event) => {
              const read = () => untracked(() => readSelection(event.text));
              selectShown(self, event.text, read);
              props.onSelectionChange?.({ ...event, read });
            }}
            links="open"
            styles={styles(own.plugins, theme(), props.variant ?? "body")}
            renderCustom={(read) => {
              const node = direct()
                ? standNode(read, untracked(source).stands)
                : read;
              return (
                renderers[node.name]?.(node, context) ?? (
                  <Text>{node.text ?? ""}</Text>
                )
              );
            }}
            codeBlockActions={own.codeBlockActions ?? [{ id: "copy" }]}
          />
          {shown.flatMap((part) => (part.after ? [part.after(read)] : []))}
        </View>
      );
    },
    read,
    write: docToStoredMarkdown,
  };
}
