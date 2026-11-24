import type { EtaEditorHandle } from "./editor";
import { Clipboard, cleanup, signal, Storage, Text, View } from "nsh";
import { Fonts, fontFamily } from "../theme";

// Diagnostic build for #366 (not for main): a caret overlay over the composer. In the text's own
// layer it draws nsh's geometry for the caret's line — a blue tick at every position's caret box
// (`coordsAtPos`) and a green frame around the caret's — and under the editor the logical state:
// the selection, whether an input method composes, the line with the caret marked, its code
// points, the boxes and the last events. If the ticks fall on glyphs, the text is drawn somewhere
// other than where nsh measures it; if they sit between glyphs but the selection is not where the
// text goes, the selection is what is off.

const key = "eta.debug.caret";

/** Whether the overlay is on (Settings → Appearance, "Caret debug overlay"). */
export const caretDebug = signal(false);
void Storage.getItem(key)
  .then((value) => caretDebug.set(value === "1"))
  .catch(() => {});

export function setCaretDebug(on: boolean) {
  caretDebug.set(on);
  void Storage.setItem(key, on ? "1" : "0").catch(() => {});
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Snapshot {
  head: number;
  anchor: number;
  type: string;
  start: number;
  /** The line's characters by position: a text's own, "◆" for an inline leaf. */
  chars: string[];
  boxes: (Box | null)[];
  caret: Box | null;
  page: Box | null;
}

const round = (n: number) => Math.round(n * 10) / 10;
const boxText = (box: Box | null) =>
  box
    ? `x=${round(box.x)} y=${round(box.y)} w=${round(box.width)} h=${round(box.height)}`
    : "none";

function read(editor: EtaEditorHandle): Snapshot | null {
  const session = editor.session;
  const selection = session.selection;
  const head = selection.head ?? 0;
  const anchor = selection.anchor ?? head;
  try {
    const at = session.resolve(head) as { start: number; end: number };
    const block = session.nodeAt(at.start - 1);
    const chars: string[] = [];
    for (const node of block?.content ?? []) {
      if (node.type === "text") chars.push(...(node.text ?? "").split(""));
      else chars.push("◆");
    }
    const boxes: (Box | null)[] = [];
    for (let pos = at.start; pos <= Math.min(at.end, at.start + 80); pos++)
      boxes.push(session.coordsAtPos(pos) as Box | null);
    return {
      head,
      anchor,
      type: selection.type,
      start: at.start,
      chars,
      boxes,
      caret: session.coordsAtPos(head) as Box | null,
      page: session.pageCoordsAtPos(head) as Box | null,
    };
  } catch {
    return null;
  }
}

/** The editor's state, read again on every change, selection, layout and composition. */
function useSnapshot(editor: EtaEditorHandle) {
  const snapshot = signal<Snapshot | null>(read(editor));
  const events = signal<string[]>([]);
  const started = Date.now();
  const note = (what: string) =>
    events.set(
      [
        ...events(),
        `${((Date.now() - started) / 1000).toFixed(3)} ${what}`,
      ].slice(-8),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const again = () => {
    clearTimeout(timer);
    timer = setTimeout(() => snapshot.set(read(editor)), 0);
  };
  const stops = [
    editor.session.on("transaction", (value) => {
      const tr = value as {
        docChanged?: boolean;
        origin?: string;
        steps?: number;
      };
      const s = editor.session.selection;
      note(
        `tr ${tr.origin ?? "?"}${tr.docChanged ? " doc" : ""} → head ${s.head ?? "?"}`,
      );
      again();
    }),
    editor.session.on("selectionUpdate", () => again()),
  ];
  let wasComposing = editor.composing();
  const poll = setInterval(() => {
    if (editor.composing() !== wasComposing) {
      wasComposing = editor.composing();
      note(`composing ${wasComposing ? "on" : "off"}`);
    }
    // Layout lands after the change: read once more while the overlay is up.
    const now = read(editor);
    if (JSON.stringify(now) !== JSON.stringify(snapshot())) snapshot.set(now);
  }, 120);
  cleanup(() => {
    for (const stop of stops) stop();
    clearTimeout(timer);
    clearInterval(poll);
  });
  return { snapshot, events };
}

/** Ticks at every position's caret box of the caret's line and a frame around the caret's. */
export function CaretTicks(props: { editor: EtaEditorHandle }) {
  const { snapshot } = useSnapshot(props.editor);
  const boxes = () =>
    (snapshot()?.boxes ?? []).flatMap((box, i) => (box ? [{ box, i }] : []));
  return (
    <View
      style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0 }}
    >
      <Each of={boxes()}>
        {(item) => (
          <View
            style={{
              position: "absolute",
              left: item().box.x,
              top: item().box.y + item().box.height - 4,
              width: 1,
              height: 8,
              backgroundColor: "#2563eb",
            }}
          />
        )}
      </Each>
      <If when={snapshot()?.caret}>
        {(caret) => (
          <View
            style={{
              position: "absolute",
              left: caret().x - 2,
              top: caret().y - 1,
              width: Math.max(caret().width, 1) + 4,
              height: caret().height + 2,
              borderWidth: 1,
              borderColor: "#16a34a",
            }}
          />
        )}
      </If>
    </View>
  );
}

/** The logical state, under the editor, with a button that copies it. */
export function CaretReport(props: { editor: EtaEditorHandle }) {
  const { snapshot, events } = useSnapshot(props.editor);
  const fonts = Fonts();
  const copied = signal(false);
  const lines = () => {
    const s = snapshot();
    if (!s) return ["no text selection"];
    const at = s.head - s.start;
    const line = s.chars.join("");
    const marked = `${line.slice(0, at)}▮${line.slice(at)}`;
    const codes = s.chars
      .map(
        (ch, i) =>
          `${i === at ? "| " : ""}${ch.codePointAt(0)!.toString(16).toUpperCase()}`,
      )
      .join(" ");
    const ticks = s.boxes.map((box) => (box ? round(box.x) : "–")).join(" ");
    return [
      `${s.type} head ${s.head} anchor ${s.anchor} (offset ${at} in line) · composing ${props.editor.composing() ? "yes" : "no"} · focused ${props.editor.focused() ? "yes" : "no"}`,
      `line: ${marked}`,
      `code points: ${codes}`,
      `caret box: ${boxText(s.caret)} · page: ${boxText(s.page)}`,
      `tick x by offset: ${ticks}`,
      `font: ${fontFamily(fonts().interface)}`,
      ...events(),
    ];
  };
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingVertical: 6,
        gap: 2,
        backgroundColor: "#fef9c3",
        borderTopWidth: 1,
        borderColor: "#ca8a04",
      }}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text style={{ fontSize: 11, fontWeight: "bold", color: "#713f12" }}>
          Caret debug (#366)
        </Text>
        <View
          accessibilityLabel="Copy caret debug"
          onPress={() => {
            void Clipboard.writeText(lines().join("\n")).then(() => {
              copied.set(true);
              setTimeout(() => copied.set(false), 1200);
            });
          }}
          style={{
            paddingHorizontal: 6,
            borderWidth: 1,
            borderColor: "#ca8a04",
            borderRadius: 4,
          }}
        >
          <Text style={{ fontSize: 11, color: "#713f12" }}>
            {copied() ? "Copied" : "Copy"}
          </Text>
        </View>
      </View>
      <Each of={lines()}>
        {(line) => (
          <Text
            style={{
              fontSize: 11,
              lineHeight: 15,
              color: "#422006",
              fontFamily: "monospace",
            }}
          >
            {line()}
          </Text>
        )}
      </Each>
    </View>
  );
}
