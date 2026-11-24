import type {
  ClipboardInput,
  DocNode,
} from "@eta/client-contracts/composer-doc";
import type { ViewStyle } from "nsh";
import type { RichEditorFile, RichEditorSession, RichNodeJSON } from "nsh/base";
import type { TextPlugin } from "./plugin";
import { MAX_ATTACHMENT_BYTES } from "@eta/client-contracts";
import { classifyClipboard } from "@eta/client-contracts/composer-doc";
import { cleanup, Clipboard, effect, signal, View } from "nsh";
import {
  createRichEditor,
  defineExtension,
  insertContent,
  insertContentAt,
  RichEditor,
  RichEditorPlugin,
  setMeta,
} from "nsh/base";
import { uiText } from "../../i18n";
import { colors, densityDefaults } from "../theme";
import { nameOfUri, readUri } from "./local-file";
import { baseText, editorLook, useTextTheme } from "./look";
import { asRich, markdownToDoc } from "./markdown";
import { refusedFile, tooLarge } from "./plugins/attachment";
import { LineRoom } from "./room";
import { selectionMade, shownSelection } from "./shown-selection";

// The composer's editor: nsh's RichEditor (a ProseMirror state in Rust, edited natively — typing,
// selection, input methods, undo) with the app's plugins on it. Each place that writes something
// (a chat, a task's comment box, the insert popover) makes one with the plugins it needs: its
// profile. The plugins are in ./plugins, one file each; this file only puts them together and
// routes the two things more than one plugin has a say in — a paste, and files.

/** A place's choice of plugins, and its first document. */
export interface EtaEditorProfile {
  plugins: TextPlugin[];
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
  /** Moves each time the text is laid out again (blocks' boxes, `nodeRect`, are new). */
  laidOut: () => number;
  has: (name: string) => boolean;
  /** Formatted text (a `rich` plugin is on). */
  rich: boolean;
  /** Sends files where a plugin takes them (the attachment plugin); false where none does. */
  addFiles: (files: File[]) => boolean;
  /** The document, as JSON. */
  doc: () => DocNode;
  /** Empties the document (after sending: one undoable change). */
  clear: () => void;
  /** Puts `doc` in place of the document. */
  setDoc: (doc: DocNode) => void;
  /** Puts blocks in where the caret is (`at` omitted) or at a position (0: before everything). */
  insert: (blocks: DocNode[], at?: number) => void;
  /** Calls `listener` on each change of the document; returns what stops it. */
  onChange: (listener: () => void) => () => void;
  focus: () => void;
  /** Called by `EtaEditor`. */
  view: {
    composing: (value: boolean) => void;
    focused: (value: boolean) => void;
    width: (value: number) => void;
    laidOut: () => void;
    pasteFiles: (files: RichEditorFile[], uris: string[]) => void;
    dropFiles: (uris: string[]) => void;
  };
  plugins: TextPlugin[];
}

function fileOf(file: RichEditorFile): File {
  return new File([file.data], file.name, { type: file.mime });
}

export function createEtaEditor(profile: EtaEditorProfile): EtaEditorHandle {
  const plugins = profile.plugins;
  const takesFiles = plugins.some((plugin) => plugin.editor?.files);
  const rich = plugins.some((plugin) => plugin.editor?.rich);
  const revision = signal(0);
  /** The handle, for the hooks the session calls once it exists. */
  const self: { handle?: EtaEditorHandle } = {};
  const composing = signal(false);
  const focused = signal(false);
  const width = signal(0);
  const laidOut = signal(0);
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
  // ⌘C copies what is selected in a shown text (a reply above the composer) when that was
  // selected after anything here: the editor keeps the focus while the user selects there, and on
  // macOS the key comes here, where nsh copies only the editor's own selection
  // (./shown-selection). 0: nothing is selected here.
  const ownSelection = signal(0);
  const copyAround = new RichEditorPlugin("eta-copy-around").captureKeys(
    ["Mod-c"],
    () => {
      const shown = shownSelection();
      if (shown) void Clipboard.writeText(shown.read()).catch(() => {});
    },
  );
  effect(() => {
    const shown = shownSelection();
    copyAround.capturing = !!shown && shown.made > ownSelection();
  });
  const extensions = plugins.flatMap((plugin) => {
    const own = plugin.editor?.extensions;
    return typeof own === "function" ? own({ rich }) : (own ?? []);
  });
  const session = createRichEditor({
    extensions: [
      ...extensions,
      defineExtension({
        name: "etaPaste",
        priority: 900,
        addProseMirrorPlugins: () => [paste],
      }),
      defineExtension({
        name: "etaCopyAround",
        // Above the base keymap, as the send keys (a plugin's own keys come first).
        priority: 1000,
        addProseMirrorPlugins: () => [copyAround],
      }),
    ],
    plugins: plugins.flatMap((plugin) => plugin.editor?.plugins ?? []),
    doc: (profile.doc as RichNodeJSON | null | undefined) ?? undefined,
  });
  function route(input: ClipboardInput): boolean {
    const action = classifyClipboard(input, { files: takesFiles, rich });
    if (action.kind === "nothing") return true;
    for (const plugin of plugins)
      if (plugin.editor?.paste?.(action, self.handle!)) return true;
    if (action.kind === "markdown") {
      // Markdown, formatted: its blocks where the caret is, one undo step.
      const doc = markdownToDoc({ text: action.text });
      session.run(setMeta("closeHistory$", true));
      session.insertContent((doc.content ?? []).map(asRich) as RichNodeJSON[]);
      return true;
    }
    // Nobody folds or attaches it: plain text, typed in as text (formatting never pastes).
    if (action.kind !== "files") {
      session.run(setMeta("closeHistory$", true));
      session.pasteText(action.text);
    }
    return true;
  }
  const addFiles = (files: File[]) =>
    plugins.some((plugin) => plugin.editor?.files?.(files, self.handle!));
  async function filesFromUris(uris: string[]) {
    const files: File[] = [];
    for (const uri of uris) {
      const name = nameOfUri(uri);
      try {
        const read = await readUri(uri, MAX_ATTACHMENT_BYTES);
        // Too large to send, or a folder: its bytes stay on disk, its block says why.
        files.push(
          read.kind === "file"
            ? read.file
            : refusedFile(
                name,
                read.kind === "folder"
                  ? uiText("fileIsFolder", { name })
                  : tooLarge(name),
              ),
        );
      } catch (error) {
        // A file the app may not read: a block that says so, not a paste that does nothing.
        console.warn(`eta: could not read ${uri}`, error);
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
    laidOut,
    plugins,
    has: (name) => plugins.some((plugin) => plugin.name === name),
    rich,
    addFiles,
    doc: () => session.getJSON() as DocNode,
    clear: () =>
      session.setContent({ type: "doc", content: [{ type: "paragraph" }] }),
    setDoc: (doc) => session.setContent(asRich(doc)),
    insert: (blocks, at) =>
      void session.run(
        at === undefined
          ? insertContent(blocks.map(asRich))
          : insertContentAt(at, blocks.map(asRich)),
      ),
    onChange: (listener) => session.on("revision", listener),
    focus: () => session.focus(),
    view: {
      composing: (value) => composing.set(value),
      focused: (value) => focused.set(value),
      width: (value) => width.set(value),
      laidOut: () => laidOut.set(laidOut() + 1),
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
            { files: takesFiles, rich },
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
  session.on("selectionUpdate", () => {
    const { type, anchor, head } = session.selection;
    ownSelection.set(type === "text" && anchor === head ? 0 : selectionMade());
  });
  const stops = plugins.map((plugin) => plugin.editor?.setup?.(handle));
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
  /**
   * Its text clipped to the box: what scrolls inside it is not counted in the size of a scroll
   * view around it (a fixed-height box in a dialog's scroll; #290's lesson for a multiline field).
   */
  clip?: boolean;
  /** The text's padding inside the box. */
  padding?: { top: number; bottom: number; left: number; right: number };
  /** The text's role; the density's (`body` in regular) by default. */
  variant?: "body" | "small";
  style?: ViewStyle;
}) {
  const c = colors();
  const density = densityDefaults();
  const theme = useTextTheme();
  /** The plugins' styles, over one another in their order. */
  const looks = () => editorLook(props.editor.plugins, theme());
  const pad = () => props.padding ?? { top: 8, bottom: 8, left: 8, right: 8 };
  const editor = props.editor;
  const room = signal(0);
  const layers = editor.plugins.filter((plugin) => plugin.editor?.contentLayer);
  return (
    <View
      onLayout={({ bounds }) => {
        editor.view.width(bounds.size.width);
        room.set(bounds.size.width - pad().left - pad().right);
      }}
      style={{ position: "relative", ...props.style }}
    >
      <Each of={editor.plugins.filter((plugin) => plugin.editor?.overlay)}>
        {(plugin) => plugin().editor!.overlay!()}
      </Each>
      <Each of={editor.plugins.filter((plugin) => plugin.editor?.header)}>
        {(plugin) => plugin().editor!.header!()}
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
          onContentSizeChange={() => editor.view.laidOut()}
          contentLayer={
            layers.length ? (
              <Each of={layers}>
                {(plugin) => plugin().editor!.contentLayer!(editor)}
              </Each>
            ) : undefined
          }
          classes={looks().classes}
          styles={{
            ...looks().own,
            nodes: looks().nodes,
            marks: looks().marks,
            root: {
              maxHeight: props.maxHeight,
              minHeight: props.minHeight,
              overflow: props.clip ? "hidden" : undefined,
            },
            content: {
              paddingTop: pad().top,
              paddingBottom: pad().bottom,
              paddingLeft: pad().left,
              paddingRight: pad().right,
              ...baseText(theme(), props.variant ?? density().editor),
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
