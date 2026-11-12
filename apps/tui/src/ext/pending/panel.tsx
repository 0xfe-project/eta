/** The panel: what waits, then the conversations, one line each. */
import type { ConversationSummary } from "@eta/client-contracts";
import type { PendingItem } from "./model";
import type { ListLine } from "./scroll-list";
import { Text } from "ink";
import { useShell, useTheme } from "../../extensions/react";
import { useMessages } from "../../i18n/react";
import { LayerFrame } from "../../ui/components/layer-frame";
import { inkColor } from "../../ui/theme";
import { participantsStatus } from "../conversation/facts";
import { CONVERSATION_VIEW } from "../conversation/kind";
import { usePanelState, usePendingItems } from "./hooks";
import { openItemLayer } from "./item-layer";
import { statusText } from "./labels";
import { pendingMessages } from "./messages";
import { firstLine, panelConversations, questionTitle } from "./model";
import { ScrollList } from "./scroll-list";

const STATUS_MARK = {
  waiting: { mark: "!", token: "warning" },
  running: { mark: "●", token: "accent" },
} as const;

const CONVERSATION_KEY = "conversation:";

/** The waiting items and the conversations; `close` closes the panel. */
export function Panel({ close }: { close: () => void }) {
  const ctx = useShell();
  const t = useMessages(pendingMessages);
  const items = usePendingItems();
  const state = usePanelState();
  const conversations = panelConversations(state);

  const lines: ListLine[] = [
    ...(items.length > 0
      ? [
          {
            kind: "heading",
            key: "heading:waiting",
            text: t("waitingHeading"),
          } as const,
          ...items.map(
            (item): ListLine => ({
              kind: "choice",
              key: item.key,
              content: <PendingLine item={item} />,
            }),
          ),
        ]
      : []),
    ...(conversations.length > 0
      ? [
          {
            kind: "heading",
            key: "heading:conversations",
            text: t("conversationsHeading"),
          } as const,
          ...conversations.map(
            (conversation): ListLine => ({
              kind: "choice",
              key: CONVERSATION_KEY + conversation.id,
              content: <ConversationLine conversation={conversation} />,
            }),
          ),
        ]
      : []),
  ];

  const pick = (key: string) => {
    if (key.startsWith(CONVERSATION_KEY)) {
      close();
      ctx.openTab({
        kind: CONVERSATION_VIEW,
        id: key.slice(CONVERSATION_KEY.length),
      });
      return;
    }
    const item = items.find((i) => i.key === key);
    if (item === undefined) return;
    openItemLayer(
      ctx,
      {
        kind: item.kind,
        id: item.kind === "question" ? item.interaction.id : item.task.id,
      },
      "pending",
      [{ close }],
    );
  };

  const footer = [t("keyMove"), t("keyPage"), t("keyOpen"), t("keyClose")].join(
    t("footerSeparator"),
  );
  return (
    <LayerFrame title={t("panelTitle")} footer={footer}>
      {lines.length === 0 ? (
        <EmptyPanel onEscape={close} />
      ) : (
        <ScrollList lines={lines} onPick={pick} onEscape={close} />
      )}
    </LayerFrame>
  );
}

function EmptyPanel({ onEscape }: { onEscape: () => void }) {
  const t = useMessages(pendingMessages);
  return (
    <ScrollList
      lines={[{ kind: "heading", key: "empty", text: t("noConversations") }]}
      onPick={() => {}}
      onEscape={onEscape}
    />
  );
}

function PendingLine({ item }: { item: PendingItem }) {
  const t = useMessages(pendingMessages);
  const state = usePanelState();
  if (item.kind === "question")
    return (
      <Text>
        {`? ${questionTitle(state, item.interaction)}  ${firstLine(item.interaction.prompt)}`}
      </Text>
    );
  return (
    <Text>{`#${item.task.number} ${item.task.title}  ${t(statusText(item.task.status))}`}</Text>
  );
}

function ConversationLine({
  conversation,
}: {
  conversation: ConversationSummary;
}) {
  const ctx = useShell();
  const t = useMessages(pendingMessages);
  const theme = useTheme();
  const status = participantsStatus(conversation.participants);
  const mark =
    status === "waiting" || status === "running"
      ? STATUS_MARK[status]
      : undefined;
  const tabIndex = ctx.tabs.findIndex(
    (tab) => tab.kind === CONVERSATION_VIEW && tab.id === conversation.id,
  );
  return (
    <Text>
      {conversation.name}
      {mark !== undefined && (
        <>
          {" "}
          <Text color={inkColor(theme[mark.token])}>{mark.mark}</Text>
        </>
      )}
      {conversation.unread > 0 &&
        `  ${t("unread", { count: conversation.unread })}`}
      {tabIndex !== -1 && `  [${tabIndex + 1}]`}
    </Text>
  );
}
