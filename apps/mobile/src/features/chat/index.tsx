import { effect, lifecycle, signal, Text, untracked, View } from "nsh";
import type { AgentStatus, MessageStatus } from "@eta/client-contracts";
import type { TextKey } from "../../i18n";
import { agentById } from "../../app/lists";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Header, Page } from "../../ui/Page";
import { call } from "../../wire/target";
import { QuestionCard } from "../inbox/QuestionCard";
import { Composer } from "./Composer";
import { agentName, useChat } from "./conversation";
import { loadOutbox } from "./outbox";
import { queueLines } from "./queue";
import { Transcript } from "./Transcript";

const STATUS: Partial<Record<AgentStatus | MessageStatus, TextKey>> = {
  idle: "chat.agent.idle",
  working: "chat.agent.working",
  waiting_for_input: "chat.agent.waiting",
  queued: "chat.agent.queued",
};

/** How many faces the header has room for. */
const MAX_FACES = 4;

export function ChatScreen(props: { id: string }) {
  void loadOutbox();
  const chat = useChat(props.id);
  const modes = signal(false);
  const menuOpen = signal(false);
  let toBottom = () => undefined as void;
  let resend: (text: string, agentId: string | null) => void = () => undefined;

  // Reading it is what a read mark says: only while the app is in front.
  effect(() => {
    const summary = chat.summary();
    if (
      summary === undefined ||
      summary.lastSeq <= summary.readSeq ||
      lifecycle() !== "active"
    )
      return;
    untracked(
      () =>
        void call("conversations", "read", {
          conversationId: props.id,
          seq: summary.lastSeq,
        }).catch(() => undefined),
    );
  });

  const firstMember = () => chat.members()[0]?.agentId;
  const openInfo = () => {
    const member = firstMember();
    if (chat.direct() && member !== undefined) go.agentInfo(member);
    else go.groupInfo(props.id);
  };
  const title = () =>
    chat.direct()
      ? agentName(firstMember())
      : (chat.summary()?.name ?? chat.info()?.name ?? "");
  const subtitle = () => {
    if (chat.direct()) {
      // What its reply here is doing says more than the agent's status across every conversation.
      const status = chat.active()?.status ?? agentById(firstMember())?.status;
      return status === undefined
        ? undefined
        : t(STATUS[status] ?? "chat.agent.working");
    }
    const parts = [
      chat.projectName(),
      chat.stewardId() === null
        ? undefined
        : t("chat.header.steward", { name: agentName(chat.stewardId()) }),
    ].filter((part) => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(" · ");
  };
  const lines = () =>
    queueLines(chat.messages(), props.id, (agentId) => chat.sessionOf(agentId));

  return (
    <Page bottom={false}>
      <Header
        title={title()}
        subtitle={subtitle()}
        right={
          <View
            role="button"
            accessibilityLabel={t(
              chat.direct() ? "chat.header.agentInfo" : "chat.header.groupInfo",
            )}
            testID="chat-members"
            onPress={openInfo}
            class="h-11 flex-row items-center gap-[2px] active:opacity-60"
          >
            <Each
              of={chat.members().slice(0, MAX_FACES)}
              key={(member) => member.agentId}
            >
              {(member) => <AgentAvatar id={member().agentId} size={24} />}
            </Each>
          </View>
        }
      />
      <View class="min-h-0 flex-1 pb-[env(keyboard-inset-height)]">
        <View class="relative min-h-0 grow basis-0">
          <Transcript
            chat={chat}
            onResend={(text, agentId) => resend(text, agentId)}
            handle={(handle) => {
              toBottom = handle.toBottom;
            }}
          />
          <If when={modes()}>
            <View class="absolute inset-0" onPress={() => modes.set(false)} />
          </If>
        </View>
        <If when={lines().length > 0}>
          <View class="shrink-0 gap-2 px-4 pb-3">
            <Each of={lines()} key={(line) => line.agentId}>
              {(line) => (
                <View class="flex-row items-center gap-2">
                  <AgentAvatar id={line().agentId} size={20} />
                  <Text class="truncate grow basis-0 text-sm leading-[18px] text-muted-foreground">
                    {line().text}
                  </Text>
                </View>
              )}
            </Each>
          </View>
        </If>
        <View class="shrink-0" style={{ display: menuOpen() ? "none" : "flex", flexDirection: "column" }}>
          <Each of={chat.questions()} key={(question) => question.id}>
            {(question) => <QuestionCard interaction={question()} compact />}
          </Each>
        </View>
        <Composer
          chat={chat}
          modes={modes}
          menuOpen={menuOpen}
          onSent={() => toBottom()}
          bindResend={(fn) => {
            resend = fn;
          }}
        />
      </View>
    </Page>
  );
}
