import type {
  AgentMessage,
  AgentView,
  ConversationInfo,
  HistoryResult,
  MemberStatus,
  MemberView,
  MessageView,
  SessionViewSections,
  TimelineSection,
} from "@eta/client-contracts";
import type { StoreApi } from "zustand/vanilla";
import type { Locale } from "../../../config/types";
import type { WireClient, WireState } from "../../../connection/types";
import type { TranscriptItem } from "../contract";
import type { SessionLive } from "../model/items";
import type { TranscriptUi } from "../transcript/ui";
import { createStore } from "zustand/vanilla";
import { transcriptItems } from "../model/items";
import { mergeRows } from "../model/timeline";
import { INITIAL_TRANSCRIPT_UI } from "../transcript/ui";
import { emptyLive, sessionTarget, watchSession } from "./live";
import { foldWindow, visibleRows } from "./rows";

/** What the conversation view keeps between visits, besides the conversation itself. */
export interface FeedUi extends TranscriptUi {
  /** The composer's state; its shape belongs to the composer. */
  composer: unknown;
}

/** One conversation as the TUI holds it. */
export interface FeedState {
  /** The conversation's target has delivered at least once. */
  loaded: boolean;
  info: ConversationInfo | undefined;
  members: readonly MemberView[];
  /** The `agents` list, for names. */
  agents: readonly AgentView[];
  /** Every row seen and still current, oldest first, without the replies waiting under a held message. */
  rows: readonly MessageView[];
  /** Messages written but not in the conversation yet. */
  held: readonly MessageView[];
  /** The live run of each member session watched now or before, by session id. */
  sessions: ReadonlyMap<string, SessionLive>;
  /**
   * Rows older than the oldest one held exist: the window's `hasMore` until a page comes, then
   * the last page's (false after an empty page).
   */
  hasOlder: boolean;
  /** A `loadOlder` page is on its way. */
  loadingOlder: boolean;
  ui: FeedUi;
}

/**
 * One conversation on one wire. The state outlives `attach`: a view that goes away and comes back
 * finds the rows, the live runs and its own interface state as it left them.
 */
export interface Feed {
  readonly conversationId: string;
  readonly store: StoreApi<FeedState>;
  /**
   * Follow the conversation: subscribe to it and to the agents, and to the session of each member
   * that is working, waiting for input or stopping, for as long as it is. Returns the release,
   * which works once; the subscriptions end at the last release. The conversation keeps running on
   * the host either way.
   */
  attach: () => () => void;
  /**
   * Fetch the page of 50 rows before the oldest one held. Nothing is asked while a page is on its
   * way or when `hasOlder` is false. Rejects with the host's error, leaving `hasOlder` as it was.
   */
  loadOlder: () => Promise<void>;
  setUi: (update: Partial<FeedUi>) => void;
}

/** How many rows `conversations.history` is asked for at a time. */
const PAGE = 50;

/** A member answering in its session now. */
const RUNNING_MEMBER: ReadonlySet<MemberStatus> = new Set([
  "working",
  "waiting_for_input",
  "stopping",
]);

const feeds = new WeakMap<WireClient, Map<string, Feed>>();

/** The feed of a conversation on a wire; the same object every time for the same pair. */
export function feedFor(wire: WireClient, conversationId: string): Feed {
  let byConversation = feeds.get(wire);
  if (byConversation === undefined) {
    byConversation = new Map();
    feeds.set(wire, byConversation);
  }
  let feed = byConversation.get(conversationId);
  if (feed === undefined) {
    feed = createFeed(wire, conversationId);
    byConversation.set(conversationId, feed);
  }
  return feed;
}

/**
 * The transcript of a feed's state, in the reader's language. `reviewKey`, the review key named
 * for the user, ends the line that says a member waits on the user.
 */
export function feedItems(
  state: Pick<FeedState, "rows" | "members" | "agents" | "info" | "sessions">,
  locale: Locale,
  reviewKey?: string,
): TranscriptItem[] {
  return transcriptItems({
    rows: state.rows,
    members: state.members,
    agents: state.agents,
    kind: state.info?.kind,
    sessions: state.sessions,
    locale,
    reviewKey,
  });
}

type SessionSections = Partial<
  Pick<SessionViewSections, "core" | "transcript" | "ask">
>;

function createFeed(wire: WireClient, conversationId: string): Feed {
  const target = `conversations.${conversationId}`;
  const store = createStore<FeedState>(() => ({
    loaded: false,
    info: undefined,
    members: [],
    agents: [],
    rows: [],
    held: [],
    sessions: new Map(),
    hasOlder: false,
    loadingOlder: false,
    ui: { ...INITIAL_TRANSCRIPT_UI, composer: undefined },
  }));
  /** Every row seen, held replies included. */
  let known: readonly MessageView[] = [];
  let lastTimeline: TimelineSection | undefined;
  /** What the last page said about rows older than it; undefined until a page comes. */
  let olderThanPages: boolean | undefined;
  const watched = new Map<string, () => void>();
  let attachments = 0;
  let detach: (() => void) | undefined;

  const publishRows = (held: readonly MessageView[]) => {
    store.setState({
      rows: visibleRows(known, held),
      held,
      hasOlder: olderThanPages ?? lastTimeline?.hasMore === true,
    });
  };

  const changeSession = (
    sessionId: string,
    update: (live: SessionLive) => SessionLive,
  ) => {
    const sessions = store.getState().sessions;
    const was = sessions.get(sessionId) ?? emptyLive();
    const next = update(was);
    if (next === was) return;
    store.setState({ sessions: new Map(sessions).set(sessionId, next) });
  };

  const readConversation = (state: WireState) => {
    const sections = state.targets[target]?.sections as
      | Partial<Record<"info" | "members" | "timeline", unknown>>
      | undefined;
    if (sections === undefined) return;
    const timeline = sections.timeline as TimelineSection | undefined;
    if (timeline !== undefined && timeline !== lastTimeline) {
      lastTimeline = timeline;
      known = foldWindow(known, timeline.messages);
      publishRows(timeline.held);
    }
    const current = store.getState();
    const info =
      (sections.info as ConversationInfo | undefined) ?? current.info;
    const members =
      (sections.members as MemberView[] | undefined) ?? current.members;
    if (!current.loaded || info !== current.info || members !== current.members)
      store.setState({ loaded: true, info, members });
  };

  const readAgents = (state: WireState) => {
    const list = state.targets.agents?.sections.list as AgentView[] | undefined;
    if (list !== undefined && list !== store.getState().agents)
      store.setState({ agents: list });
  };

  const readSessions = (state: WireState) => {
    for (const sessionId of watched.keys()) {
      const found = state.targets[sessionTarget(sessionId)]?.sections as
        | SessionSections
        | undefined;
      const missing = state.missing[sessionTarget(sessionId)] === true;
      changeSession(sessionId, (live) => sessionRead(live, found, missing));
    }
  };

  // The events that would have cleared a stream (turn:run-end) are not heard once the watch ends.
  const unwatch = (sessionId: string, release: () => void) => {
    release();
    watched.delete(sessionId);
    changeSession(sessionId, withoutStream);
  };

  const followMembers = () => {
    const running = new Set(
      store
        .getState()
        .members.filter((member) => RUNNING_MEMBER.has(member.status))
        .flatMap((member) =>
          member.sessionId === null ? [] : [member.sessionId],
        ),
    );
    for (const [sessionId, release] of watched) {
      if (running.has(sessionId)) continue;
      unwatch(sessionId, release);
    }
    for (const sessionId of running) {
      if (watched.has(sessionId)) continue;
      changeSession(sessionId, (live) =>
        store.getState().sessions.has(sessionId)
          ? withoutStream(live)
          : { ...live },
      );
      watched.set(
        sessionId,
        watchSession(wire, sessionId, (update) =>
          changeSession(sessionId, update),
        ),
      );
    }
  };

  const read = (state: WireState) => {
    readConversation(state);
    readAgents(state);
    followMembers();
    readSessions(state);
  };

  const start = () => {
    const releases = [wire.subscribe(target), wire.subscribe("agents")];
    const stopReading = wire.store.subscribe(read);
    read(wire.store.getState());
    return () => {
      stopReading();
      for (const release of releases) release();
      for (const [sessionId, release] of watched) unwatch(sessionId, release);
    };
  };

  return {
    conversationId,
    store,
    attach() {
      attachments += 1;
      if (attachments === 1) detach = start();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        attachments -= 1;
        if (attachments > 0) return;
        detach?.();
        detach = undefined;
      };
    },
    async loadOlder() {
      const oldest = known[0]?.seq;
      const { loadingOlder, hasOlder } = store.getState();
      if (loadingOlder || !hasOlder || oldest === undefined) return;
      store.setState({ loadingOlder: true });
      try {
        const page = await wire.call<HistoryResult>(
          "conversations",
          "history",
          {
            conversationId,
            beforeSeq: oldest,
            limit: PAGE,
          },
        );
        known = mergeRows(known, page.messages);
        olderThanPages = page.messages.length > 0 && page.hasMore;
        publishRows(store.getState().held);
      } finally {
        store.setState({ loadingOlder: false });
      }
    },
    setUi(update) {
      store.setState((state) => ({ ui: { ...state.ui, ...update } }));
    },
  };
}

/** A session's live state without what its events streamed; the same object when there was none. */
function withoutStream(live: SessionLive): SessionLive {
  if (live.streamed === undefined && live.progress.size === 0) return live;
  return { ...live, streamed: undefined, progress: new Map() };
}

/**
 * A session's live state with its sections read in; unchanged values keep the same object. It is
 * unreadable while the host says the target is missing, or after a failed resync until sections
 * arrive.
 */
function sessionRead(
  live: SessionLive,
  sections: SessionSections | undefined,
  missing: boolean,
): SessionLive {
  const unreadable = missing || (sections === undefined && live.unreadable);
  if (sections === undefined)
    return unreadable === live.unreadable ? live : { ...live, unreadable };
  const rows = sections.transcript?.messages ?? live.rows;
  const coreStreaming: AgentMessage | undefined = sections.core?.streaming;
  const question = sections.ask?.pending?.question;
  if (
    rows === live.rows &&
    coreStreaming === live.coreStreaming &&
    question === live.question &&
    unreadable === live.unreadable
  )
    return live;
  return { ...live, rows, coreStreaming, question, unreadable };
}
