import type { BlockPart } from "./composer-nodes";
import type { Draft, FilePart } from "@/lib/composer";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { mergeRegister } from "@lexical/utils";
import {
  $insertNodes,
  COMMAND_PRIORITY_HIGH,
  KEY_DOWN_COMMAND,
  PASTE_COMMAND,
} from "lexical";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { isLongPaste, MAX_MESSAGE_CHARS, pasteFileName } from "@/lib/composer";
import { cn } from "@/lib/utils";
import { $readDraft, $writeDraft, BlockNode } from "./composer-nodes";

// The chat's composer: plain text with blocks among it (composer-nodes.ts).
// Lexical does the editing (selection, IME, undo, mobile keyboards); this
// file only says how pastes become blocks and keeps the editor and the
// draft the same.

/** The clipboard's files, unless it holds rich text with a picture of it. */
function pastedFiles(data: DataTransfer): File[] {
  const files = [...data.files];
  if (!files.length) {
    for (const item of data.items ?? []) {
      const file = item.kind === "file" ? item.getAsFile() : null;
      if (file) files.push(file);
    }
  }
  // Office and web pages put a rendered image beside copied text: the text
  // is what was copied. A file manager's own text is only names.
  const rich =
    data.types.includes("text/html") || data.types.includes("text/rtf");
  if (
    rich &&
    data.getData("text/plain").trim() &&
    files.every((f) => f.type.startsWith("image/"))
  )
    return [];
  return files;
}

const sameDraft = (a: Draft, b: Draft) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Folds long pastes and files into blocks; never inserts HTML. */
function PastePlugin({
  onFiles,
  onPaste,
}: {
  onFiles: (files: File[]) => FilePart[];
  /** A long paste: kept as a block, and also written to the project as a file. */
  onPaste?: (id: string, text: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const onFilesRef = useRef(onFiles);
  const onPasteRef = useRef(onPaste);
  useEffect(() => {
    onFilesRef.current = onFiles;
    onPasteRef.current = onPaste;
  });
  useEffect(
    () =>
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const data =
            event instanceof KeyboardEvent
              ? null
              : "clipboardData" in event
                ? event.clipboardData
                : event.dataTransfer;
          if (!data) return false;
          const files = pastedFiles(data);
          const text = data.getData("text/plain").replace(/\r\n?/g, "\n");
          let blocks: BlockPart[] = [];
          if (files.length) blocks = onFilesRef.current(files);
          else if (text.length > MAX_MESSAGE_CHARS)
            blocks = onFilesRef.current([
              new File([text], pasteFileName(), {
                type: "text/plain;charset=utf-8",
              }),
            ]);
          else if (isLongPaste(text)) {
            const id = crypto.randomUUID();
            blocks = [{ type: "paste", id, text }];
            // The block is what the composer shows; the file is what the agent can open. Both,
            // because a 200-line paste in a message body is a message nobody can read.
            onPasteRef.current?.(id, text);
          }
          // Short text: the plain text editor inserts text/plain alone.
          else return false;
          event.preventDefault();
          $insertNodes(blocks.map((part) => new BlockNode(part)));
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    [editor],
  );
  return null;
}

/** Keeps the draft and the editor the same, whichever of them changed. */
function DraftPlugin({
  value,
  onChange,
  onKeyDown,
  disabled,
}: {
  value: Draft;
  onChange: (draft: Draft) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  /** The input method's own events: the keydown handler needs to know a composition happened. */
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  disabled: boolean;
}) {
  const [editor] = useLexicalComposerContext();
  const lastRef = useRef(value);
  const handlersRef = useRef({ onChange, onKeyDown });
  useEffect(() => {
    handlersRef.current = { onChange, onKeyDown };
  });
  useEffect(() => editor.setEditable(!disabled), [editor, disabled]);
  useEffect(
    () =>
      mergeRegister(
        editor.registerUpdateListener(
          ({ editorState, dirtyElements, dirtyLeaves }) => {
            if (!dirtyElements.size && !dirtyLeaves.size) return;
            const draft = editorState.read($readDraft);
            if (sameDraft(draft, lastRef.current)) return;
            lastRef.current = draft;
            handlersRef.current.onChange(draft);
          },
        ),
        // Sending, the slash menu and the interrupt keys come first.
        editor.registerCommand(
          KEY_DOWN_COMMAND,
          (event) => {
            handlersRef.current.onKeyDown(event);
            return event.defaultPrevented;
          },
          COMMAND_PRIORITY_HIGH,
        ),
      ),
    [editor],
  );
  // Set from outside: cleared after sending, completed by the slash menu,
  // a failed message brought back.
  useEffect(() => {
    if (sameDraft(value, lastRef.current)) return;
    lastRef.current = value;
    editor.update(() => $writeDraft(value));
  }, [editor, value]);
  return null;
}

export function ComposerEditor({
  value,
  onChange,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onFiles,
  onPaste,
  placeholder,
  disabled = false,
  className,
  style,
  inputProps,
}: {
  value: Draft;
  onChange: (draft: Draft) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  /** The input method's own events: the keydown handler needs to know a composition happened. */
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  /** Start uploading pasted files; their blocks. */
  onFiles: (files: File[]) => FilePart[];
  /** A long paste became a block: also write it into the project as a file. */
  onPaste?: (id: string, text: string) => void;
  placeholder: string;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  inputProps?: React.HTMLAttributes<HTMLDivElement>;
}) {
  const { t: translateText } = useTranslation(["chat", "common"] as const);
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "chat-composer",
        nodes: [BlockNode],
        editable: !disabled,
        editorState: () => $writeDraft(value),
        onError: (error) => {
          throw error;
        },
      }}
    >
      <div className="relative min-w-0 flex-1">
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              aria-label={translateText("composer.messageLabel")}
              aria-multiline
              {...inputProps}
              aria-placeholder={placeholder}
              placeholder={
                <div
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute inset-0 select-none overflow-hidden text-ellipsis whitespace-nowrap text-[var(--terminal-muted)]",
                    className,
                  )}
                >
                  {placeholder}
                </div>
              }
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              className={cn(
                "term-input max-h-[40vh] min-h-[1lh] overflow-y-auto whitespace-pre-wrap break-words outline-none",
                className,
              )}
              style={style}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <PastePlugin onFiles={onFiles} onPaste={onPaste} />
      <DraftPlugin
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
    </LexicalComposer>
  );
}
