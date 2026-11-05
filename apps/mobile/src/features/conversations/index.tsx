import type { AgentResults, ConversationSummary } from "@eta/client-contracts";
import type { GroupSection, StatusLine } from "./list";
import { cleanup, Scroll, signal, Text, View } from "nsh";
import { go } from "../../nav/links";
import { projectById } from "../../app/lists";
import { t } from "../../i18n";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { ago, reason } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { Header, Page } from "../../ui/Page";
import { Segmented } from "../../ui/Segmented";
import { Empty } from "../../ui/States";
import { toast } from "../../ui/toast";
import { call, useTarget } from "../../wire/target";
import { CreateSheet } from "../create/CreateSheet";
import { ConversationSheet, updateConversation } from "./ConversationSheet";
import {
  activityOf,
  agentLine,
  archivedConversations,
  directEntries,
  groupSections,
  statusLine,
  waitingDirects,
  waitingGroups,
} from "./list";

type Kind = "groups" | "directs";

const failed = (error: unknown) => toast(t("common.failed", { message: reason(error) }));

const counted = (label: string, count: number) => (count === 0 ? label : `${label} ${count}`);

function Line(props: { line: StatusLine }) {
  return (
    <If when={props.line.text !== ""}>
      <Text
        class={`truncate text-md leading-[18px] ${props.line.strong ? "text-foreground" : "text-muted-foreground"}`}
      >
        {props.line.text}
      </Text>
    </If>
  );
}

function GroupRow(props: {
  conversation: ConversationSummary;
  now: number;
  onLongPress: () => void;
}) {
  const unread = () => props.conversation.unread;
  return (
    <View
      testID={`conversation-${props.conversation.id}`}
      accessibilityLabel={props.conversation.name}
      onPress={() => go.chat(props.conversation.id)}
      onLongPress={props.onLongPress}
      class="h-[62px] shrink-0 justify-center gap-[2px] border-b border-border px-4 active:bg-muted"
    >
      <View class="flex-row items-center gap-[6px]">
        <Each of={props.conversation.participants.slice(0, 3)} key={(member) => member.agentId}>
          {(member) => <AgentAvatar id={member().agentId} size={20} />}
        </Each>
        <Text class="min-w-0 grow basis-0 truncate text-lead leading-[22px] text-foreground">
          {props.conversation.name}
        </Text>
        <If when={unread() > 0}>
          <Text class="text-micro leading-3 text-state-success">●</Text>
        </If>
        <If when={unread() > 1}>
          <Text class="text-sm leading-4 text-foreground">{unread()}</Text>
        </If>
        <Text class="min-w-[40px] shrink-0 text-right text-sm leading-4 text-muted-foreground">
          {ago(activityOf(props.conversation), props.now)}
        </Text>
      </View>
      <Line line={statusLine(props.conversation)} />
    </View>
  );
}

function Section(props: {
  section: GroupSection;
  first: boolean;
  now: number;
  onLongPress: (conversation: ConversationSummary) => void;
}) {
  return (
    <>
      <View
        class={`shrink-0 flex-row items-end justify-between border-b border-border px-4 pb-[6px] ${props.first ? "h-[30px]" : "h-[38px]"}`}
      >
        <Text class="text-sm leading-[18px] text-foreground">{props.section.project ?? ""}</Text>
        <Text class="text-sm leading-[18px] text-muted-foreground">
          {props.section.machine ?? ""}
        </Text>
      </View>
      <Each of={props.section.rows} key={(row) => row.id}>
        {(row) => (
          <GroupRow
            conversation={row()}
            now={props.now}
            onLongPress={() => props.onLongPress(row())}
          />
        )}
      </Each>
    </>
  );
}

function DirectRow(props: {
  name: string;
  agentId: string;
  line: StatusLine;
  time: string;
  onPress: () => void;
  onLongPress?: (() => void) | undefined;
}) {
  return (
    <View
      testID={`direct-${props.agentId}`}
      accessibilityLabel={props.name}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      class="h-[60px] shrink-0 flex-row items-center gap-3 border-b border-border px-4 active:bg-muted"
    >
      <AgentAvatar id={props.agentId} size={32} />
      <View class="min-w-0 grow basis-0">
        <Text class="truncate text-lead leading-[22px] text-foreground">{props.name}</Text>
        <Line line={props.line} />
      </View>
      <Text class="shrink-0 text-sm leading-4 text-muted-foreground">{props.time}</Text>
    </View>
  );
}

/** The chat with an agent is made the first time it is asked for, and found after that. */
async function openDirect(agentId: string): Promise<void> {
  try {
    const { conversation } = await call<AgentResults["direct"]>("agents", "direct", { agentId });
    go.chat(conversation.id);
  } catch (error) {
    failed(error);
  }
}

/** 02, 02a. */
export function ConversationsTab() {
  // `hello` only carries the eager lists: a subscription is what keeps them moving afterwards.
  useTarget("conversations");
  useTarget("agents");
  useTarget("projects");
  useTarget("machines");

  const kind = signal<Kind>("groups");
  const creating = signal(false);
  const pressed = signal<ConversationSummary | undefined>(undefined);
  const menu = signal(false);
  const now = signal(Date.now());
  const clock = setInterval(() => now.set(Date.now()), 30_000);
  cleanup(() => clearInterval(clock));

  const showMenu = (conversation: ConversationSummary) => {
    pressed.set(conversation);
    menu.set(true);
  };

  return (
    <View class="flex-1">
      <View class="h-14 shrink-0 flex-row items-center gap-4 px-4">
        <Text class="grow basis-0 text-gauge-sm leading-[34px] tracking-[-0.02em] text-foreground">
          {t("conversations.title")}
        </Text>
        <Text
          role="button"
          hitSlop={12}
          onPress={() => go.archived()}
          class="text-sm leading-4 text-muted-foreground active:opacity-60"
        >
          {t("conversations.archived")}
        </Text>
        <View
          role="button"
          accessibilityLabel={t("conversations.new")}
          testID="create"
          hitSlop={11}
          onPress={() => creating.set(true)}
          class="active:opacity-60"
        >
          <Icon name="plus" size={22} />
        </View>
      </View>
      <View class="shrink-0 px-4 pb-2">
        <Segmented
          options={[
            { value: "groups", label: counted(t("conversations.groups"), waitingGroups()) },
            { value: "directs", label: counted(t("conversations.directs"), waitingDirects()) },
          ]}
          value={kind()}
          onChange={(next: Kind) => kind.set(next)}
        />
      </View>
      <Scroll style={{ flex: 1 }}>
        <If
          when={kind() === "groups"}
          else={
            <View class="border-t border-border">
              <Each of={directEntries()} key={(entry) => entry.agent.id}>
                {(entry) => {
                  const chat = () => entry().conversation;
                  return (
                    <DirectRow
                      agentId={entry().agent.id}
                      name={entry().agent.name}
                      line={chat() === undefined ? agentLine(entry().agent) : statusLine(chat()!)}
                      time={chat() === undefined ? "" : ago(activityOf(chat()!), now())}
                      onPress={() => {
                        const conversation = chat();
                        if (conversation !== undefined) go.chat(conversation.id);
                        else void openDirect(entry().agent.id);
                      }}
                      onLongPress={() => {
                        const conversation = chat();
                        if (conversation !== undefined) showMenu(conversation);
                      }}
                    />
                  );
                }}
              </Each>
            </View>
          }
        >
          <If when={groupSections().length > 0} else={<Empty title={t("conversations.empty")} />}>
            <Each of={groupSections()} key={(section) => section.projectId}>
              {(section, index) => (
                <Section
                  section={section()}
                  first={index() === 0}
                  now={now()}
                  onLongPress={showMenu}
                />
              )}
            </Each>
          </If>
        </If>
      </Scroll>
      <ConversationSheet
        open={menu()}
        conversation={pressed()}
        onClose={() => menu.set(false)}
      />
      <CreateSheet open={creating()} onClose={() => creating.set(false)} />
    </View>
  );
}

function when(at: number): string {
  const date = new Date(at);
  return t("conversations.date", { month: date.getMonth() + 1, day: date.getDate() });
}

function ArchivedRow(props: { conversation: ConversationSummary }) {
  const place = () =>
    props.conversation.kind === "direct"
      ? t("conversations.directs")
      : (projectById(props.conversation.projectId)?.name ?? "");
  return (
    <View
      accessibilityLabel={props.conversation.name}
      onPress={() => go.chat(props.conversation.id)}
      class="h-16 shrink-0 flex-row items-center gap-3 border-b border-border px-4 active:bg-muted"
    >
      <View class="min-w-0 grow basis-0">
        <Text class="truncate text-lead leading-[22px] text-foreground">
          {props.conversation.name}
        </Text>
        <Text class="truncate text-md leading-[18px] text-muted-foreground">
          {`${place()} · ${when(props.conversation.updatedAt)}`}
        </Text>
      </View>
      <View
        role="button"
        accessibilityLabel={`${t("conversations.unarchive")} ${props.conversation.name}`}
        onPress={() => {
          updateConversation({ conversationId: props.conversation.id, archived: false }).catch(
            failed,
          );
        }}
        class="h-9 items-center justify-center border border-border-strong px-3 active:bg-muted"
      >
        <Text class="text-md leading-4 text-foreground">{t("conversations.unarchive")}</Text>
      </View>
    </View>
  );
}

/** 03p2. */
export function ArchivedScreen(_props: {}) {
  return (
    <Page>
      <Header title={t("conversations.archived")} />
      <Scroll style={{ flex: 1 }}>
        <If
          when={archivedConversations().length > 0}
          else={
            <View class="h-[120px] items-center justify-center">
              <Text class="text-md leading-[20px] text-muted-foreground">
                {t("conversations.archivedEmpty")}
              </Text>
            </View>
          }
        >
          <Each of={archivedConversations()} key={(row) => row.id}>
            {(row) => <ArchivedRow conversation={row()} />}
          </Each>
        </If>
      </Scroll>
    </Page>
  );
}
