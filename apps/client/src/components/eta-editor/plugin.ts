import type { ClipboardAction } from "@eta/client-contracts/composer-doc";
import type { JSX } from "nsh";
import type {
  MarkdownExtension,
  RichEditorPlugin,
  RichExtension,
  RichExtensionClass,
  RichPluginSpec,
  TextViewCodeBlock,
  TextViewCustomNode,
} from "nsh/base";
import type { EtaEditorHandle } from "./editor";
import type { TextParts, TextStyles, TextTheme } from "./look";

/** What a plugin adds to editing (nsh `RichEditor`). */
interface EditorPart {
  /** Formatted text (Markdown as you type): pastes of Markdown and of code are read as such. */
  rich?: boolean;
  /** What it draws in the text's own layer (a code block's header), scrolling with it. */
  contentLayer?: (editor: EtaEditorHandle) => JSX.Element;
  /** Extensions: node types (with their views), keys and kernel plugins, by priority; made per
   * editor when they depend on it (`rich`: keys for nodes only formatted text has). */
  extensions?:
    | (RichExtension | RichExtensionClass)[]
    | ((editor: { rich: boolean }) => (RichExtension | RichExtensionClass)[]);
  /** Kernel plugins after the extensions'. */
  plugins?: (RichPluginSpec | RichEditorPlugin)[];
  /** Takes a paste the clipboard rules sorted, returning whether it did. */
  paste?: (action: ClipboardAction, editor: EtaEditorHandle) => boolean;
  /** Takes files (pasted, dropped, picked): whether it did. */
  files?: (files: File[], editor: EtaEditorHandle) => boolean;
  /** Runs once the editor exists; what it returns runs when the editor goes. */
  setup?: (editor: EtaEditorHandle) => void | (() => void);
  /** What it draws over the editor (a suggestion list), placed by the editor's box. */
  overlay?: () => JSX.Element;
  /** What it draws above the text, inside the box (a notice). */
  header?: () => JSX.Element;
}

/** What a view's drawings get: the theme, and the look of the text they are in. */
export interface ViewContext {
  theme: TextTheme;
  parts: TextParts;
  /** The text's size. */
  variant: "body" | "small";
}

/** What a plugin adds where the text is shown (nsh `TextView`). */
export interface ViewPart {
  /** Its syntax in the Markdown, read as custom nodes (a mention's stand-in: `standIn`). */
  extensions?: MarkdownExtension[];
  /** Draws its custom nodes, by name. */
  renderCustom?: Record<
    string,
    (node: TextViewCustomNode, view: ViewContext) => JSX.Element
  >;
  /** Draws code blocks (one plugin does). */
  renderCodeBlock?: (code: TextViewCodeBlock, view: ViewContext) => JSX.Element;
}

/**
 * A text plugin: what it adds to writing a text (`editor`), to showing it (`view`), and the look of
 * both (`styles`: the parts both draw alike, and each side's own). A plugin only for writing (the
 * send keys, the draft store, the length limit) has only `editor`.
 */
export interface TextPlugin {
  name: string;
  editor?: EditorPart;
  view?: ViewPart;
  styles?: TextStyles;
}
