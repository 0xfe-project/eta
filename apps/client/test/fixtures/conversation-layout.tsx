import type {
  ConversationSummary,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { Layout } from "../../src/components";
import { mount, signal, Text, UrlScheme, View, windowSize } from "nsh";
import { Button } from "../../src/components";
import { Conversation } from "../../src/pages/chat/conversation";
import { createHost, Host } from "../../src/services/host";

const summary: ConversationSummary = {
  id: "group",
  projectId: "project",
  kind: "group",
  name: "Website redesign",
  archived: false,
  stewardId: "Ada",
  participants: [
    { agentId: "Ada", sessionId: null, lastSeq: 0, status: "idle" },
  ],
  lastSeq: 2,
  readSeq: 2,
  unread: 0,
  preview: "",
  lastMessageAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const message = (
  seq: number,
  author: MessageView["author"],
  text: string,
): MessageView => ({
  id: `m${seq}`,
  conversationId: "group",
  seq,
  kind: "message",
  author,
  status: "done",
  revision: 1,
  agentId: author === "agent" ? "Ada" : null,
  text,
  thinking: "",
  rootMessageId: null,
  replyToId: null,
  mentions: [],
  createdAt: 0,
  updatedAt: 0,
  data: {},
});

/** Ada answering "ping", "Queued words" waiting for her, and its reply row. */
function heldTimeline(delivered: boolean): TimelineSection {
  const waiting: MessageView = {
    ...message(3, "user", "Queued words"),
    data: delivered ? { woke: ["Ada"] } : { held: true, woke: ["Ada"] },
  };
  const reply: MessageView = {
    ...message(4, "agent", ""),
    status: "queued",
    rootMessageId: waiting.id,
    replyToId: waiting.id,
  };
  const working: MessageView = {
    ...message(2, "agent", ""),
    status: delivered ? "done" : "working",
    text: delivered ? "Pong." : "",
    rootMessageId: "m1",
    replyToId: "m1",
  };
  return delivered
    ? {
        messages: [message(1, "user", "ping"), working, waiting, reply],
        hasMore: false,
        held: [],
      }
    : {
        messages: [message(1, "user", "ping"), working, reply],
        hasMore: false,
        held: [waiting],
      };
}

const captainSummary: ConversationSummary = {
  ...summary,
  id: "captain",
  kind: "captain",
  name: "Captain",
  stewardId: null,
  participants: [
    {
      agentId: "Captain",
      sessionId: null,
      lastSeq: 0,
      status: "working",
      activeReplyId: "r2",
    },
  ],
};

function captainReviewTimeline(): TimelineSection {
  const review: MessageView = {
    ...message(
      1,
      "system",
      '<captain-review>\n1. [task_stalled] Task #7 stalled\n{"taskNumber":7}\n</captain-review>',
    ),
    id: "r1",
    conversationId: "captain",
    data: { captainReview: { reviewIds: ["rev-1"] } },
  };
  const reply: MessageView = {
    ...message(2, "agent", ""),
    id: "r2",
    conversationId: "captain",
    agentId: "Captain",
    status: "working",
    replyToId: "r1",
    rootMessageId: "r1",
  };
  return { messages: [review, reply], hasMore: false, held: [] };
}

/**
 * The conversation page in one of its states, picked by the opening URL:
 * eta://fixture/loading (no timeline yet), /empty, /short, /offline (a phone
 * that lost the host before any message arrived), /held (Ada busy, one message
 * waiting for her, with the reply the host queued for it; "Deliver" hands it
 * to her lane as the host does), /captain-review (Captain replying to a
 * Supervisor review card, ready for inline Insert).
 */
function Fixture() {
  const host = createHost();
  const lastSend = signal("");
  const scenario = UrlScheme.url()?.replace("eta://fixture/", "") ?? "";
  const conversationId = scenario === "captain-review" ? "captain" : "group";
  const timeline: TimelineSection | undefined =
    scenario === "empty"
      ? { messages: [], hasMore: false, held: [] }
      : scenario === "short"
        ? {
            messages: [
              message(1, "user", "ping"),
              message(2, "agent", "Pong."),
            ],
            hasMore: false,
            held: [],
          }
        : scenario === "held"
          ? heldTimeline(false)
          : scenario === "captain-review"
            ? captainReviewTimeline()
            : undefined;
  host.state.update((s) => ({
    ...s,
    status: scenario === "offline" ? "reconnecting" : "open",
    targets: {
      ...s.targets,
      inbox: {
        sections: {
          list:
            scenario === "pending"
              ? [
                  {
                    id: "q1",
                    sessionId: "s1",
                    questionId: "q1",
                    agentId: "Ada",
                    conversationId: "group",
                    replyId: null,
                    prompt: "Continue?",
                    options: [],
                    multi: false,
                    status: "pending",
                    answer: null,
                    revision: 1,
                    createdAt: 0,
                    updatedAt: 0,
                  },
                ]
              : [],
        },
        revisions: {},
        version: 0,
      },
      conversations: {
        sections: { list: [summary, captainSummary] },
        revisions: {},
        version: 0,
      },
      ...(timeline
        ? {
            [`conversations.${conversationId}`]: {
              sections: { timeline },
              revisions: {},
              version: 0,
            },
          }
        : {}),
    },
  }));
  host.address.set({ origin: "http://example.invalid" });
  const deliver = () =>
    host.state.update((s) => ({
      ...s,
      targets: {
        ...s.targets,
        "conversations.group": {
          sections: { timeline: heldTimeline(true) },
          revisions: {},
          version: 0,
        },
      },
    }));
  // Inline insert (`conversations.send` with `into`), answered as the host does:
  // writes the user row with `data.into` into the timeline so it renders under the anchor.
  host.call = async <T,>(_target: string, action: string, args?: unknown) => {
    if (action !== "send") return undefined as T;
    const payload = (args ?? {}) as {
      conversationId?: string;
      text?: string;
      into?: string;
      mode?: "queue" | "steer";
      mentions?: string[];
      clientId?: string;
    };
    const id = payload.conversationId ?? conversationId;
    const mentions = payload.mentions ?? [];
    lastSend.set(JSON.stringify({ into: payload.into, mode: payload.mode }));
    const steered: MessageView = {
      ...message(99, "user", payload.text ?? ""),
      id: payload.clientId ?? "sent-insert",
      conversationId: id,
      createdAt: Date.UTC(2026, 10, 24, 9, 5),
      updatedAt: Date.UTC(2026, 10, 24, 9, 5),
      data: {
        woke: [],
        joined: mentions,
        ...(payload.into === undefined ? {} : { into: payload.into }),
      },
    };
    host.state.update((s) => {
      const current = s.targets[`conversations.${id}`]?.sections?.timeline as
        | TimelineSection
        | undefined;
      if (!current) return s;
      return {
        ...s,
        targets: {
          ...s.targets,
          [`conversations.${id}`]: {
            sections: {
              timeline: {
                ...current,
                messages: [...current.messages, steered],
              },
            },
            revisions: {},
            version: 0,
          },
        },
      };
    });
    return {
      message: steered,
      replies: [],
      joined: mentions,
      nobody: false,
    } as T;
  };
  const layout = (): Layout =>
    windowSize().width < 600
      ? "phone"
      : windowSize().width < 1200
        ? "tablet"
        : "desktop";
  const noop = () => {};
  return (
    <Host.Provider value={host}>
      <View style={{ flex: 1 }}>
        <If when={scenario === "held"}>
          <Button label="Deliver" onPress={deliver} />
        </If>
        <Conversation
          id={conversationId}
          captain={scenario === "captain-review"}
          rail={scenario === "short"}
          layout={layout()}
          onTask={noop}
          onRelatedTask={noop}
          onAccessLost={noop}
          onRoutines={noop}
          onCloseTask={noop}
        />
        <If when={lastSend()}>
          <Text>{lastSend()}</Text>
        </If>
      </View>
    </Host.Provider>
  );
}
mount(Fixture);
