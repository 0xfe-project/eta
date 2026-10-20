// The chat as Workspace wires it, for one conversation: the timeline from the wire, the outbox,
// the questions and the stop calls, around the real ChatPanel.

import type { Draft } from "@/lib/composer";
import { useMemo } from "react";
import { ChatPanel } from "@/components/workspace/chat-panel";
import { EMPTY_DRAFT } from "@/lib/composer";
import { mentionedMembers } from "@/lib/mentions";
import { agentName, useAgentList } from "@/queries/agents";
import {
  useConversation,
  useConversationActions,
  useConversationList,
} from "@/queries/conversations";
import {
  useOutbox,
  useOutboxActions,
  useOutboxDelivery,
} from "@/queries/outbox";
import { useAnswerQuestion, useQuestions } from "@/queries/questions";

export function Chat({ conversationId }: { conversationId: string }) {
  const { agents } = useAgentList();
  const { conversations } = useConversationList();
  const group = conversations.find((c) => c.id === conversationId);
  const conversation = useConversation(conversationId);
  const questions = useQuestions();
  const draft = useOutbox((s) => s.drafts[conversationId] ?? EMPTY_DRAFT);
  const all = useOutbox((s) => s.outgoing);
  const arrived = useMemo(
    () => new Set(conversation.messages.map((m) => m.id)),
    [conversation.messages],
  );
  useOutboxDelivery(arrived);
  const outbox = useOutboxActions();
  const { stop } = useConversationActions();
  const { choose, abort } = useAnswerQuestion();
  const targets = (text: string) =>
    mentionedMembers(
      text,
      (group?.participants ?? []).map((m) => ({
        id: m.agentId,
        name: agentName(agents, m.agentId),
      })),
    );
  return (
    <ChatPanel
      groupId={conversationId}
      groupName={group?.name}
      group={group}
      held={[]}
      agents={agents}
      messages={conversation.messages}
      loading={!conversation.loaded}
      hasOlder={conversation.hasOlder}
      loadingOlder={conversation.loadingOlder}
      onLoadOlder={conversation.loadOlder}
      questions={questions}
      draft={draft as Draft}
      onDraftChange={(next) =>
        useOutbox.getState().setDraft(conversationId, next)
      }
      // Fresh handlers every render, as Workspace passes them.
      onSend={(text, mode, files) => {
        outbox.send(conversationId, text, mode, targets(text), files);
        useOutbox.getState().setDraft(conversationId, []);
      }}
      outgoing={all.filter(
        (o) => o.conversationId === conversationId && !arrived.has(o.id),
      )}
      onRetry={outbox.retry}
      onEdit={outbox.edit}
      onDiscard={outbox.discard}
      onResend={(text, agentId) =>
        outbox.send(
          conversationId,
          text,
          "queue",
          agentId ? [agentId] : targets(text),
        )
      }
      onCompact={() => {}}
      onStopAll={() => stop.mutate({ conversationId })}
      onStop={(messageId) => stop.mutate({ conversationId, messageId })}
      onChoose={(question, selections) => choose(question, selections)}
      onAbort={(question) => abort(question)}
      onGoal={async () => {}}
    />
  );
}
