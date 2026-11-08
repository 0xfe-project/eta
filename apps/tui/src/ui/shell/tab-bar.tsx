import type { TabRef } from "../../config/types";
import type { PinnedTab, TabStatus, TabView } from "../../extensions/types";
import { Box, Text } from "ink";
import { useRegistry, useTheme } from "../../extensions/react";
import { truncateToWidth } from "../text-width";
import { inkColor } from "../theme";

const TITLE_COLUMNS = 20;
const TAB_GAP = 2;

const STATUS_MARKS: Record<
  TabStatus,
  { mark: string; token: "accent" | "warning" | "success" | "error" }
> = {
  running: { mark: "●", token: "accent" },
  waiting: { mark: "!", token: "warning" },
  done: { mark: "✓", token: "success" },
  failed: { mark: "✗", token: "error" },
};

function useHighlight(active: boolean) {
  const theme = useTheme();
  if (!active) return {};
  const selection = inkColor(theme.selection);
  return selection === undefined
    ? { inverse: true }
    : { backgroundColor: selection };
}

function KnownTabLabel({
  view,
  tab,
  number,
  active,
}: {
  view: TabView;
  tab: TabRef;
  number: number;
  active: boolean;
}) {
  const theme = useTheme();
  const title = view.useTitle(tab);
  const status = view.useStatus?.(tab);
  const highlight = useHighlight(active);
  const mark = status === undefined ? undefined : STATUS_MARKS[status];
  return (
    <Text {...highlight}>
      {`${number}:${truncateToWidth(title, TITLE_COLUMNS)}`}
      {mark !== undefined && (
        <>
          {" "}
          <Text color={inkColor(theme[mark.token])}>{mark.mark}</Text>
        </>
      )}
    </Text>
  );
}

function UnknownTabLabel({
  tab,
  number,
  active,
}: {
  tab: TabRef;
  number: number;
  active: boolean;
}) {
  const theme = useTheme();
  const highlight = useHighlight(active);
  return (
    <Text {...highlight} color={inkColor(theme.muted)}>
      {`${number}:${truncateToWidth(tab.id, TITLE_COLUMNS)}`}
    </Text>
  );
}

function PinnedLabel({ pinned }: { pinned: PinnedTab }) {
  const theme = useTheme();
  const label = pinned.useLabel();
  const attention = pinned.useAttention?.() ?? false;
  return (
    <Text color={attention ? inkColor(theme.warning) : undefined}>{label}</Text>
  );
}

/**
 * One line: the open tabs numbered from 1, then the pinned entries at the right end. When they do
 * not all fit, the open tabs are cut at their right edge and the pinned entries stay whole; the
 * line never wraps.
 */
export function TabBar({
  tabs,
  activeTab,
}: {
  tabs: readonly TabRef[];
  activeTab: number | undefined;
}) {
  const registry = useRegistry();
  return (
    <Box height={1} overflow="hidden" flexShrink={0} width="100%">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {tabs.map((tab, index) => {
          const view = registry.view(tab.kind);
          const props = { tab, number: index + 1, active: index === activeTab };
          return (
            <Box
              key={`${tab.kind}:${tab.id}`}
              flexShrink={0}
              marginRight={TAB_GAP}
            >
              {view ? (
                <KnownTabLabel view={view} {...props} />
              ) : (
                <UnknownTabLabel {...props} />
              )}
            </Box>
          );
        })}
      </Box>
      {registry.pinnedTabs.map((pinned) => (
        <Box key={pinned.id} flexShrink={0} marginLeft={TAB_GAP}>
          <PinnedLabel pinned={pinned} />
        </Box>
      ))}
    </Box>
  );
}
