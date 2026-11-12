import type { DOMElement } from "ink";
import type { SlashCommand } from "../../../extensions/types";
import type { PasteRange } from "../contract";
import type { CompletionItem, CompletionSources, OpenMenu } from "./completion";
import type { KeyContext } from "./keys";
import type { ComposerState, FoldedPaste } from "./state";
import type { DisplayRow } from "./text-layout";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { useConfig, useInputActive } from "../../../extensions/react";
import { localize } from "../../../i18n/messages";
import { useLocale, useMessages } from "../../../i18n/react";
import { truncateToWidth } from "../../../ui/text-width";
import { inkColor } from "../../../ui/theme";
import { completionQuery, menuOf } from "./completion";
import { composerMessages } from "./messages";
import { cursorCell, layoutRows, nextGraphemeEnd } from "./text-layout";
import { useComposerKeys } from "./use-composer-keys";
import { useTerminalCursor } from "./use-terminal-cursor";

const PROMPT = "› ";
const CONTINUATION = "  ";
const PROMPT_WIDTH = 2;
const MAX_ROWS = 10;

export interface ComposerProps {
  state: ComposerState;
  onState: (next: ComposerState) => void;
  /** Columns the composer may use, prompt included. */
  width: number;
  /** Whether it takes keys; it also takes none while its input scope is off. */
  active: boolean;
  /** An agent in this conversation is replying: Tab steers and Esc stops. */
  replying: boolean;
  completeCommand: (prefix: string) => SlashCommand[];
  members: { id: string; name: string }[];
  /**
   * The conversation's project files, asked for the first time the `@` menu opens; after a
   * rejection, asked again the next time it opens.
   */
  loadFiles: () => Promise<string[]>;
  /**
   * `text` has every folded paste expanded and is trimmed; `pastes` are where they sit in it,
   * `[start, end)` in UTF-16 offsets; `mentions` are member ids.
   */
  onSend: (message: {
    text: string;
    pastes: PasteRange[];
    mentions: string[];
    mode: "queue" | "steer";
  }) => void;
  /** A line starting with `/`, pastes expanded. */
  onCommand: (line: string) => void;
  onStop: () => void;
  /** `panel.open` pressed with nothing typed. */
  onPanel: () => void;
}

/** The first row on screen: moved only as far as keeps the cursor row in view. */
function scrolledTop(top: number, cursorRow: number, rowCount: number): number {
  const highest = Math.max(0, rowCount - MAX_ROWS);
  const kept = Math.min(Math.max(top, cursorRow - MAX_ROWS + 1), cursorRow);
  return Math.max(0, Math.min(kept, highest));
}

/** The project's files, asked for on the first `@` menu and on the next one after a failure; undefined until they come. */
function useProjectFiles(
  wanted: boolean,
  loadFiles: () => Promise<string[]>,
): readonly string[] | undefined {
  const [files, setFiles] = useState<readonly string[]>();
  const requestedRef = useRef(false);
  useEffect(() => {
    if (!wanted || requestedRef.current) return;
    requestedRef.current = true;
    // A host that cannot list them now only means no files to offer this time.
    loadFiles().then(setFiles, () => {
      requestedRef.current = false;
    });
  }, [wanted, loadFiles]);
  return files;
}

function MenuRow({
  item,
  highlighted,
}: {
  item: CompletionItem;
  highlighted: boolean;
}) {
  const config = useConfig();
  const locale = useLocale();
  const { accent, muted, selection } = config.theme;
  const background = highlighted ? inkColor(selection) : undefined;
  const [name, detail] =
    item.kind === "command"
      ? [`/${item.command.name}`, `  ${localize(item.command.summary, locale)}`]
      : item.kind === "file"
        ? [`@${item.path}`, ""]
        : [`@${item.label}`, ""];
  return (
    <Text wrap="truncate-end" backgroundColor={background}>
      <Text color={inkColor(accent)}>{name}</Text>
      <Text color={inkColor(muted)}>{detail}</Text>
    </Text>
  );
}

/** One display row, the cursor cell inverse and placeholders in the accent colour. */
function RowText({
  text,
  row,
  pastes,
  cursor,
}: {
  text: string;
  row: DisplayRow;
  pastes: readonly FoldedPaste[];
  cursor: number | undefined;
}) {
  const accent = inkColor(useConfig().theme.accent);
  const cuts = new Set([row.start, row.end]);
  for (const paste of pastes) {
    if (paste.start > row.start && paste.start < row.end) cuts.add(paste.start);
    if (paste.end > row.start && paste.end < row.end) cuts.add(paste.end);
  }
  if (cursor !== undefined && cursor > row.start && cursor < row.end)
    cuts.add(cursor);
  const points = [...cuts].sort((a, b) => a - b);
  const pieces = points.slice(0, -1).map((start, i) => {
    const end = points[i + 1] ?? start;
    const inPaste = pastes.some((p) => p.start <= start && end <= p.end);
    const piece = text.slice(start, end);
    if (start !== cursor) {
      return (
        <Text key={start} color={inPaste ? accent : undefined}>
          {piece}
        </Text>
      );
    }
    const head = piece.slice(0, nextGraphemeEnd(piece, 0));
    return (
      <Text key={start} color={inPaste ? accent : undefined}>
        <Text inverse>{head}</Text>
        {piece.slice(head.length)}
      </Text>
    );
  });
  return (
    <Text>
      {pieces}
      {cursor === row.end && <Text inverse> </Text>}
    </Text>
  );
}

/**
 * The message input at the bottom of a conversation. Controlled: the state lives with the
 * conversation, so a draft and its history survive the view being unmounted.
 */
export function Composer(props: ComposerProps) {
  const { state, width, replying, members } = props;
  const config = useConfig();
  const locale = useLocale();
  const t = useMessages(composerMessages);
  const receiving = useInputActive() && props.active;
  const columns = Math.max(1, width - PROMPT_WIDTH);

  const query = completionQuery(state);
  const files = useProjectFiles(
    !state.menu.dismissed && query?.kind === "mention",
    props.loadFiles,
  );
  const sources: CompletionSources = {
    completeCommand: props.completeCommand,
    members,
    locale,
    files,
  };
  const menu = menuOf(state, sources);
  const context: KeyContext = { columns, replying, menu };

  useComposerKeys({ state, context, sources, props }, receiving);

  const rows = layoutRows(state.text, columns);
  const cell = cursorCell(state.text, rows, state.cursor);
  const [top, setTop] = useState(0);
  const shownTop = scrolledTop(top, cell.row, rows.length);
  if (shownTop !== top) setTop(shownTop);
  const shown = rows.slice(shownTop, shownTop + MAX_ROWS);

  const rowsBoxRef = useRef<DOMElement>(null);
  useTerminalCursor(
    rowsBoxRef,
    receiving
      ? { x: PROMPT_WIDTH + cell.column, y: cell.row - shownTop }
      : undefined,
  );

  return (
    <Box flexDirection="column" flexShrink={0} width={width}>
      {menu && <MenuList menu={menu} highlight={state.menu.highlight} />}
      <Box ref={rowsBoxRef} flexDirection="column">
        {state.text === "" ? (
          <Hint text={t("hint")} columns={columns} cursor={receiving} />
        ) : (
          shown.map((row, i) => (
            <Box key={`${row.start}:${row.end}`}>
              <Text color={inkColor(config.theme.accent)}>
                {shownTop + i === 0 ? PROMPT : CONTINUATION}
              </Text>
              <RowText
                text={state.text}
                row={row}
                pastes={state.pastes}
                cursor={
                  receiving && shownTop + i === cell.row
                    ? state.cursor
                    : undefined
                }
              />
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}

function MenuList({ menu, highlight }: { menu: OpenMenu; highlight: number }) {
  const shownHighlight = Math.min(highlight, menu.items.length - 1);
  return (
    <Box flexDirection="column">
      {menu.items.map((item, i) => (
        <MenuRow
          key={
            item.kind === "command"
              ? item.command.name
              : item.kind === "file"
                ? `file:${item.path}`
                : `${item.kind}:${item.label}`
          }
          item={item}
          highlighted={i === shownHighlight}
        />
      ))}
    </Box>
  );
}

function Hint({
  text,
  columns,
  cursor,
}: {
  text: string;
  columns: number;
  cursor: boolean;
}) {
  const theme = useConfig().theme;
  const shown = truncateToWidth(text, columns);
  const first = shown.slice(0, nextGraphemeEnd(shown, 0)) || " ";
  return (
    <Box>
      <Text color={inkColor(theme.accent)}>{PROMPT}</Text>
      <Text color={inkColor(theme.muted)}>
        {cursor ? <Text inverse>{first}</Text> : first}
        {shown.slice(first.length)}
      </Text>
    </Box>
  );
}
