import type {
  ClipboardAction,
  ClipboardInput,
  DocNode,
} from "@eta/client-contracts/composer-doc";
import type { JSX, ViewStyle } from "nsh";
import type {
  RichEditorFile,
  RichEditorSession,
  RichExtension,
  RichExtensionClass,
  RichNodeJSON,
  RichPluginSpec,
} from "nsh/base";
import { classifyClipboard } from "@eta/client-contracts/composer-doc";
import { cleanup, Clipboard, signal, View } from "nsh";
import {
  createRichEditor,
  defineExtension,
  RichEditor,
  RichEditorPlugin,
  setMeta,
} from "nsh/base";
import { uiText } from "../../i18n";
import { colors, fontFamily, Fonts, textFaces, textStyle } from "../theme";
import { refusedFile } from "./plugins/attachment";
import { LineRoom } from "./room";

// The composer's editor: nsh's RichEditor (a ProseMirror state in Rust, edited natively — typing,
// selection, input methods, undo) with the app's plugins on it. Each place that writes something
// (a chat, a task's comment box, the insert popover) makes one with the plugins it needs: its
// profile. The plugins are in ./plugins, one file each; this file only puts them together and
// routes the two things more than one plugin has a say in — a paste, and files.

/** What a plugin adds to the editor and what it does with it. */
export interface EtaPlugin {
  name: string;
  /** Extensions: node types (with their views), keys and kernel plugins, by priority. */
  extensions?: (RichExtension | RichExtensionClass)[];
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

/** A place's choice of plugins, and its first document. */
export interface EtaEditorProfile {
  plugins: EtaPlugin[];
  doc?: DocNode | null;
}

/** The editor the composer, the comment box and the popover hold: the session and its signals. */
export interface EtaEditorHandle {
  session: RichEditorSession;
  /** Moves with every change of the document. */
  revision: () => number;
  /** An input method is composing (its text is not in the document yet). */
  composing: () => boolean;
  focused: () => boolean;
  /** The editor box's width, for overlays that must stay inside it. */
  width: () => number;
  has: (name: string) => boolean;
  /** Sends files where a plugin takes them (the attachment plugin); false where none does. */
  addFiles: (files: File[]) => boolean;
  /** The document, as JSON. */
  doc: () => DocNode;
  /** Empties the document (after sending: one undoable change). */
  clear: () => void;
  focus: () => void;
  /** Called by `EtaEditor`. */
  view: {
    composing: (value: boolean) => void;
    focused: (value: boolean) => void;
    width: (value: number) => void;
    pasteFiles: (files: RichEditorFile[], uris: string[]) => void;
    dropFiles: (uris: string[]) => void;
  };
  plugins: EtaPlugin[];
}

function fileOf(file: RichEditorFile): File {
  return new File([file.data], file.name, { type: file.mime });
}

/** A local file a file manager copied or dragged in, read through its `file:` URL. */
async function readUri(uri: string): Promise<File> {
  const name = decodeURIComponent(uri.split("/").pop() || "file");
  const response = await fetch(uri);
  const blob = await response.blob();
  return new File([blob], name, { type: blob.type });
}

export function createEtaEditor(profile: EtaEditorProfile): EtaEditorHandle {
  const plugins = profile.plugins;
  const takesFiles = plugins.some((plugin) => plugin.files);
  const revision = signal(0);
  /** The handle, for the hooks the session calls once it exists. */
  const self: { handle?: EtaEditorHandle } = {};
  const composing = signal(false);
  const focused = signal(false);
  const width = signal(0);
  // One paste hook for every plugin: the clipboard rules decide what the paste is, then the
  // plugin that takes that kind of paste does it. A copy from an editor of ours (`data-pm-slice`,
  // its blocks in the HTML) goes in natively, so a copied block pastes as a block.
  const paste = new RichEditorPlugin("eta-paste").handlePaste(
    (_slice, clipboard) => {
      if (
        clipboard.html.includes("data-pm-slice") &&
        clipboard.html.includes("data-eta")
      )
        return false;
      return route({ text: clipboard.text, html: clipboard.html });
    },
  );
  const extensions = plugins.flatMap((plugin) => plugin.extensions ?? []);
  const session = createRichEditor({
    extensions: [
      ...extensions,
      defineExtension({
        name: "etaPaste",
        priority: 900,
        addProseMirrorPlugins: () => [paste],
      }),
    ],
    plugins: plugins.flatMap((plugin) => plugin.plugins ?? []),
    doc: (profile.doc as RichNodeJSON | null | undefined) ?? undefined,
  });
  function route(input: ClipboardInput): boolean {
    const action = classifyClipboard(input, { files: takesFiles });
    if (action.kind === "nothing") return true;
    for (const plugin of plugins)
      if (plugin.paste?.(action, self.handle!)) return true;
    // Nobody folds or attaches it: plain text, typed in as text (formatting never pastes).
    if (action.kind !== "files") {
      session.run(setMeta("closeHistory$", true));
      session.pasteText(action.text);
    }
    return true;
  }
  const addFiles = (files: File[]) =>
    plugins.some((plugin) => plugin.files?.(files, self.handle!));
  async function filesFromUris(uris: string[]) {
    const files: File[] = [];
    for (const uri of uris) {
      try {
        files.push(await readUri(uri));
      } catch {
        // A file the app may not read: a block that says so, not a paste that does nothing.
        const name = decodeURIComponent(uri.split("/").pop() || uri);
        files.push(refusedFile(name, uiText("fileUnreadable", { name })));
      }
    }
    return files;
  }
  const handle: EtaEditorHandle = {
    session,
    revision,
    composing,
    focused,
    width,
    plugins,
    has: (name) => plugins.some((plugin) => plugin.name === name),
    addFiles,
    doc: () => session.getJSON() as DocNode,
    clear: () =>
      session.setContent({ type: "doc", content: [{ type: "paragraph" }] }),
    focus: () => session.focus(),
    view: {
      composing: (value) => composing.set(value),
      focused: (value) => focused.set(value),
      width: (value) => width.set(value),
      pasteFiles(files, uris) {
        void (async () => {
          // A picture beside text (Word, Excel, a web page) is a copy of the text: the editor
          // reports only the files, so the text is read back from the clipboard to decide.
          let text = "";
          if (
            !uris.length &&
            files.every((file) => file.mime.startsWith("image/"))
          )
            text = await Clipboard.hasText()
              .then((has) => (has ? Clipboard.readText() : ""))
              .catch(() => "");
          const action = classifyClipboard(
            {
              text,
              files: files.map((file) => ({
                name: file.name,
                type: file.mime,
              })),
              uris,
            },
            { files: takesFiles },
          );
          if (action.kind === "files")
            addFiles([...files.map(fileOf), ...(await filesFromUris(uris))]);
          else route({ text });
        })();
      },
      dropFiles(uris) {
        if (takesFiles) void filesFromUris(uris).then(addFiles);
      },
    },
  };
  self.handle = handle;
  session.on("revision", ({ revision: value }) => revision.set(value));
  const stops = plugins.map((plugin) => plugin.setup?.(handle));
  cleanup(() => {
    for (const stop of stops) stop?.();
  });
  return handle;
}

/**
 * The editor's view: the text box, the plugins' notices above the text and their overlays (the
 * suggestion list) above the box. Sized by its parent; it grows with its text up to `maxHeight`.
 */
export function EtaEditor(props: {
  editor: EtaEditorHandle;
  label: string;
  placeholder?: string;
  editable?: boolean;
  autoFocus?: boolean;
  maxHeight?: number;
  minHeight?: number;
  /** The text's padding inside the box. */
  padding?: { top: number; bottom: number; left: number; right: number };
  variant?: "body" | "small";
  style?: ViewStyle;
}) {
  const c = colors();
  const fonts = Fonts();
  const type = textFaces();
  const face = () => type(props.variant ?? "body");
  const pad = () => props.padding ?? { top: 8, bottom: 8, left: 8, right: 8 };
  const editor = props.editor;
  const room = signal(0);
  return (
    <View
      onLayout={({ bounds }) => {
        editor.view.width(bounds.size.width);
        room.set(bounds.size.width - pad().left - pad().right);
      }}
      style={{ position: "relative", ...props.style }}
    >
      <Each of={editor.plugins.filter((plugin) => plugin.overlay)}>
        {(plugin) => plugin().overlay!()}
      </Each>
      <Each of={editor.plugins.filter((plugin) => plugin.header)}>
        {(plugin) => plugin().header!()}
      </Each>
      <LineRoom.Provider value={room}>
        <RichEditor
          editor={editor.session}
          testID="eta-editor"
          accessibilityLabel={props.label}
          placeholder={props.placeholder}
          editable={props.editable ?? true}
          autoFocus={props.autoFocus}
          onFocus={() => editor.view.focused(true)}
          onBlur={() => editor.view.focused(false)}
          onCompositionChange={({ composing }) =>
            editor.view.composing(composing)
          }
          onPasteFiles={({ paste }) =>
            editor.view.pasteFiles(paste.files, paste.uris)
          }
          onFileDrop={({ uris }) => editor.view.dropFiles(uris)}
          styles={{
            root: {
              maxHeight: props.maxHeight,
              minHeight: props.minHeight,
            },
            content: {
              paddingTop: pad().top,
              paddingBottom: pad().bottom,
              paddingLeft: pad().left,
              paddingRight: pad().right,
              color: c().ink,
              fontFamily: fontFamily(fonts().interface),
              ...textStyle(face(), "prose"),
            },
            placeholder: { color: c().muted },
            caret: { backgroundColor: c().ink },
            selection: { backgroundColor: c().selected },
            composition: { textDecorationLine: "underline" },
          }}
        />
      </LineRoom.Provider>
    </View>
  );
}
