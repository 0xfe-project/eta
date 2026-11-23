import { View } from "nsh";
import {
  colors,
  Fonts,
  Label,
  monoFontFamily,
  SmoothScroll,
  textFaces,
} from "../../../components";
import { codeText } from "../../../components/eta-editor";

/** Tools whose input, given as a string, is a shell command line. */
const SHELL_TOOLS =
  /^(?:\$|bash|sh|zsh|shell|terminal|exec|exec_command|command|command_execution|commandexecution|run_command|local_shell)$/i;

/** The language a tool call's input is shown in: JSON for an object, a shell's for a shell tool's
 * command line (by the tool's name: a string has no `command` field for `commandOf` to read), none
 * for other text. */
function languageOf(name: string, input: unknown): string {
  if (typeof input !== "string") return "json";
  return SHELL_TOOLS.test(name) ? "bash" : "";
}

/** A tool call's input as it reads: an object as JSON indented by 2, text as it is. */
function inputText(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input, null, 2);
}

/** `code` as one fenced code block in `language`: the fence longer than any run of backticks in it. */
function fenced(code: string, language: string): string {
  const longest = Math.max(
    0,
    ...(code.match(/`+/g) ?? []).map((run) => run.length),
  );
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${language}\n${code.replace(/\n+$/, "")}\n${fence}`;
}

/**
 * A tool call's input as code: an object as JSON (indented by 2) highlighted as JSON, a command
 * line of a shell tool as shell, other text as plain monospace. The chat's code block (its
 * colours and its Copy, which copies the text as shown), at most 13 lines tall and scrolling past
 * that, unwrapped and scrolling sideways.
 */
export function ToolInput(props: { name: string; input: unknown }) {
  const c = colors();
  const type = textFaces();
  // 13 lines and the code block's padding.
  const height = () => type("small").prose * 13 + 16;
  return (
    <View
      testID="tool-input"
      style={{
        borderWidth: 1,
        borderColor: c().border,
        backgroundColor: c().surface,
      }}
    >
      <SmoothScroll style={{ maxHeight: height() }}>
        <codeText.View
          variant="small"
          text={{
            text: fenced(
              inputText(props.input),
              languageOf(props.name, props.input),
            ),
          }}
        />
      </SmoothScroll>
    </View>
  );
}

/** A tool call's output: in the monospace face, wrapped as it was, not highlighted (it is often
 * prose). */
export function ToolOutput(props: { text: string; tone?: "ink" | "muted" }) {
  const fonts = Fonts();
  const type = textFaces();
  return (
    <Label
      variant="small"
      tone={props.tone}
      style={{
        fontFamily: monoFontFamily(fonts()),
        lineHeight: type("small").prose,
      }}
    >
      {props.text}
    </Label>
  );
}
