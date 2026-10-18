import type { Icon } from "@phosphor-icons/react";
import type { WorkspaceView } from "./types";
import { BellIcon } from "@phosphor-icons/react/Bell";
import { BrowsersIcon } from "@phosphor-icons/react/Browsers";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { ListChecksIcon } from "@phosphor-icons/react/ListChecks";
import { UsersThreeIcon } from "@phosphor-icons/react/UsersThree";
import { useLocation } from "@tanstack/react-router";
import {
  createParser,
  createStandardSchemaV1,
  parseAsString,
  parseAsStringLiteral,
  useQueryState,
} from "nuqs";
import { useEffect, useRef } from "react";
import { translate } from "@/lib/i18n";
import { useWorkspaceStore } from "./workspace-store";

/** The side panel's tabs that have a page in the full-window workspace. */
export const sectionPaths = {
  tasks: "/workspace/tasks",
  routines: "/workspace/routines",
  inbox: "/workspace/inbox",
} as const satisfies Partial<Record<WorkspaceView, string>>;

/**
 * Where a section opens from the current mode: its page in the full-window
 * workspace, or its tab of the side panel beside the chat, which keeps the
 * chat (the agent is remembered in the browser, not in the URL).
 */
export function useSectionLink() {
  const [group] = useQueryState("group", parseAsString);
  const tabs = usePanelViews();
  const fullWindow = useLocation({
    select: (location) => location.pathname.startsWith("/workspace"),
  });
  return (
    view: keyof typeof sectionPaths,
    search: { task?: string; routine?: string } = {},
  ) =>
    fullWindow || !tabs.some((tab) => tab.value === view)
      ? ({ to: sectionPaths[view], search } as const)
      : ({
          to: "/",
          search: { group: group ?? undefined, view, ...search },
        } as const);
}

/*
 * One set of tabs, on every conversation.
 *
 * The workspace's pages used to be four destinations in the sidebar, each of which then asked
 * "but which group?" — the question the conversation you are in has already answered. So they
 * moved here: tasks, routines and what is waiting belong to *this* group, and the panel beside it
 * says so. 概览 stays the one global page, because "across every group" is not a fact about this
 * one.
 */
const panelViews = [
  {
    value: "context",
    icon: UsersThreeIcon,
    get label() {
      return translate("navigation:sections.context");
    },
  },
  {
    value: "tasks",
    icon: ListChecksIcon,
    get label() {
      return translate("navigation:sections.tasks");
    },
  },
  {
    value: "routines",
    icon: ClockIcon,
    get label() {
      return translate("navigation:sections.routines");
    },
  },
  {
    value: "inbox",
    icon: BellIcon,
    get label() {
      return translate("navigation:sections.pending");
    },
  },
  {
    value: "artifacts",
    icon: BrowsersIcon,
    get label() {
      return translate("navigation:sections.artifacts");
    },
  },
] as const;

/** The side panel's tabs beside the current chat: the same five, every conversation. */
export function usePanelViews(): readonly {
  value: WorkspaceView;
  icon: Icon;
  label: string;
}[] {
  return panelViews;
}

const linkedViewParser = parseAsStringLiteral([
  "context",
  "members",
  "artifacts",
  "tasks",
  "routines",
  "inbox",
] as const);
// Any other view (such as the old "group") opens the first tab rather than
// failing the route.
const viewParser = createParser({
  // `members` and `artifacts` are old links: `members` became `context`, and `artifacts` is a tab
  // that still exists. Anything else opens the first tab.
  parse: (value) => {
    const parsed = linkedViewParser.parse(value);
    return parsed === "members" ? "context" : (parsed ?? "context");
  },
  serialize: linkedViewParser.serialize,
})
  .withDefault("context")
  .withOptions({ history: "push" });
export const validateWorkspaceSearch = createStandardSchemaV1(
  // The routines tab's place: a routine, one of its runs, or its editor;
  // the tasks tab's: a task or "new".
  {
    view: viewParser,
    group: parseAsString,
    task: parseAsString,
    routine: parseAsString,
    run: parseAsString,
    edit: parseAsString,
  },
  { partialOutput: true },
);
export function useWorkspaceView() {
  return useQueryState("view", viewParser);
}

/**
 * Shows the panel on narrow screens, where it hides behind the chat, when
 * the URL opens one of its tabs: a link, a reload, back and forward. A link
 * followed on the page also unfolds it on wide screens; a reload leaves it
 * as it was left.
 */
export function useShowLinkedView() {
  const [linked] = useQueryState("view", linkedViewParser);
  const place = useLocation({
    select: ({ searchStr }) => {
      const search = new URLSearchParams(searchStr);
      return ["view", "task", "routine", "run"]
        .map((key) => search.get(key))
        .join();
    },
  });
  const setMobilePanel = useWorkspaceStore((s) => s.setMobilePanel);
  const showPanel = useWorkspaceStore((s) => s.showPanel);
  const seenRef = useRef(place);
  useEffect(() => {
    if (linked !== null) {
      if (place !== seenRef.current) showPanel();
      else setMobilePanel("workspace");
    }
    seenRef.current = place;
  }, [linked, place, setMobilePanel, showPanel]);
}
