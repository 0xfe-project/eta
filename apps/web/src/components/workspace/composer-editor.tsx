import type { Draft } from "@/lib/composer";
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
import { isLongPaste } from "@/lib/composer";
import { cn } from "@/lib/utils";
import { $readDraft, $writeDraft, BlockNode } from "./composer-nodes";

// The chat's composer: plain text with blocks among it (composer-nodes.ts).
// Lexical does the editing (selection, IME, undo, mobile keyboards); this
// file only says how pastes become blocks and keeps the editor and the
// draft the same.

const sameDraft = (a: Draft, b: Draft) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Folds long pastes into blocks; never inserts HTML. */
function PastePlugin() {
  const [editor] = useLexicalComposerContext();
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
          const text = data.getData("text/plain").replace(/\r\n?/g, "\n");
          // Short text: the plain text editor inserts text/plain alone.
          if (!isLongPaste(text)) return false;
          event.preventDefault();
          $insertNodes([
            new BlockNode({ type: "paste", id: crypto.randomUUID(), text }),
          ]);
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
                    "pointer-events-none absolute inset-0 select-none overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground",
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
      <PastePlugin />
      <DraftPlugin
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
    </LexicalComposer>
  );
}
