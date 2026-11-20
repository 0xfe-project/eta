import type {
  EmailAccountView,
  EmailAssignmentView,
  EmailMessageView,
  EmailProposalView,
  EmailThreadView,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { Layout } from "../../components";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Empty,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
  sizes,
} from "../../components";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { AssignmentDetail } from "./assignment-detail";
import { AssignEmail, EmailContext, EmailProcess } from "./thread-context";
import { ThreadDetail } from "./thread-detail";
import { ThreadRow } from "./thread-row";

export function Email(props: {
  layout: Layout;
  onBack?: () => void;
  onSettings: () => void;
  onConversation: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const folder = signal<"Inbox" | "Sent">("Inbox");
  const selected = signal("");
  const checked = signal<string[]>([]);
  const selecting = signal(false);
  const refreshing = signal(false);
  const assigning = signal(false);
  const deleting = signal(false);
  const threadContext = signal<EmailMessageView | undefined>(undefined);
  const handledBy = signal<EmailAssignmentView | undefined>(undefined);
  const processing = signal<EmailAssignmentView | undefined>(undefined);
  const clearDetail = () => {
    threadContext.set(undefined);
    handledBy.set(undefined);
    processing.set(undefined);
  };
  follow(() => "email");
  const target = () => (selected() ? `email.${selected()}` : undefined);
  follow(target);
  const accounts = () => host.list<EmailAccountView>("email", "accounts");
  const threads = () =>
    host
      .list<EmailThreadView>("email", "threads")
      .filter((thread) =>
        folder() === "Inbox"
          ? thread.incomingCount > 0
          : thread.outgoingCount > 0,
      );
  const thread = () =>
    host.section<EmailThreadView>(target() ?? "", "thread") ??
    threads().find((entry) => entry.id === selected());
  const messages = () =>
    host.list<EmailMessageView>(target() ?? "", "messages");
  const rootMessage = () =>
    messages().find(
      (mail) =>
        mail.rfcMessageId && mail.rfcMessageId === thread()?.rootMessageId,
    ) ?? messages().find((mail) => mail.id === thread()?.rootMessageId);
  const proposals = () =>
    host
      .list<EmailProposalView>(target() ?? "", "proposals")
      .filter((item) => item.status === "pending" || item.status === "failed");
  const assignments = () =>
    host.list<EmailAssignmentView>(target() ?? "", "assignments");
  const phone = () => props.layout === "phone";
  const tablet = () => props.layout === "tablet";
  const contextMessage = () =>
    messages().find((mail) => mail.meta && mail.meta.carrier !== "none");
  function choose(item: EmailThreadView) {
    clearDetail();
    selected.set(item.id);
    if (item.unread)
      void host.action(() =>
        host.call("email", "markRead", { threadId: item.id, unread: false }),
      );
  }
  async function refresh() {
    if (refreshing() || !accounts().length) return;
    refreshing.set(true);
    await host.action(() => host.call("email", "refresh", {}));
    refreshing.set(false);
  }
  function openFolder(tab: "Inbox" | "Sent") {
    folder.set(tab);
    selected.set("");
    checked.set([]);
  }
  async function markUnread(id: string) {
    const result = await host.action(() =>
      host.call("email", "markRead", { threadId: id, unread: true }),
    );
    if (result && phone() && selected() === id) {
      clearDetail();
      selected.set("");
    }
  }
  return (
    <View style={grow}>
      <If when={!tablet()}>
        <Header
          title={uiText("email")}
          layout={props.layout}
          onBack={
            phone() && selected()
              ? () => {
                  clearDetail();
                  selected.set("");
                }
              : props.onBack
          }
        >
          <If when={!phone() || !selected()}>
            <Button
              label={
                refreshing() ? uiText("refreshing") : uiText("refreshMail")
              }
              icon="refresh"
              iconOnly={phone()}
              tone={phone() ? "ghost" : undefined}
              disabled={refreshing()}
              onPress={() => void refresh()}
            />
          </If>
          <If when={phone() && selected() && thread()}>
            <ActionMenu label={uiText("emailActions")}>
              <ActionItem
                label={uiText("markUnread")}
                onSelect={() => void markUnread(selected())}
              />
              <ActionItem
                label={uiText("delete")}
                tone="red"
                onSelect={() => deleting.set(true)}
              />
            </ActionMenu>
          </If>
        </Header>
      </If>
      <If
        when={accounts().length || !phone()}
        else={
          <Empty
            title={uiText("noMailboxConnected")}
            description={uiText("connectAMailboxToReadAnd")}
            icon="email"
          >
            <Button
              label={uiText("connectMailbox")}
              tone="primary"
              onPress={props.onSettings}
            />
          </Empty>
        }
      >
        <View style={{ ...row, ...grow, alignItems: "stretch" }}>
          <If when={!phone() || !selected()}>
            <View
              style={{
                ...(phone()
                  ? grow
                  : {
                      width:
                        props.layout === "desktop" ? 352 : sizes.tabletList,
                      flexShrink: 0,
                    }),
                borderRightWidth: phone() ? 0 : 1,
                borderColor: c().border,
              }}
            >
              <If when={tablet()}>
                <PaneHeader title={uiText("email")} list>
                  <Button
                    label={
                      refreshing()
                        ? uiText("refreshing")
                        : uiText("refreshMail")
                    }
                    icon="refresh"
                    iconOnly
                    disabled={refreshing()}
                    style={{ borderColor: c().border }}
                    onPress={() => void refresh()}
                  />
                </PaneHeader>
              </If>
              <View
                style={{
                  ...row,
                  minHeight: 44,
                  paddingHorizontal: 12,
                  ...(phone()
                    ? { gap: 6 }
                    : {
                        flexWrap: "wrap",
                        paddingVertical: 8,
                        columnGap: 10,
                        rowGap: 8,
                      }),
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <If
                  when={!phone()}
                  else={
                    <Each of={["Inbox", "Sent"] as const}>
                      {(tab) => (
                        <Button
                          label={uiText(
                            tab() === "Inbox" ? "inboxFolder" : "sentFolder",
                          )}
                          selected={folder() === tab()}
                          tone="ghost"
                          onPress={() => openFolder(tab())}
                        />
                      )}
                    </Each>
                  }
                >
                  <Icon name="email" size={16} />
                  <View
                    style={{
                      ...row,
                      gap: 2,
                      padding: 2,
                      backgroundColor: c().selected,
                    }}
                  >
                    <Each of={["Inbox", "Sent"] as const}>
                      {(tab) => (
                        <View
                          role="tab"
                          accessibilityLabel={uiText(
                            tab() === "Inbox" ? "inboxFolder" : "sentFolder",
                          )}
                          accessibilityState={{ selected: folder() === tab() }}
                          onPress={() => openFolder(tab())}
                          style={{
                            paddingVertical: 3,
                            paddingHorizontal: 8,
                            backgroundColor:
                              folder() === tab() ? c().canvas : "transparent",
                            cursor: "pointer",
                          }}
                        >
                          <Label
                            size={12}
                            line={16}
                            weight={folder() === tab() ? 600 : 400}
                            tone={folder() === tab() ? "ink" : "muted"}
                          >
                            {uiText(
                              tab() === "Inbox" ? "inboxFolder" : "sentFolder",
                            )}
                          </Label>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
                <View style={{ flex: 1 }} />
                <If
                  when={phone()}
                  else={
                    <If
                      when={checked().length}
                      else={
                        <Label size={12} tone="muted">
                          {threads().length}
                        </Label>
                      }
                    >
                      <Label size={12} tone="muted">
                        {uiText("countSelected", { count: checked().length })}
                      </Label>
                      <Button
                        label={uiText("deleteMail")}
                        style={{
                          borderColor: c().border,
                          paddingHorizontal: 10,
                          gap: 6,
                        }}
                        onPress={() => deleting.set(true)}
                      />
                      <Button
                        label={uiText("handCountToAnAgent", {
                          count: checked().length,
                        })}
                        tone="primary"
                        style={{ paddingHorizontal: 10 }}
                        onPress={() => assigning.set(true)}
                      />
                    </If>
                  }
                >
                  <If when={threads().length}>
                    <Button
                      label={selecting() ? uiText("done") : uiText("select2")}
                      tone="ghost"
                      size={28}
                      onPress={() => {
                        selecting.set(!selecting());
                        checked.set([]);
                      }}
                    />
                  </If>
                </If>
              </View>
              <If when={phone() && checked().length}>
                <View style={{ ...row, padding: 6, gap: 6 }}>
                  <Button
                    label={uiText("assign", { length: checked().length })}
                    onPress={() => assigning.set(true)}
                  />
                  <Button
                    label={uiText("delete")}
                    tone="danger"
                    onPress={() => deleting.set(true)}
                  />
                </View>
              </If>
              <If
                when={threads().length}
                else={
                  <If
                    when={accounts().length}
                    else={<NoMailbox onSettings={props.onSettings} />}
                  >
                    <Empty
                      title={
                        folder() === "Inbox"
                          ? uiText("inboxIsEmpty")
                          : uiText("noSentMail")
                      }
                    />
                  </If>
                }
              >
                <Scroll style={grow} scrollbar={false}>
                  <Each of={threads()} key={(item) => item.id}>
                    {(item) => (
                      <ThreadRow
                        thread={item()}
                        selected={selected() === item().id}
                        checked={checked().includes(item().id)}
                        selecting={selecting()}
                        phone={phone()}
                        onOpen={() => choose(item())}
                        onCheck={(selected) =>
                          checked.update((ids) =>
                            selected
                              ? [...ids, item().id]
                              : ids.filter((id) => id !== item().id),
                          )
                        }
                      />
                    )}
                  </Each>
                </Scroll>
              </If>
            </View>
          </If>
          <If when={!phone() || selected()}>
            <View style={grow}>
              <If when={tablet()}>
                <PaneHeader title={thread() ? uiText("email") : ""}>
                  <If when={thread() && contextMessage()}>
                    {(message) => (
                      <Button
                        label={uiText("context")}
                        icon="sidebar"
                        labelSize={11}
                        style={{ gap: 6 }}
                        onPress={() => threadContext.set(message())}
                      />
                    )}
                  </If>
                </PaneHeader>
              </If>
              <If
                when={thread()}
                else={<Empty title={uiText("chooseAnEmailToRead")} />}
              >
                {(entry) => (
                  <ThreadDetail
                    thread={entry()}
                    messages={messages()}
                    assignments={assignments()}
                    proposals={proposals()}
                    phone={phone()}
                    desktop={props.layout === "desktop"}
                    onAssign={() => assigning.set(true)}
                    onDelete={() => deleting.set(true)}
                    onMarkUnread={() => void markUnread(entry().id)}
                    onAssignment={(assignment) => handledBy.set(assignment)}
                    onContext={(message) => threadContext.set(message)}
                  />
                )}
              </If>
            </View>
          </If>
        </View>
      </If>
      <If when={threadContext()}>
        {(message) => (
          <EmailContext
            message={message()}
            layout={props.layout}
            onClose={() => threadContext.set(undefined)}
          />
        )}
      </If>
      <If when={handledBy()}>
        {(assignment) => (
          <AssignmentDetail
            assignment={assignment()}
            phone={phone()}
            message={rootMessage()}
            rootMessageId={thread()?.rootMessageId}
            onClose={() => handledBy.set(undefined)}
            onOpenSession={() => {
              const conversation = host
                .conversations()
                .find((item) =>
                  item.participants.some(
                    (member) => member.sessionId === assignment().sessionId,
                  ),
                );
              handledBy.set(undefined);
              if (conversation) props.onConversation(conversation.id);
              else processing.set(assignment());
            }}
          />
        )}
      </If>
      <If when={processing()}>
        {(assignment) => (
          <EmailProcess
            assignment={assignment()}
            phone={phone()}
            onClose={() => processing.set(undefined)}
          />
        )}
      </If>
      <If when={assigning()}>
        <AssignEmail
          ids={checked().length ? checked() : [selected()]}
          phone={phone()}
          onClose={() => assigning.set(false)}
          onAssigned={(id) => {
            checked.set([]);
            selecting.set(false);
            props.onConversation(id);
          }}
        />
      </If>
      <If when={deleting()}>
        <Modal
          title={uiText("deleteEmailThreads")}
          phone={phone()}
          onClose={() => deleting.set(false)}
        >
          <View style={{ padding: 16, gap: 8 }}>
            <Label>{uiText("deleteTheSelectedThreadsFromEta")}</Label>
            <Button
              label={uiText("delete")}
              tone="danger"
              onPress={() =>
                void host.action(async () => {
                  await host.call("email", "deleteThreads", {
                    threadIds: checked().length ? checked() : [selected()],
                  });
                  checked.set([]);
                  selected.set("");
                  deleting.set(false);
                })
              }
            />
          </View>
        </Modal>
      </If>
    </View>
  );
}

/** The list column with no mailbox: a short block at its top, not centred. */
function NoMailbox(props: { onSettings: () => void }) {
  return (
    <View
      style={{
        alignItems: "center",
        gap: 8,
        paddingVertical: 40,
        paddingHorizontal: 24,
      }}
    >
      <Icon name="email" size={24} tone="muted" />
      <Label weight={500} style={{ textAlign: "center" }}>
        {uiText("noMailboxConnected")}
      </Label>
      <Button
        label={uiText("connectMailbox")}
        style={{ marginTop: 4 }}
        onPress={props.onSettings}
      />
    </View>
  );
}

/** Tablet: the list and the open thread each carry their own 40px header. */
function PaneHeader(props: {
  title: string;
  list?: boolean;
  children?: JSX.Element;
}) {
  const c = colors();
  return (
    <View
      style={{
        ...row,
        flexShrink: 0,
        height: 40,
        gap: 8,
        paddingHorizontal: props.list ? 12 : 10,
        borderBottomWidth: 1,
        borderColor: c().border,
        backgroundColor: c().surface,
      }}
    >
      <Label weight={600} line={20} lines={1}>
        {props.title}
      </Label>
      <View style={{ flex: 1 }} />
      {props.children}
    </View>
  );
}
