// How PickList and CheckList draw their visible rows.

import type { ReactNode } from "react";
import type { PickItem } from "./list-cursor";
import { Box, Text } from "ink";
import { useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { inkColor } from "../../ui/theme";
import { kitMessages } from "./messages";

/** The visible rows between a line for what is above and a line for what is below. */
export function ListWindow({
  above,
  below,
  children,
}: {
  above: number;
  below: number;
  children: ReactNode;
}) {
  const t = useMessages(kitMessages);
  const theme = useTheme();
  const muted = inkColor(theme.muted);
  return (
    <Box flexDirection="column">
      {above > 0 && (
        <Text color={muted}>{t("moreAbove", { count: above })}</Text>
      )}
      {children}
      {below > 0 && (
        <Text color={muted}>{t("moreBelow", { count: below })}</Text>
      )}
    </Box>
  );
}

/** One row: the marker, what comes before the label (a tick box), the label, the hint, the tag. */
export function ListRow({
  item,
  marked,
  prefix = "",
}: {
  item: PickItem;
  marked: boolean;
  prefix?: string;
}) {
  const theme = useTheme();
  const muted = inkColor(theme.muted);
  const color = item.disabled
    ? muted
    : marked
      ? inkColor(theme.accent)
      : undefined;
  return (
    <Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end" color={color} bold={marked && !item.disabled}>
          {marked ? "› " : "  "}
          {prefix}
          {item.label}
          {item.hint !== undefined && (
            <Text color={muted}>{`  ${item.hint}`}</Text>
          )}
        </Text>
      </Box>
      {item.tag !== undefined && (
        <Box flexShrink={0} marginLeft={2}>
          <Text color={muted}>{item.tag}</Text>
        </Box>
      )}
    </Box>
  );
}
