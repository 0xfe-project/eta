import type { EtaPlugin } from "../editor";
import { effect } from "nsh";
import { command, defineExtension, keymap, RichEditorPlugin } from "nsh/base";

/**
 * ⏎ sends, ⇧⏎ starts a new line. The editor consumes Enter natively and tells this plugin after;
 * while an input method composes, its Enter is the input method's (it commits the text) and never
 * reaches here on the platforms we checked — `editor.composing` is checked as well, so a
 * platform that does pass it on still does not send. Escape is taken only while `escape` says
 * there is something for it to do (stopping the replies under an empty box).
 */
export function submitKeys(options: {
  onSubmit: () => void;
  /** Whether Escape is this plugin's now, and what it does. */
  escape?: () => (() => void) | undefined;
}): EtaPlugin {
  let submit: () => void = () => {};
  const enter = new RichEditorPlugin("submitKeys").captureKeys(["Enter"], () =>
    submit(),
  );
  enter.capturing = true;
  let onEscape: (() => void) | undefined;
  const escape = new RichEditorPlugin("escapeKey").captureKeys(["Escape"], () =>
    onEscape?.(),
  );
  return {
    name: "submitKeys",
    extensions: [
      defineExtension({
        name: "submitKeys",
        // Above the base keymap (Enter splits the paragraph there), below the suggestion list.
        priority: 1000,
        addProseMirrorPlugins: () => [
          enter,
          escape,
          keymap({ "Shift-Enter": command("splitBlock") }),
        ],
      }),
    ],
    setup(editor) {
      submit = () => {
        if (!editor.session.composing && !editor.composing())
          options.onSubmit();
      };
      effect(() => {
        onEscape = options.escape?.();
        escape.capturing = !!onEscape;
      });
    },
  };
}
