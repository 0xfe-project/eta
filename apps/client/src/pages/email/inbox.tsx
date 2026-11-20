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
      .filter((item) => item.status !== "discarded");
  const assignments = () =>
    host.list<EmailAssignmentView>(target() ?? "", "assignments");
  const deleteIds = () => (checked().length ? checked() : [selected()]);
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
  /** The conversation the processing session belongs to, else its transcript. */
  function openSession(assignment: EmailAssignmentView) {
    const conversation = host
      .conversations()
      .find((item) =>
        item.participants.some(
          (member) => member.sessionId === assignment.sessionId,
        ),
      );
    if (conversation) props.onConversation(conversation.id);
    else processing.set(assignment);
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
              iconSize={phone() ? 18 : undefined}
              tone={phone() ? "ghost" : undefined}
              size={phone() ? 40 : undefined}
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
                onSelect={() => deleting.set(true)}
              />
            </ActionMenu>
          </If>
        </Header>
      </If>
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <If when={!phone() || !selected()}>
          <View
            style={{
              ...(phone()
                ? grow
                : {
                    width: props.layout === "desktop" ? 352 : sizes.tabletList,
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
                    refreshing() ? uiText("refreshing") : uiText("refreshMail")
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
                flexShrink: 0,
                ...(phone()
                  ? { minHeight: 44, gap: 8, paddingHorizontal: 16 }
                  : { height: 44, gap: 10, paddingHorizontal: 12 }),
                borderBottomWidth: 1,
                borderColor: c().border,
              }}
            >
              <If when={!phone()}>
                <Icon name="email" size={16} />
              </If>
              <View
                style={{
                  ...row,
                  gap: phone() ? 0 : 2,
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
                        paddingVertical: phone() ? 4 : 3,
                        paddingHorizontal: phone() ? 12 : 8,
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
              <View style={{ flex: 1 }} />
              <If
                when={phone()}
                else={
                  <Label size={12} line={16} tone="muted">
                    {checked().length
                      ? uiText("countSelected", { count: checked().length })
                      : threads().length}
                  </Label>
                }
              >
                <Label size={11} line={14} tone="muted">
                  {checked().length
                    ? uiText("countSelected", { count: checked().length })
                    : threads().length}
                </Label>
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
            <If when={checked().length}>
              <View
                style={{
                  ...row,
                  flexShrink: 0,
                  height: 40,
                  gap: 8,
                  justifyContent: "flex-end",
                  paddingHorizontal: 12,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <Button
                  label={uiText("deleteMail")}
                  icon="trash"
                  iconSize={12}
                  style={{ gap: 6 }}
                  onPress={() => deleting.set(true)}
                />
                <Button
                  label={uiText("handCountToAnAgent", {
                    count: checked().length,
                  })}
                  tone="primary"
                  onPress={() => assigning.set(true)}
                />
              </View>
            </If>
            <If
              when={threads().length}
              else={
                <If
                  when={accounts().length}
                  else={
                    <NoMailbox phone={phone()} onSettings={props.onSettings} />
                  }
                >
                  <ListNotice
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
                  onOpenSession={openSession}
                />
              )}
            </If>
          </View>
        </If>
      </View>
      <If when={threadContext()}>
        {(message) => (
          <EmailContext
            message={message()}
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
              handledBy.set(undefined);
              openSession(assignment());
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
        <DeleteMail
          count={deleteIds().length}
          phone={phone()}
          onClose={() => deleting.set(false)}
          onDelete={() =>
            void host.action(async () => {
              await host.call("email", "deleteThreads", {
                threadIds: deleteIds(),
              });
              checked.set([]);
              selected.set("");
              deleting.set(false);
            })
          }
        />
      </If>
    </View>
  );
}

/** Confirm before deleting: a compact dialog off phones; on a phone a sheet
 * over the tab bar with no close glyph and full-width Delete mail / Cancel. */
function DeleteMail(props: {
  count: number;
  phone: boolean;
  onClose: () => void;
  onDelete: () => void;
}) {
  const title = () =>
    props.count === 1
      ? uiText("deleteOneEmail")
      : uiText("deleteCountEmails", { count: props.count });
  return (
    <Modal
      title={title()}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      overPhoneNavigation={props.phone}
      hideHeader={props.phone}
      compact={!props.phone}
      titleWeight={500}
      onClose={props.onClose}
    >
      <If
        when={props.phone}
        else={
          <View style={{ paddingTop: 6 }}>
            <Label size={12} line={18} tone="muted">
              {uiText("deleteEmailsDescription")}
            </Label>
            <View
              style={{
                ...row,
                gap: 8,
                justifyContent: "flex-end",
                paddingTop: 20,
              }}
            >
              <Button
                label={uiText("cancel")}
                size={28}
                onPress={props.onClose}
              />
              <Button
                label={uiText("deleteMail")}
                tone="primary"
                size={28}
                onPress={props.onDelete}
              />
            </View>
          </View>
        }
      >
        <View style={{ ...row, height: 44, paddingLeft: 16, paddingRight: 8 }}>
          <Label weight={600} line={20} style={{ flex: 1 }}>
            {title()}
          </Label>
        </View>
        <Label
          line={20}
          tone="mutedInk"
          style={{ paddingHorizontal: 16, paddingBottom: 12 }}
        >
          {uiText("deleteEmailsDescription")}
        </Label>
        <View
          style={{
            gap: 8,
            paddingHorizontal: 16,
            paddingTop: 8,
            paddingBottom: 24,
          }}
        >
          <Button
            label={uiText("deleteMail")}
            tone="primary"
            size={40}
            labelSize={13}
            onPress={props.onDelete}
          />
          <Button
            label={uiText("cancel")}
            size={40}
            labelSize={13}
            onPress={props.onClose}
          />
        </View>
      </If>
    </Modal>
  );
}

/** The list column with no mailbox: a short block at its top, not centred. */
function NoMailbox(props: { phone: boolean; onSettings: () => void }) {
  return (
    <ListNotice phone={props.phone} title={uiText("noMailboxConnected")}>
      <Button
        label={uiText("connectMailbox")}
        size={props.phone ? 34 : undefined}
        labelSize={props.phone ? 13 : undefined}
        style={
          props.phone
            ? { marginTop: 8, paddingHorizontal: 16 }
            : { marginTop: 4 }
        }
        onPress={props.onSettings}
      />
    </ListNotice>
  );
}

/** A note at the top of the list column: the envelope, a line, and maybe an
 * action. No mailbox, or a folder with nothing in it. */
/** An empty list: an empty folder keeps the same 40pt band on every size;
 * the phone's no-mailbox state sits lower with an ink glyph. */
function ListNotice(props: {
  phone?: boolean;
  title: string;
  children?: JSX.Element;
}) {
  return (
    <View
      style={{
        alignItems: "center",
        gap: 8,
        ...(props.phone
          ? { paddingTop: 96, paddingHorizontal: 32 }
          : { paddingVertical: 40, paddingHorizontal: 24 }),
      }}
    >
      <Icon name="email" size={24} tone={props.phone ? "ink" : "muted"} />
      <Label
        weight={props.phone ? 400 : 500}
        line={20}
        style={{ textAlign: "center" }}
      >
        {props.title}
      </Label>
      {props.children}
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
