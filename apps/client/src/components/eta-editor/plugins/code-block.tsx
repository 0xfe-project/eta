import type { DocNode } from "@eta/client-contracts/composer-doc";
import type { EtaEditorHandle } from "../editor";
import type { TextTheme } from "../look";
import type { TextPlugin } from "../plugin";
import {
  lineCount,
  normalizeNewlines,
} from "@eta/client-contracts/composer-doc";
import { Clipboard, Text, View } from "nsh";
import {
  defineExtension,
  insertContent,
  insertContentAt,
  setNodeAttribute,
} from "nsh/base";
import { uiText } from "../../../i18n";
import { canHover } from "../../menu";
import { colors, row, textFaces } from "../../theme";
import { showToast } from "../../toast";
import { opacity, space } from "../../tokens";
import { modKey } from "../keys";
import { blocksOf } from "../positions";
import { oneStep } from "../step";

/** A code block longer than this folds when it is pasted in. */
const FOLD_LINES = 12;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const codeOf = (node: DocNode) =>
  (node.content ?? []).map((child) => child.text ?? "").join("");

/** The height of a code block's head row: its language, and the keys or Copy. */
const headHeight = (theme: { face: TextTheme["face"] }) =>
  theme.face("caption").line + 8;

/**
 * Code blocks: square, on the surface, in the monospace face, their language at the top right
 * (with ⌘⏎ to leave the block while editing; Copy where the text is only shown). Code copied
 * from an editor or an IDE pastes as a code block (`classifyClipboard`'s `code`); over
 * `FOLD_LINES` lines it comes folded, and "Show all N lines" under it opens it. Folding is the
 * editor's: the Markdown has the whole block. Shown, a code block is the view's own (highlighted)
 * in the same box, with the view's own Copy over its corner (no head row: the view's code block
 * has no place for its language).
 */
export function codeBlock(): TextPlugin {
  return {
    name: "codeBlock",
    view: {
      // The view's own code block (its highlighting) and its own Copy, over its top right corner
      // while the pointer is over it (always on a touch screen).
      codeBlockActions: [{ id: "copy", label: uiText("copyCode") }],
    },
    styles: {
      editor: (theme) => ({ nodes: foldStyles(theme) }),
    },
    editor: {
      extensions: [
        defineExtension({
          name: "codeFold",
          addGlobalAttributes: () => [
            {
              types: ["codeBlock"],
              attributes: { folded: { default: false, keepOnSplit: false } },
            },
          ],
        }),
      ],
      paste(action, editor) {
        if (action.kind !== "code") return false;
        const text = normalizeNewlines(action.text).replace(/\n+$/, "");
        const session = editor.session;
        const here = session.resolve(session.selection.head ?? 0) as {
          start: number;
          end: number;
          parent: string;
        };
        // Already in a code block: the code is its text.
        if (here.parent === "codeBlock") {
          session.run(oneStep(insertContent(text)));
          return true;
        }
        const block = {
          type: "codeBlock",
          attrs: { language: null, folded: lineCount(text) > FOLD_LINES },
          content: [{ type: "text", text }],
        };
        // The block goes in place of an empty line, else after the line the caret is in, with a line
        // after it to go on writing.
        const empty = here.start === here.end;
        session.run(
          oneStep(
            insertContentAt(
              empty ? { from: here.start - 1, to: here.end + 1 } : here.end + 1,
              [block, { type: "paragraph" }],
            ),
          ),
        );
        return true;
      },
      contentLayer: (editor) => <CodeBlockChrome editor={editor} />,
    },
  };
}

function foldStyles(theme: TextTheme) {
  const small = theme.face("small");
  return {
    // Room for the head row above the code.
    codeBlock: { paddingTop: headHeight(theme) + 8 },
    // The fold: FOLD_LINES lines and the padding, the rest under "Show all".
    "codeBlock[folded=true]": {
      maxHeight:
        headHeight(theme) + 16 + small.prose * FOLD_LINES + small.line + 8,
      overflow: "hidden" as const,
      paddingBottom: small.line + 8,
    },
  };
}

/** A code block where the text is shown: the editor's box, its language and Copy over the code. */
/** Over each code block: its language and what the keys do (Copy where it is only shown), and the
 * fold's bar. Placed by the blocks' boxes, in the text's own layer, so it scrolls with them. */
function CodeBlockChrome(props: { editor: EtaEditorHandle }) {
  const c = colors();
  const type = textFaces();
  const editor = props.editor;
  const blocks = () => {
    editor.revision();
    editor.laidOut();
    return blocksOf(editor.doc(), "codeBlock").flatMap(({ pos, node }) => {
      let box: Box | null = null;
      try {
        box = editor.session.nodeRect(pos) as Box | null;
      } catch {
        box = null;
      }
      return box ? [{ pos, node, box }] : [];
    });
  };
  const caption = (value: string, tone: string) => (
    <Text
      style={{
        fontSize: type("caption").size,
        lineHeight: type("caption").line,
        color: tone,
      }}
    >
      {value}
    </Text>
  );
  return (
    <>
      <Each of={blocks()} key={(block) => String(block.pos)}>
        {(block) => {
          const language = () => String(block().node.attrs?.language ?? "");
          const folded = () => !!block().node.attrs?.folded;
          const editable = () => editor.session.isEditable;
          return (
            <>
              <View
                style={{
                  ...row,
                  position: "absolute",
                  left: block().box.x + 1,
                  width: block().box.width - 2,
                  top: block().box.y + 1,
                  height: type("caption").line + 8,
                  paddingHorizontal: space[12],
                  gap: space[8],
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <View style={{ flex: 1 }}>
                  {caption(language() || uiText("codeKind"), c().faint)}
                </View>
                <If when={editable() && canHover && editor.focused()}>
                  {caption(
                    uiText("codeBlockLeave", { mod: modKey }),
                    c().faint,
                  )}
                </If>
                <If when={!editable()}>
                  <View
                    role="button"
                    accessibilityLabel={uiText("copyCode")}
                    onPress={() =>
                      void Clipboard.writeText(codeOf(block().node)).then(() =>
                        showToast({ title: uiText("copied") }),
                      )
                    }
                    hoverStyle={{ opacity: opacity.muted }}
                    style={{ cursor: "pointer" }}
                  >
                    {caption(uiText("copyAction"), c().muted)}
                  </View>
                </If>
              </View>
              <If when={folded()}>
                <View
                  role="button"
                  accessibilityLabel={uiText("codeShowAll", {
                    count: lineCount(codeOf(block().node)),
                  })}
                  onPress={() =>
                    editor.session.run(
                      oneStep(setNodeAttribute(block().pos, "folded", false)),
                    )
                  }
                  hoverStyle={{ backgroundColor: c().selected }}
                  style={{
                    ...row,
                    position: "absolute",
                    left: block().box.x + 1,
                    width: block().box.width - 2,
                    top:
                      block().box.y +
                      block().box.height -
                      type("small").line -
                      9,
                    height: type("small").line + 8,
                    paddingHorizontal: space[12],
                    borderTopWidth: 1,
                    borderColor: c().border,
                    backgroundColor: c().surface,
                    cursor: "pointer",
                  }}
                >
                  {caption(
                    uiText("codeShowAll", {
                      count: lineCount(codeOf(block().node)),
                    }),
                    c().muted,
                  )}
                </View>
              </If>
            </>
          );
        }}
      </Each>
    </>
  );
}

/**
 * Code blocks without their own frame (border and the space around): for code shown on its own
 * (a tool call's input), framed by the place around it, which scrolls it when it is long (a code
 * block only scrolls sideways).
 */
export function bareCode(): TextPlugin {
  return {
    name: "bareCode",
    styles: {
      view: () => ({
        codeBlock: { borderWidth: 0, marginVertical: 0 },
        // The block's own padding is the only space around the code.
        codeBlockCode: { padding: 0 },
      }),
    },
  };
}
