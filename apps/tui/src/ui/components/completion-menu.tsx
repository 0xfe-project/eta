import type { TextRange } from "./typed-ranges";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { inkColor } from "../theme";
import { completionMessages } from "./completion-messages";
import { CompletionRow } from "./completion-row";
import { menuWindow } from "./menu-window";

/** One entry of a completion menu. */
export interface MenuEntry {
  key: string;
  name: string;
  /** The parts of `name` drawn bold: what was typed. */
  bold: readonly TextRange[];
  /** Drawn muted in a column after the names. */
  detail?: string;
}

/**
 * A completion menu: a window of at most `rows` rows over `entries` (see `menuWindow`), each entry
 * on one row with its detail in a column after the widest name of all the entries, and muted
 * lines for how many entries are above and below the window.
 */
export function CompletionMenu({
  entries,
  selected,
  rows,
}: {
  entries: readonly MenuEntry[];
  selected: number;
  rows: number;
}) {
  const t = useMessages(completionMessages);
  const muted = inkColor(useTheme().muted);
  const shown = menuWindow({ count: entries.length, selected, rows });
  // Over every entry, not only the shown ones, so the column does not move as the window does.
  const nameWidth = Math.max(0, ...entries.map((e) => stringWidth(e.name)));
  return (
    <Box flexDirection="column" flexShrink={0}>
      {shown.above > 0 && (
        <Text color={muted}>{t("moreAbove", { count: shown.above })}</Text>
      )}
      {entries.slice(shown.start, shown.end).map((entry, offset) => (
        <CompletionRow
          key={entry.key}
          name={entry.name}
          nameWidth={nameWidth}
          bold={entry.bold}
          detail={entry.detail}
          selected={shown.start + offset === selected}
        />
      ))}
      {shown.below > 0 && (
        <Text color={muted}>{t("moreBelow", { count: shown.below })}</Text>
      )}
    </Box>
  );
}
