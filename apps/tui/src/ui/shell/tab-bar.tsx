import type { TabRef } from "../../config/types";
import type { PinnedTab, TabStatus, TabView } from "../../extensions/types";
import { Box, Text } from "ink";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { useRegistry, useTheme } from "../../extensions/react";
import { truncateToWidth } from "../text-width";
import { inkColor } from "../theme";

const TITLE_COLUMNS = 20;
const TAB_GAP = 2;
const QUALIFIER_SEPARATOR = " · ";
const NO_QUALIFIERS: readonly string[] = Object.freeze([]);

const STATUS_MARKS: Record<
  TabStatus,
  { mark: string; token: "accent" | "warning" | "success" | "error" }
> = {
  running: { mark: "●", token: "accent" },
  waiting: { mark: "!", token: "warning" },
  done: { mark: "✓", token: "success" },
  failed: { mark: "✗", token: "error" },
};

/** A tab's name as the bar shows it, and what its view offers to tell it apart from another. */
interface TabName {
  shown: string;
  qualifiers: readonly string[];
}

/** A label tells the bar its tab's name, or undefined once the label is gone. */
type ReportName = (key: string, name: TabName | undefined) => void;

function sameName(a: TabName, b: TabName): boolean {
  return (
    a.shown === b.shown &&
    a.qualifiers.length === b.qualifiers.length &&
    a.qualifiers.every((qualifier, i) => qualifier === b.qualifiers[i])
  );
}

/**
 * How many qualifiers each tab of one shown name gets: every tab still alike with another takes
 * one more, round by round, until none is alike or the alike ones have no more to take.
 */
function qualifierCounts(group: readonly TabName[]): number[] {
  const counts = group.map(() => 0);
  for (;;) {
    const labels = group.map((name, i) =>
      JSON.stringify(name.qualifiers.slice(0, counts[i])),
    );
    let added = false;
    group.forEach((name, i) => {
      const alike = labels.filter((label) => label === labels[i]).length > 1;
      if (alike && counts[i] < name.qualifiers.length) {
        counts[i] += 1;
        added = true;
      }
    });
    if (!added) return counts;
  }
}

/** The qualifiers each tab shows, by tab key; a tab whose shown name is unique shows none. */
function qualifiersToShow(
  names: ReadonlyMap<string, TabName>,
): Map<string, readonly string[]> {
  const byShown = new Map<string, [key: string, name: TabName][]>();
  for (const [key, name] of names)
    byShown.set(name.shown, [...(byShown.get(name.shown) ?? []), [key, name]]);
  const shown = new Map<string, readonly string[]>();
  for (const group of byShown.values()) {
    if (group.length < 2) continue;
    const counts = qualifierCounts(group.map(([, name]) => name));
    group.forEach(([key, name], i) =>
      shown.set(key, name.qualifiers.slice(0, counts[i])),
    );
  }
  return shown;
}

/**
 * The names the open tabs report, and the qualifiers each tab is to show. The number of tabs
 * changes, so the bar cannot call a hook once per tab: each label calls its view's hooks and
 * reports the result here.
 */
function useTabNames(): {
  report: ReportName;
  shownQualifiers: Map<string, readonly string[]>;
} {
  const [names, setNames] = useState<ReadonlyMap<string, TabName>>(
    () => new Map(),
  );
  const report = useCallback<ReportName>((key, name) => {
    setNames((current) => {
      const known = current.get(key);
      const unchanged =
        name === undefined
          ? known === undefined
          : known !== undefined && sameName(known, name);
      if (unchanged) return current;
      const next = new Map(current);
      if (name === undefined) next.delete(key);
      else next.set(key, name);
      return next;
    });
  }, []);
  const shownQualifiers = useMemo(() => qualifiersToShow(names), [names]);
  return { report, shownQualifiers };
}

/** The number and name of a tab: bold in the accent colour for the active one, muted otherwise. */
function useNameStyle(active: boolean): { color?: string; bold: boolean } {
  const theme = useTheme();
  return active
    ? { color: inkColor(theme.accent), bold: true }
    : { color: inkColor(theme.muted), bold: false };
}

function KnownTabLabel({
  view,
  tab,
  number,
  active,
  nameKey,
  qualifiers,
  report,
}: {
  view: TabView;
  tab: TabRef;
  number: number;
  active: boolean;
  /** The tab's key among the names the bar holds. */
  nameKey: string;
  /** The qualifiers to show after the name. */
  qualifiers: readonly string[];
  report: ReportName;
}) {
  const theme = useTheme();
  const title = view.useTitle(tab);
  const offered = view.useQualifiers?.(tab) ?? NO_QUALIFIERS;
  const status = view.useStatus?.(tab);
  const nameStyle = useNameStyle(active);
  const shown = truncateToWidth(title, TITLE_COLUMNS);
  useLayoutEffect(() => {
    report(nameKey, { shown, qualifiers: offered });
  }, [report, nameKey, shown, offered]);
  useLayoutEffect(() => () => report(nameKey, undefined), [report, nameKey]);
  const mark = status === undefined ? undefined : STATUS_MARKS[status];
  const name =
    qualifiers.length === 0
      ? shown
      : `${shown} (${qualifiers.join(QUALIFIER_SEPARATOR)})`;
  return (
    <Text>
      <Text {...nameStyle}>{`${number}:${name}`}</Text>
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
  const nameStyle = useNameStyle(active);
  return (
    <Text {...nameStyle}>
      {`${number}:${truncateToWidth(tab.id, TITLE_COLUMNS)}`}
    </Text>
  );
}

/** A pinned entry: muted while nothing waits on the user, in the warning colour while something does. */
function PinnedLabel({ pinned }: { pinned: PinnedTab }) {
  const theme = useTheme();
  const label = pinned.useLabel();
  const attention = pinned.useAttention?.() ?? false;
  return (
    <Text color={inkColor(attention ? theme.warning : theme.muted)}>
      {label}
    </Text>
  );
}

/**
 * One line: the open tabs numbered from 1, then the pinned entries at the right end. When they do
 * not all fit, the open tabs are cut at their right edge and the pinned entries stay whole; the
 * line never wraps. Tabs whose shown names are the same get their views' qualifiers after the
 * name, as `TabView.useQualifiers` describes.
 */
export function TabBar({
  tabs,
  activeTab,
}: {
  tabs: readonly TabRef[];
  activeTab: number | undefined;
}) {
  const registry = useRegistry();
  const { report, shownQualifiers } = useTabNames();
  return (
    <Box height={1} overflow="hidden" flexShrink={0} width="100%">
      <Box flexGrow={1} flexShrink={1} overflow="hidden">
        {tabs.map((tab, index) => {
          const view = registry.view(tab.kind);
          const key = `${tab.kind}:${tab.id}`;
          const props = { tab, number: index + 1, active: index === activeTab };
          return (
            <Box key={key} flexShrink={0} marginRight={TAB_GAP}>
              {view ? (
                <KnownTabLabel
                  view={view}
                  nameKey={key}
                  qualifiers={shownQualifiers.get(key) ?? NO_QUALIFIERS}
                  report={report}
                  {...props}
                />
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
