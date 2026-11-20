import type {
  BriefView,
  EmailAccountView,
  EmailAssignmentView,
  EmailMessageView,
  EmailProposalView,
  EmailResults,
  EmailThreadView,
  MachineView,
  PluginAgentLevel,
  PluginFieldView,
  PluginResults,
  PluginValue,
  PluginView,
  RoutineFields,
  RoutineInfo,
  RoutineResults,
  RoutineSchedule,
  RoutinesStatus,
  RoutineSummary,
  RunView,
  SkillFileContent,
  SkillFileEntry,
  SkillFileResults,
  SkillList,
  SkillSummary,
  SkillTarget,
  TranscriptSection,
  ViewCore,
} from "@eta/client-contracts";
import type { JSX, ScrollRef, ViewRef } from "nsh";
import type { SkillReadingPosition } from "./skill-reader";
import type { Layout } from "./ui";
import { HOURLY_STEPS, runBlocks } from "@eta/client-contracts";
import {
  cleanup,
  computed,
  effect,
  openUrl,
  Scroll,
  signal,
  untracked,
  View,
  windowSize,
} from "nsh";
import { Checkbox, Dialog, Switch, TextView } from "nsh/base";
import { follow, relativeTime, useHost } from "./host";
import { formatLocale, uiText } from "./locale";
import {
  pluginConfigText,
  PluginDetail,
  PluginSelect,
  PluginTablet,
  pluginWarnings,
  PluginWarningsDialog,
} from "./plugin-detail";
import { AgentFace } from "./shell";
import { SkillFile, skillFileLink } from "./skill-reader";
import {
  ActionItem,
  ActionMenu,
  Button,
  Caption,
  colors,
  Empty,
  Field,
  fill,
  fontFamily,
  Fonts,
  grow,
  Header,
  Icon,
  Label,
  Markdown,
  Modal,
  row,
} from "./ui";

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
  function choose(item: EmailThreadView) {
    clearDetail();
    selected.set(item.id);
    if (item.unread)
      void host.action(() =>
        host.call("email", "markRead", { threadId: item.id, unread: false }),
      );
  }
  async function refresh() {
    if (refreshing()) return;
    refreshing.set(true);
    await host.action(() => host.call("email", "refresh", {}));
    refreshing.set(false);
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
            label={refreshing() ? uiText("refreshing") : uiText("refreshMail")}
            icon="refresh"
            iconOnly={phone()}
            tone={phone() ? "ghost" : undefined}
            disabled={refreshing() || !accounts().length}
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
      <If
        when={accounts().length}
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
                      width: props.layout === "desktop" ? 352 : 288,
                      flexShrink: 0,
                    }),
                borderRightWidth: phone() ? 0 : 1,
                borderColor: c().border,
              }}
            >
              <View
                style={{
                  ...row,
                  minHeight: 44,
                  paddingHorizontal: 12,
                  gap: 6,
                  borderBottomWidth: 1,
                  borderColor: c().border,
                }}
              >
                <If when={!phone()}>
                  <Icon name="email" />
                </If>
                <Each of={["Inbox", "Sent"] as const}>
                  {(tab) => (
                    <Button
                      label={uiText(
                        tab() === "Inbox" ? "inboxFolder" : "sentFolder",
                      )}
                      selected={folder() === tab()}
                      tone="ghost"
                      onPress={() => {
                        folder.set(tab());
                        selected.set("");
                        checked.set([]);
                      }}
                    />
                  )}
                </Each>
                <View style={{ flex: 1 }} />
                <If
                  when={phone()}
                  else={
                    <Label size={12} tone="muted">
                      {threads().length}
                    </Label>
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
              <If when={checked().length}>
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
                  <Empty
                    title={
                      folder() === "Inbox"
                        ? uiText("inboxIsEmpty")
                        : uiText("noSentMail")
                    }
                  />
                }
              >
                <Scroll style={grow} scrollbar={false}>
                  <Each of={threads()} key={(item) => item.id}>
                    {(item) => (
                      <View
                        style={{
                          ...row,
                          minHeight: phone() ? 76 : 81,
                          borderBottomWidth: 1,
                          borderColor: c().border,
                          backgroundColor:
                            selected() === item().id
                              ? c().selected
                              : c().canvas,
                        }}
                      >
                        <If when={!phone() || selecting()}>
                          <Checkbox
                            accessibilityLabel={uiText("selectWithCount", {
                              value1: item().subject || "(No subject)",
                            })}
                            checked={checked().includes(item().id)}
                            onChange={({ checked: selected }) =>
                              checked.update((ids) =>
                                selected
                                  ? [...ids, item().id]
                                  : ids.filter((id) => id !== item().id),
                              )
                            }
                            style={{
                              width: 15,
                              height: 15,
                              marginLeft: 8,
                              borderWidth: 1,
                              borderColor: c().strong,
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            <If when={checked().includes(item().id)}>
                              <Icon name="check" size={10} />
                            </If>
                          </Checkbox>
                        </If>
                        <If when={phone() && !selecting()}>
                          <View
                            style={{
                              width: 7,
                              height: 7,
                              marginLeft: 16,
                              alignSelf: "flex-start",
                              marginTop: 18,
                              backgroundColor: item().unread
                                ? c().blue
                                : "transparent",
                            }}
                          />
                        </If>
                        <View
                          role="button"
                          accessibilityLabel={
                            item().subject || uiText("noSubject")
                          }
                          onPress={() => {
                            if (!phone() || !selecting()) choose(item());
                            else
                              checked.update((ids) =>
                                ids.includes(item().id)
                                  ? ids.filter((id) => id !== item().id)
                                  : [...ids, item().id],
                              );
                          }}
                          hoverStyle={{ backgroundColor: c().selected }}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            gap: 2,
                            paddingHorizontal: phone() ? 11 : 8,
                            paddingVertical: 8,
                            cursor: "pointer",
                          }}
                        >
                          <View style={{ ...row, gap: 8 }}>
                            <If when={isAgentMail(item().subject)}>
                              <EmailBadge />
                            </If>
                            <Label
                              lines={1}
                              weight={item().unread ? 600 : 400}
                              style={{ flex: 1 }}
                            >
                              {mailSubject(item().subject)}
                            </Label>
                            <Label size={10} tone="muted">
                              {relativeTime(item().lastMessageAt)}
                            </Label>
                            <If when={phone()}>
                              <Icon name="right" size={10} tone="muted" />
                            </If>
                          </View>
                          <Label size={12} tone="muted" lines={1}>
                            {item().messageCount > 1
                              ? `${item().peer} · ${item().messageCount}`
                              : item().peer}
                          </Label>
                          <Label size={12} tone="muted" lines={1}>
                            {item().lastMessage}
                          </Label>
                        </View>
                      </View>
                    )}
                  </Each>
                </Scroll>
              </If>
            </View>
          </If>
          <If when={!phone() || selected()}>
            <If
              when={thread()}
              else={<Empty title={uiText("chooseAnEmailToRead")} />}
            >
              {(entry) => (
                <View style={grow}>
                  <Scroll style={grow} scrollbar={false}>
                    <View style={{ padding: phone() ? 16 : 20, gap: 12 }}>
                      <View style={{ gap: 3 }}>
                        <If
                          when={
                            isAgentMail(entry().subject) ||
                            messages().some(
                              (message) =>
                                message.meta && message.meta.carrier !== "none",
                            )
                          }
                        >
                          <View style={{ ...row }}>
                            <EmailBadge />
                          </View>
                        </If>
                        <View style={{ ...row, gap: 6 }}>
                          <Label weight={600} size={18} style={{ flex: 1 }}>
                            {mailSubject(entry().subject)}
                          </Label>
                          <If when={!phone()}>
                            <Button
                              label={uiText("assign2")}
                              onPress={() => assigning.set(true)}
                            />
                            <Button
                              label={uiText("delete")}
                              tone="danger"
                              onPress={() => deleting.set(true)}
                            />
                            <Button
                              label={uiText("markUnread")}
                              onPress={() => void markUnread(entry().id)}
                            />
                          </If>
                        </View>
                        <If when={phone()}>
                          <Label size={12} tone="muted" lines={1}>
                            {`${entry().peer} · ${entry().messageCount}${
                              entry().messageCount === 1
                                ? " message"
                                : " messages"
                            }`}
                          </Label>
                        </If>
                      </View>
                      <Each
                        of={assignments()}
                        key={(assignment) => assignment.id}
                      >
                        {(assignment) => (
                          <View
                            role="button"
                            accessibilityLabel={uiText("processingAgent", {
                              value1:
                                host.agent(assignment().agentId)?.name ??
                                "Agent",
                            })}
                            onPress={() => handledBy.set(assignment())}
                            hoverStyle={{ backgroundColor: c().selected }}
                            style={{
                              ...row,
                              gap: 10,
                              paddingVertical: 10,
                              paddingHorizontal: phone() ? 16 : 12,
                              marginHorizontal: phone() ? -16 : 0,
                              minHeight: phone() ? 76 : 0,
                              borderWidth: 1,
                              borderLeftWidth: phone() ? 0 : 1,
                              borderRightWidth: phone() ? 0 : 1,
                              borderColor: c().border,
                              cursor: "pointer",
                            }}
                          >
                            <AgentFace id={assignment().agentId} size={20} />
                            <View style={{ flex: 1, gap: 2 }}>
                              <If when={phone()}>
                                <Label size={10} tone="muted">
                                  {uiText("processingAgent2")}
                                </Label>
                              </If>
                              <Label size={12} weight={600}>
                                {host.agent(assignment().agentId)?.name ??
                                  uiText("agent")}
                              </Label>
                              <Label size={11} tone="muted">
                                {uiText("project", {
                                  value1:
                                    host
                                      .projects()
                                      .find(
                                        (item) =>
                                          item.id === assignment().projectId,
                                      )?.name ?? "Project",
                                })}
                              </Label>
                            </View>
                            <Label size={11} tone="muted">
                              {uiText("view")}
                            </Label>
                            <Icon name="right" size={10} tone="muted" />
                          </View>
                        )}
                      </Each>
                      <Each of={messages()} key={(message) => message.id}>
                        {(message) => (
                          <MailMessage
                            message={message()}
                            subject={entry().subject}
                            phone={phone()}
                            onContext={() => threadContext.set(message())}
                          />
                        )}
                      </Each>
                      <Each of={proposals()} key={(item) => item.id}>
                        {(item) => <EmailProposal item={item()} />}
                      </Each>
                    </View>
                  </Scroll>
                  <If when={phone()}>
                    <View
                      style={{
                        borderTopWidth: 1,
                        borderColor: c().border,
                        paddingHorizontal: 16,
                        paddingVertical: 8,
                      }}
                    >
                      <Button
                        label={uiText("handToAnAgent")}
                        icon="return"
                        size={40}
                        tone="primary"
                        onPress={() => assigning.set(true)}
                      />
                    </View>
                  </If>
                </View>
              )}
            </If>
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
          <Modal
            title={uiText("processingAgent2")}
            phone={phone()}
            sheet={phone()}
            overPhoneNavigation={phone()}
            side={!phone()}
            width={360}
            height={phone() ? undefined : "100%"}
            onClose={() => handledBy.set(undefined)}
          >
            <Scroll style={{ flexShrink: 1 }}>
              <View
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: phone() ? 0 : 16,
                }}
              >
                <EmailInfo
                  label={uiText("agent")}
                  value={
                    host.agent(assignment().agentId)?.name ?? uiText("agent")
                  }
                  phoneRow={phone()}
                  agentId={assignment().agentId}
                />
                <EmailInfo
                  label={uiText("project2")}
                  phoneRow={phone()}
                  value={
                    host
                      .projects()
                      .find((item) => item.id === assignment().projectId)?.name
                  }
                />
                <EmailInfo
                  label={uiText("received")}
                  phoneRow={phone()}
                  value={new Date(
                    rootMessage()?.createdAt ?? assignment().createdAt,
                  ).toLocaleString(formatLocale(), {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                    hourCycle: "h23",
                  })}
                />
                <EmailInfo
                  label="Message-ID"
                  phoneRow={phone()}
                  compact
                  value={rootMessage()?.rfcMessageId ?? thread()?.rootMessageId}
                />
              </View>
            </Scroll>
            <View
              style={{
                paddingHorizontal: 16,
                paddingTop: phone() ? 16 : 8,
                paddingBottom: phone() ? 24 : 16,
              }}
            >
              <Button
                label={uiText("openProcessingSession")}
                tone="primary"
                size={phone() ? 40 : 32}
                onPress={() => {
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
            </View>
          </Modal>
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

function isAgentMail(subject: string): boolean {
  return /^\[eta-mp\]/i.test(subject);
}

function mailSubject(subject: string): string {
  return subject.replace(/^\[eta-mp\]\s*/i, "").trim() || "(No subject)";
}

function EmailBadge() {
  const c = colors();
  return (
    <Label
      size={9}
      line={15}
      tone="buttonInk"
      weight={600}
      style={{ backgroundColor: c().button, paddingHorizontal: 4 }}
    >
      ETA
    </Label>
  );
}

function RfcHeaders(props: { message: EmailMessageView }) {
  return (
    <>
      <EmailInfo label={uiText("from")} value={props.message.from} />
      <EmailInfo label={uiText("to2")} value={props.message.to} />
      <EmailInfo label="Message-ID" value={props.message.rfcMessageId} />
      <EmailInfo label="In-Reply-To" value={props.message.inReplyTo} />
      <EmailInfo
        label="References"
        value={props.message.references.join(", ")}
      />
    </>
  );
}

function MailMessage(props: {
  message: EmailMessageView;
  subject: string;
  phone: boolean;
  onContext: () => void;
}) {
  const c = colors();
  const fonts = Fonts();
  const headers = signal(false);
  const subject = () =>
    props.message.subject || props.subject || "(No subject)";
  const agentMail = () =>
    isAgentMail(subject()) ||
    Boolean(props.message.meta && props.message.meta.carrier !== "none");
  return (
    <View
      style={{
        padding: props.phone ? 0 : 12,
        borderWidth: props.phone ? 0 : 1,
        borderColor: c().border,
        gap: 7,
      }}
    >
      <View style={{ ...row, gap: 8, alignItems: "flex-start" }}>
        <If when={props.phone}>
          <Label
            size={10}
            line={15}
            tone="muted"
            style={{ backgroundColor: c().selected, paddingHorizontal: 4 }}
          >
            {props.message.direction === "incoming"
              ? uiText("in")
              : uiText("out")}
          </Label>
        </If>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Label size={props.phone ? 12 : 14} weight={600} lines={1}>
            {props.phone ? mailSubject(subject()) : subject()}
          </Label>
          <Label size={12} tone="muted" lines={2}>
            {uiText("fromTo", {
              from: props.message.from,
              to: props.message.to,
            })}
          </Label>
        </View>
        <Label size={11} tone="muted">
          {relativeTime(props.message.createdAt)}
        </Label>
      </View>
      <View
        style={{
          padding: props.phone ? 12 : 0,
          borderWidth: props.phone ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If
          when={
            agentMail() ||
            !props.message.html ||
            (!props.phone && !!props.message.text)
          }
          else={
            <TextView
              html={props.message.html}
              selectable
              styles={{
                root: {
                  fontFamily: fontFamily(fonts().interface),
                  fontSize: 14,
                  lineHeight: 22,
                  color: c().ink,
                },
              }}
              renderImage={(image) => (
                <Label tone="muted">{image.alt || uiText("image")}</Label>
              )}
              links="open"
            />
          }
        >
          <If
            when={agentMail()}
            else={<Label line={22}>{props.message.text}</Label>}
          >
            <Markdown
              value={props.message.text || "No message body"}
              line={22}
            />
          </If>
        </If>
      </View>
      <If when={props.message.rfcMessageId}>
        <View
          role="button"
          accessibilityLabel={uiText("rfc5322Headers")}
          accessibilityState={{ expanded: headers() }}
          onPress={() => headers.set(!headers())}
          hoverStyle={{ backgroundColor: c().selected }}
          style={{
            ...row,
            gap: 8,
            minHeight: 34,
            borderWidth: 1,
            borderColor: c().border,
            paddingHorizontal: 10,
            cursor: "pointer",
          }}
        >
          <Icon name={headers() ? "down" : "right"} size={10} />
          <Label size={11} weight={600}>
            {uiText("rfc5322Headers")}
          </Label>
          <Label size={11} tone="muted" lines={1} style={{ flex: 1 }}>
            {props.message.rfcMessageId}
          </Label>
        </View>
      </If>
      <If when={headers()}>
        <View style={{ borderTopWidth: 1, borderColor: c().border }}>
          <RfcHeaders message={props.message} />
        </View>
      </If>
      <If when={props.message.meta && props.message.meta.carrier !== "none"}>
        <Button
          label={uiText("threadContext")}
          icon="context"
          style={{ alignSelf: "flex-start" }}
          onPress={props.onContext}
        />
      </If>
    </View>
  );
}

function EmailInfo(props: {
  label: string;
  value?: string | null;
  phoneRow?: boolean;
  compact?: boolean;
  agentId?: string;
}) {
  const c = colors();
  return (
    <If when={props.value}>
      <View
        style={{
          ...row,
          minHeight: props.phoneRow ? 48 : 42,
          gap: 12,
          borderTopWidth: props.phoneRow ? 1 : 0,
          borderBottomWidth: props.phoneRow ? 0 : 1,
          borderColor: c().border,
        }}
      >
        <Label size={12} tone="muted" style={{ width: 88, flexShrink: 0 }}>
          {props.label}
        </Label>
        <If when={props.agentId && props.phoneRow}>
          <AgentFace id={props.agentId} size={20} />
        </If>
        <Label
          size={props.phoneRow && !props.compact ? 14 : 12}
          weight={props.phoneRow && props.agentId ? 600 : undefined}
          style={{ flex: 1, minWidth: 0 }}
        >
          {props.value}
        </Label>
      </View>
    </If>
  );
}

function EmailContext(props: {
  message: EmailMessageView;
  layout: Layout;
  onClose: () => void;
}) {
  const c = colors();
  const meta = () => props.message.meta;
  const phone = () => props.layout === "phone";
  return (
    <Modal
      title={uiText("threadContext")}
      width={360}
      height={phone() ? "74%" : "100%"}
      side={!phone()}
      phone={phone()}
      onClose={props.onClose}
    >
      <Scroll style={grow} scrollbar={false}>
        <View style={{ padding: 12, gap: 12 }}>
          <If when={meta() && meta()!.carrier !== "none"}>
            <View
              style={{
                padding: 12,
                backgroundColor: c().surface,
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label weight={600}>{uiText("agentCommunicationContext")}</Label>
              <EmailInfo
                label={uiText("agent")}
                value={meta()?.agentName ?? meta()?.agentId}
              />
              <EmailInfo label={uiText("protocol")} value={meta()?.protocol} />
              <EmailInfo
                label={uiText("dataPoints")}
                value={String(meta()?.packetCount ?? 0)}
              />
              <EmailInfo
                label={uiText("signature")}
                value={
                  meta()?.signatureValid === true
                    ? "Verified"
                    : meta()?.signaturePresent
                      ? "Unverified"
                      : "Not signed"
                }
              />
              <EmailInfo
                label={uiText("mailThread")}
                value={meta()?.mailThreadId}
              />
              <EmailInfo label={uiText("session")} value={meta()?.sessionId} />
              <EmailInfo label="Task" value={meta()?.taskId} />
              <EmailInfo
                label={uiText("currentWork")}
                value={meta()?.payload?.work.doing}
              />
              <EmailInfo
                label={uiText("question")}
                value={meta()?.payload?.ask.question}
              />
              <If when={meta()?.decodeError}>
                <Label size={12} tone="red">
                  {meta()?.decodeError}
                </Label>
              </If>
            </View>
          </If>
        </View>
      </Scroll>
    </Modal>
  );
}

function EmailProcess(props: {
  assignment: EmailAssignmentView;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const target = () => `sessions.${props.assignment.sessionId}`;
  follow(target);
  const transcript = () =>
    host.section<TranscriptSection>(target(), "transcript");
  const steps = () =>
    runBlocks(
      transcript()?.messages.filter(
        (message) => message.at >= props.assignment.createdAt - 1,
      ) ?? [],
      host.section<ViewCore>(target(), "core")?.streaming,
    );
  return (
    <Modal
      title={uiText("processingSession")}
      phone={props.phone}
      width={620}
      height={props.phone ? "90%" : 520}
      onClose={props.onClose}
    >
      <Scroll style={grow}>
        <View style={{ padding: 16, gap: 12 }}>
          <If
            when={steps().length}
            else={
              <Label tone="muted">
                {host.state().missing[target()]
                  ? uiText("sessionUnavailable")
                  : transcript()
                    ? uiText("noStepsYet")
                    : uiText("loadingSession")}
              </Label>
            }
          >
            <Each of={steps()} key={(step) => step.id}>
              {(step) => (
                <Markdown
                  value={
                    "text" in step()
                      ? (step() as { text: string }).text
                      : "name" in step()
                        ? (step() as { name: string }).name
                        : "Message joined this run"
                  }
                />
              )}
            </Each>
          </If>
        </View>
      </Scroll>
    </Modal>
  );
}

function AssignEmail(props: {
  ids: string[];
  phone: boolean;
  onClose: () => void;
  onAssigned: (id: string) => void;
}) {
  const host = useHost();
  const agent = signal("");
  const project = signal("");
  const busy = signal(false);
  return (
    <Modal
      title={uiText("assignEmail")}
      phone={props.phone}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 8 }}>
        <Caption text={uiText("agent")} />
        <View style={{ ...row, flexWrap: "wrap", gap: 5 }}>
          <Each of={host.people()} key={(item) => item.id}>
            {(item) => (
              <Button
                label={item().name}
                selected={agent() === item().id}
                onPress={() => agent.set(item().id)}
              />
            )}
          </Each>
        </View>
        <Caption text={uiText("project2")} />
        <View style={{ ...row, flexWrap: "wrap", gap: 5 }}>
          <Each
            of={host
              .projects()
              .filter((item) => item.kind === "project" && !item.archived)}
            key={(item) => item.id}
          >
            {(item) => (
              <Button
                label={item().name}
                selected={project() === item().id}
                onPress={() => project.set(item().id)}
              />
            )}
          </Each>
        </View>
        <Button
          label={uiText("assign2")}
          tone="primary"
          disabled={!agent() || !project() || busy()}
          onPress={() =>
            void (async () => {
              if (busy()) return;
              busy.set(true);
              const result = await host.action(() =>
                host.call<EmailResults["assign"]>("email", "assign", {
                  threadIds: props.ids,
                  agentId: agent(),
                  projectId: project(),
                }),
              );
              busy.set(false);
              if (result) {
                props.onClose();
                props.onAssigned(result.conversationId);
              }
            })()
          }
        />
      </View>
    </Modal>
  );
}

export function EmailProposal(props: { item: EmailProposalView }) {
  const host = useHost();
  const c = colors();
  const subject = signal(props.item.subject);
  const body = signal(props.item.markdown);
  const to = signal(props.item.to);
  const busy = signal(false);
  async function decide(send: boolean) {
    if (busy()) return;
    busy.set(true);
    await host.action(() =>
      send
        ? host.call("email", "confirmProposal", {
            proposalId: props.item.id,
            subject: subject(),
            markdown: body(),
            to: to(),
          })
        : host.call("email", "discardProposal", { proposalId: props.item.id }),
    );
    busy.set(false);
  }
  return (
    <View
      style={{ padding: 12, borderWidth: 1, borderColor: c().border, gap: 6 }}
    >
      <Caption text={uiText("proposedEmail")} />
      <If when={props.item.error}>
        <Label size={12} tone="red">
          {props.item.error}
        </Label>
      </If>
      <Field label={uiText("to2")} value={to()} onChange={to.set} />
      <Field
        label={uiText("subject")}
        value={subject()}
        onChange={subject.set}
      />
      <Field
        label={uiText("emailBody")}
        value={body()}
        onChange={body.set}
        multiline
        style={{ height: 100 }}
      />
      <View style={{ ...row, gap: 6, justifyContent: "flex-end" }}>
        <Button
          label={uiText("discard")}
          tone="danger"
          disabled={busy()}
          onPress={() => void decide(false)}
        />
        <Button
          label={uiText("sendEmail")}
          tone="primary"
          disabled={busy() || !to().trim()}
          onPress={() => void decide(true)}
        />
      </View>
    </View>
  );
}

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
function weekday(day: number) {
  return formatLocale() === "zh-CN"
    ? `周${"日一二三四五六"[day]}`
    : weekdays[day]!;
}

function scheduleLabel(schedule: RoutineSchedule) {
  switch (schedule.kind) {
    case "daily":
      return uiText("routineEveryDayAt", { time: schedule.time });
    case "weekly":
      return uiText("routineDaysAt", {
        days: schedule.days
          .map(weekday)
          .join(formatLocale() === "zh-CN" ? "、" : ", "),
        time: schedule.time,
      });
    case "hourly":
      return uiText("everyHours", { hours: schedule.every });
    case "cron":
      return schedule.cron;
  }
}

function routineCopy(english: string, chinese: string) {
  return formatLocale() === "zh-CN" ? chinese : english;
}

function mobileSchedule(schedule: RoutineSchedule) {
  return schedule.kind === "daily"
    ? routineCopy(`Every day ${schedule.time}`, `每天 ${schedule.time}`)
    : scheduleLabel(schedule);
}

function runAgo(at: number) {
  const minutes = Math.max(0, Math.floor((Date.now() - at) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(formatLocale(), {
    numeric: "auto",
  });
  if (minutes >= 1440)
    return formatter.format(-Math.floor(minutes / 1440), "day");
  if (minutes >= 60) return formatter.format(-Math.floor(minutes / 60), "hour");
  return formatter.format(-minutes, "minute");
}

function RoutineHistory(props: {
  runs: RoutineSummary["runs"];
  full?: boolean;
}) {
  const c = colors();
  return (
    <View style={{ ...row, gap: 4 }}>
      <Each of={runHistory(props.runs)} key="index">
        {(status) => (
          <View
            style={{
              ...(props.full
                ? { flex: 1, height: 8 }
                : { width: 13, height: 6 }),
              backgroundColor:
                status() === "failed"
                  ? c().red
                  : status() === "running"
                    ? c().blue
                    : status() === "sent" || status() === "no_news"
                      ? c().green
                      : c().border,
            }}
          />
        )}
      </Each>
    </View>
  );
}

function PhoneRoutineRow(props: {
  item: RoutineSummary;
  paused: boolean;
  onOpen: () => void;
}) {
  const c = colors();
  const recent = () => props.item.runs[0];
  const failed = () => recent()?.status === "failed";
  const details = () =>
    [
      mobileSchedule(props.item.schedule),
      props.paused
        ? uiText("captainIsOff")
        : !props.item.enabled
          ? uiText("paused")
          : failed()
            ? routineCopy("last run failed", "上次运行失败")
            : recent()?.status === "running"
              ? uiText("running")
              : recent()?.status === "skipped"
                ? routineCopy("last run skipped", "上次运行已跳过")
                : recent()
                  ? routineCopy(
                      `ran ${runAgo(recent()!.startedAt)}`,
                      `${runAgo(recent()!.startedAt)}运行`,
                    )
                  : undefined,
      props.item.unseenReports
        ? routineCopy(
            `${props.item.unseenReports} new ${props.item.unseenReports === 1 ? "report" : "reports"}`,
            `${props.item.unseenReports} 份新报告`,
          )
        : undefined,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <View
      role="button"
      accessibilityLabel={props.item.name}
      accessibilityDescription={details()}
      onPress={props.onOpen}
      hoverStyle={{ backgroundColor: c().selected }}
      focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
      style={{
        ...row,
        minHeight: 76,
        paddingHorizontal: 16,
        gap: 14,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: "pointer",
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Label lines={1} line={20}>
          {props.item.name}
        </Label>
        <Label size={11} lines={1} line={14} tone={failed() ? "ink" : "muted"}>
          {details()}
        </Label>
        <RoutineHistory runs={props.item.runs} />
      </View>
      <If
        when={props.item.unseenFailures || failed() || props.item.unseenReports}
      >
        <View
          style={{
            width: 6,
            height: 6,
            backgroundColor:
              props.item.unseenFailures || failed() ? c().red : c().blue,
          }}
        />
      </If>
      <Icon name="right" size={10} tone="muted" />
    </View>
  );
}

export function Routines(props: {
  layout: Layout;
  initialId?: string;
  onCaptain: () => void;
  onBack?: () => void;
}) {
  const host = useHost();
  const c = colors();
  const selected = signal(props.initialId ?? "");
  const editing = signal<"new" | "edit" | null>(null);
  const drawer = signal(false);
  const readingBrief = signal(false);
  const list = () => host.list<RoutineSummary>("routines");
  follow(() => "routines");
  const target = () => (selected() ? `routines.${selected()}` : undefined);
  follow(target);
  const info = () => host.section<RoutineInfo>(target() ?? "", "info");
  const briefs = () => host.list<BriefView>(target() ?? "", "briefs");
  const runs = () => host.list<RunView>(target() ?? "", "runs");
  const status = () => host.section<RoutinesStatus>("routines", "status");
  const report = signal("");
  const reportIndex = () => runs().findIndex((run) => run.id === report());
  const current = () => runs()[reportIndex()];
  const paused = () => status() && !status()?.captainOn;
  const phone = () => props.layout === "phone";
  const feedback = signal("");
  const starting = signal(false);
  const latest = () => runs().find((run) => run.status === "sent");
  const canRun = () =>
    !!status()?.captainOn &&
    !starting() &&
    !runs().some((run) => run.status === "running");
  function toggle(item: RoutineInfo) {
    void host.action(() =>
      host.call("routines", "update", {
        routineId: item.id,
        enabled: !item.enabled,
      }),
    );
  }
  function select(id: string) {
    selected.set(id);
    report.set("");
    feedback.set("");
    if (id)
      void host.action(() => host.call("routines", "seen", { routineId: id }));
  }
  function openReport(id: string) {
    report.set(id);
    feedback.set("");
  }

  async function retry(routineId: string) {
    if (!canRun()) return;
    starting.set(true);
    const result = await host.action(() =>
      host.call<{ run: { id: string } }>("routines", "run", { routineId }),
    );
    starting.set(false);
    if (result) openReport(result.run.id);
  }

  function editor() {
    return (
      <RoutineEditor
        phone={phone()}
        inline={!phone()}
        item={editing() === "edit" ? info() : undefined}
        brief={editing() === "edit" ? briefs()[0]?.text : undefined}
        onClose={() => editing.set(null)}
        onSave={select}
      />
    );
  }

  const pageHeader = () => (
    <Header
      title={
        phone() && current()
          ? uiText("runReport")
          : props.layout !== "desktop" && info()
            ? info()!.name
            : uiText("routines2")
      }
      layout={props.layout}
      onBack={
        phone() && current()
          ? () => openReport("")
          : phone() && selected()
            ? () => select("")
            : props.onBack
      }
    >
      <If when={props.layout === "desktop"}>
        <Button
          label={uiText("newRoutine")}
          icon="plus"
          tone="primary"
          onPress={() => editing.set("new")}
        />
      </If>
      <If when={phone() && !selected()}>
        <Label size={11} tone="muted">
          {uiText("pending")}
        </Label>
        <ActionMenu
          label={uiText("routineActions")}
          triggerStyle={{ minWidth: 24, paddingHorizontal: 3 }}
        >
          <ActionItem
            label={uiText("newRoutine")}
            onSelect={() => editing.set("new")}
          />
        </ActionMenu>
      </If>
      <If when={phone() && info() && !current()}>
        <ActionMenu label={uiText("routineActions")}>
          <ActionItem
            label={info()?.enabled ? uiText("pause") : uiText("resume")}
            onSelect={() => {
              if (info()) toggle(info()!);
            }}
          />
          <ActionItem
            label={uiText("edit")}
            onSelect={() => editing.set("edit")}
          />
        </ActionMenu>
      </If>
      <If when={props.layout === "tablet" && !editing()}>
        <Button
          label="Captain"
          tone="ghost"
          size={26}
          onPress={props.onCaptain}
        />
        <Button
          label={uiText("panel")}
          icon="sidebar"
          onPress={() => drawer.set(true)}
        />
      </If>
    </Header>
  );
  const pauseBanner = () => (
    <If when={paused() && !current()}>
      <View
        style={{
          paddingHorizontal: phone() ? 12 : props.layout === "tablet" ? 14 : 11,
          paddingVertical: props.layout === "desktop" ? 7 : 12,
          marginHorizontal: phone() ? 16 : props.layout === "tablet" ? 12 : 21,
          marginTop: props.layout === "desktop" ? 11 : 12,
          marginBottom: phone() ? 4 : props.layout === "tablet" ? 12 : 0,
          gap: 4,
          borderWidth: 1,
          borderColor: `${c().amber}66`,
          backgroundColor: c().amberFill,
        }}
      >
        <Label size={props.layout === "tablet" ? 13 : 14} weight={600}>
          {uiText("captainIsOffSoRoutinesAre")}
        </Label>
        <Label size={12} line={16} tone="mutedInk">
          {status()?.reason === "no_model"
            ? uiText("captainHasNoModelChooseOne")
            : uiText("turnOnCaptainToResumeRoutines")}
        </Label>
        <If
          when={
            status()?.reason === "supervisor_off" &&
            host.can("captain.setSetting")
          }
        >
          <Button
            label={uiText("turnCaptainOn")}
            size={28}
            style={{ alignSelf: "flex-start" }}
            onPress={() =>
              void host.action(() =>
                host.call("captain", "setSetting", {
                  key: "supervisorEnabled",
                  value: true,
                }),
              )
            }
          />
        </If>
      </View>
    </If>
  );
  return (
    <View style={grow}>
      <If when={props.layout !== "tablet"}>
        {pageHeader()}
        {pauseBanner()}
      </If>
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <If when={!phone() || !selected()}>
          <View
            style={{
              ...(phone()
                ? grow
                : {
                    width:
                      props.layout === "desktop"
                        ? 352
                        : windowSize().width < 960
                          ? 280
                          : 320,
                    flexShrink: 0,
                  }),
              borderRightWidth: phone() ? 0 : 1,
              borderColor: c().border,
            }}
          >
            <If when={props.layout === "tablet"}>
              <Header
                title={uiText("routines2")}
                count={list().length}
                layout="tablet"
                inset={14}
              >
                <View style={{ flex: 1 }} />
                <Button
                  icon="plus"
                  label={uiText("newRoutine")}
                  iconOnly
                  size={28}
                  tone="ghost"
                  onPress={() => editing.set("new")}
                />
              </Header>
            </If>
            <If
              when={list().length}
              else={
                <Empty
                  title={
                    host.state().targets.routines
                      ? uiText("noRoutinesYet")
                      : uiText("loadingRoutine")
                  }
                  description={
                    host.state().targets.routines
                      ? uiText("emptyRoutineHelp")
                      : undefined
                  }
                  icon="routines"
                >
                  <If when={host.can("routines.create") && !editing()}>
                    <Button
                      label={uiText("newRoutine")}
                      icon="plus"
                      onPress={() => editing.set("new")}
                    />
                  </If>
                </Empty>
              }
            >
              <Scroll style={grow} scrollbar={false}>
                <View style={{ paddingTop: phone() ? 0 : 8 }}>
                  <Each of={list()} key={(item) => item.id}>
                    {(item) => (
                      <If
                        when={phone()}
                        else={
                          <View
                            role="button"
                            accessibilityLabel={item().name}
                            onPress={() => select(item().id)}
                            hoverStyle={{ backgroundColor: c().selected }}
                            style={{
                              ...row,
                              paddingHorizontal: 20,
                              minHeight: 52,
                              borderColor: c().border,
                              justifyContent: "space-between",
                              gap: 6,
                              cursor: "pointer",
                              backgroundColor:
                                selected() === item().id
                                  ? c().selected
                                  : c().canvas,
                            }}
                          >
                            <View style={{ flex: 1, minWidth: 0 }}>
                              <Label lines={1}>{item().name}</Label>
                              <Label size={12} tone="muted">
                                {scheduleLabel(item().schedule)}
                              </Label>
                            </View>
                            <View style={{ alignItems: "flex-end", gap: 3 }}>
                              <View style={{ ...row, gap: 3 }}>
                                <Each of={runHistory(item().runs)}>
                                  {(entry) => (
                                    <View
                                      style={{
                                        width: 7,
                                        height: 7,
                                        backgroundColor:
                                          entry() === "failed"
                                            ? c().red
                                            : entry() === "running"
                                              ? c().blue
                                              : entry() === "sent"
                                                ? c().ink
                                                : c().border,
                                      }}
                                    />
                                  )}
                                </Each>
                              </View>
                              <Label size={12} tone="muted">
                                {paused()
                                  ? uiText("captainIsOff")
                                  : !item().enabled
                                    ? uiText("paused")
                                    : item().nextRunAt
                                      ? uiText("nextWithCount", {
                                          clockDistance: clockDistance(
                                            item().nextRunAt!,
                                          ),
                                        })
                                      : uiText("noUpcomingRun")}
                              </Label>
                            </View>
                          </View>
                        }
                      >
                        <PhoneRoutineRow
                          item={item()}
                          paused={!!paused()}
                          onOpen={() => select(item().id)}
                        />
                      </If>
                    )}
                  </Each>
                </View>
              </Scroll>
            </If>
          </View>
        </If>
        <If when={!phone() || selected()}>
          <View style={grow}>
            <If when={props.layout === "tablet"}>
              {pageHeader()}
              {pauseBanner()}
            </If>
            <If when={!phone() && editing()}>{editor()}</If>
            <If when={(phone() && selected()) || (!phone() && !editing())}>
              <If
                when={info()}
                else={
                  <Empty
                    title={
                      selected()
                        ? uiText("loadingRoutine")
                        : uiText("selectARoutine")
                    }
                    description={
                      selected() ? undefined : uiText("selectOneOnTheLeftTo")
                    }
                    icon="routines"
                  />
                }
              >
                {(item) => (
                  <If
                    when={current()}
                    else={
                      <View style={grow}>
                        <If when={!phone()}>
                          <View
                            style={{
                              paddingVertical: 10,
                              paddingHorizontal: 24,
                              gap: 4,
                              borderBottomWidth: 1,
                              borderColor: c().border,
                            }}
                          >
                            <View style={{ ...row, gap: 8 }}>
                              <Label size={16} weight={600} style={{ flex: 1 }}>
                                {item().name}
                              </Label>
                              <Button
                                label={
                                  item().enabled
                                    ? uiText("pause")
                                    : uiText("resume")
                                }
                                onPress={() => toggle(item())}
                              />
                              <ActionMenu label={uiText("routineActions")}>
                                <ActionItem
                                  label={uiText("edit")}
                                  onSelect={() => editing.set("edit")}
                                />
                              </ActionMenu>
                            </View>
                            <View style={{ ...row, gap: 8 }}>
                              <Label
                                size={12}
                                tone="muted"
                                style={{ width: 76 }}
                              >
                                {uiText("schedule")}
                              </Label>
                              <Label
                                size={12}
                                tone="muted"
                              >{`${scheduleLabel(item().schedule)} · ${item().timezone}`}</Label>
                            </View>
                            <View style={{ ...row, gap: 8 }}>
                              <Label
                                size={12}
                                tone="muted"
                                style={{ width: 76 }}
                              >
                                {uiText("briefV", {
                                  value1: briefs()[0]?.version ?? 1,
                                })}
                              </Label>
                              <Label
                                size={12}
                                tone="muted"
                                lines={1}
                                style={{ flex: 1 }}
                              >
                                {briefs()[0]?.text ?? ""}
                              </Label>
                              <Button
                                label={uiText("readBrief")}
                                tone="ghost"
                                onPress={() => readingBrief.set(true)}
                              />
                              <Button
                                label={uiText("edit")}
                                tone="ghost"
                                onPress={() => editing.set("edit")}
                              />
                            </View>
                          </View>
                        </If>
                        <View
                          style={{
                            ...row,
                            minHeight: 44,
                            paddingHorizontal: 16,
                            gap: 8,
                            borderBottomWidth: 1,
                            borderColor: c().border,
                          }}
                        >
                          <Label size={12} tone="muted" style={{ flex: 1 }}>
                            {item().nextRunAt
                              ? uiText("nextReport", {
                                  routineTime: routineTime(item().nextRunAt!),
                                  clockDistance: clockDistance(
                                    item().nextRunAt!,
                                  ),
                                })
                              : item().enabled
                                ? uiText("noUpcomingRun")
                                : uiText("paused")}
                          </Label>
                          <Button
                            label={uiText("runNow")}
                            tone="ghost"
                            disabled={!canRun()}
                            onPress={() => void retry(item().id)}
                          />
                        </View>
                        <Scroll style={grow} scrollbar={false}>
                          <View style={{ padding: phone() ? 16 : 24, gap: 10 }}>
                            <If
                              when={latest()}
                              else={
                                <Label tone="muted">
                                  {uiText("noReportsYet")}
                                </Label>
                              }
                            >
                              {(run) => (
                                <RoutineFeedCard
                                  run={run()}
                                  latest
                                  onOpen={() => openReport(run().id)}
                                  onRetry={() => void retry(item().id)}
                                  canRetry={canRun()}
                                />
                              )}
                            </If>
                            <If
                              when={runs().some(
                                (run) => run.id !== latest()?.id,
                              )}
                            >
                              <Label
                                size={12}
                                tone="muted"
                                style={{ paddingTop: 12 }}
                              >
                                {uiText("earlierReports")}
                              </Label>
                              <View
                                style={{
                                  flexDirection:
                                    props.layout === "desktop"
                                      ? "row"
                                      : "column",
                                  flexWrap: "wrap",
                                  gap: 10,
                                }}
                              >
                                <Each
                                  of={runs().filter(
                                    (run) => run.id !== latest()?.id,
                                  )}
                                  key={(run) => run.id}
                                >
                                  {(run) => (
                                    <View
                                      style={{
                                        flexBasis:
                                          props.layout === "desktop"
                                            ? "48%"
                                            : undefined,
                                        flexGrow: 1,
                                      }}
                                    >
                                      <RoutineFeedCard
                                        run={run()}
                                        onOpen={() => openReport(run().id)}
                                        onRetry={() => void retry(item().id)}
                                        canRetry={canRun()}
                                      />
                                    </View>
                                  )}
                                </Each>
                              </View>
                            </If>
                          </View>
                        </Scroll>
                      </View>
                    }
                  >
                    <RoutineReport
                      routine={item()}
                      run={current()!}
                      index={reportIndex()}
                      count={runs().length}
                      phone={phone()}
                      runs={runs()}
                      onBack={() => openReport("")}
                      onMove={(by) => {
                        const run = runs()[reportIndex() + by];
                        if (run) openReport(run.id);
                      }}
                      canRetry={canRun()}
                      onRetry={() => void retry(item().id)}
                      onToggle={() => toggle(item())}
                      onEdit={() => {
                        openReport("");
                        editing.set("edit");
                      }}
                      feedback={feedback()}
                      onFeedback={feedback.set}
                      onSend={() =>
                        void host.action(async () => {
                          await host.call("routines", "feedback", {
                            routineId: item().id,
                            runId: report(),
                            text: feedback().trim(),
                          });
                          feedback.set("");
                        })
                      }
                    />
                  </If>
                )}
              </If>
            </If>
          </View>
        </If>
      </View>
      <If when={phone() && editing()}>{editor()}</If>
      <If when={readingBrief()}>
        <Modal
          title={uiText("routineBrief")}
          width={640}
          height={460}
          phone={phone()}
          onClose={() => readingBrief.set(false)}
        >
          <Scroll style={grow}>
            <View style={{ padding: 16 }}>
              <Markdown value={briefs()[0]?.text ?? ""} />
            </View>
          </Scroll>
        </Modal>
      </If>
      <If when={drawer()}>
        <Modal
          title={uiText("pending")}
          width={360}
          height="100%"
          side
          overPhoneNavigation
          blurBackdrop={false}
          onClose={() => drawer.set(false)}
        >
          <Scroll style={grow}>
            <View style={{ padding: 12, gap: 8 }}>
              <Each
                of={list()
                  .flatMap((routine) =>
                    routine.runs
                      .filter(
                        (run) =>
                          run.status === "sent" || run.status === "failed",
                      )
                      .slice(0, 3)
                      .map((run) => ({ routine, run })),
                  )
                  .sort((a, b) => b.run.startedAt - a.run.startedAt)}
                key={(entry) => entry.run.id}
              >
                {(entry) => (
                  <View
                    style={{
                      padding: 12,
                      gap: 5,
                      borderWidth: 1,
                      borderColor: c().border,
                    }}
                  >
                    <Label size={11} tone="muted">
                      {uiText("routine", {
                        value1:
                          entry().run.status === "sent" ? "report" : "failure",
                        routineTime: routineTime(entry().run.startedAt),
                      })}
                    </Label>
                    <Label
                      size={13}
                    >{`${entry().routine.name}: ${entry().run.title ?? "No report"}`}</Label>
                    <Button
                      label={
                        entry().run.status === "sent"
                          ? uiText("openReport")
                          : uiText("viewRun")
                      }
                      tone="ghost"
                      style={{ alignSelf: "flex-start" }}
                      onPress={() => {
                        select(entry().routine.id);
                        openReport(entry().run.id);
                        drawer.set(false);
                      }}
                    />
                  </View>
                )}
              </Each>
            </View>
          </Scroll>
        </Modal>
      </If>
    </View>
  );
}

function runHistory(runs: RoutineSummary["runs"]) {
  const history = runs
    .slice(0, 7)
    .reverse()
    .map((run) => run.status);
  return Array.from(
    { length: 7 },
    (_, index) => history[index - (7 - history.length)] ?? null,
  );
}

function routineTime(at: number) {
  return new Date(at).toLocaleString(
    formatLocale() === "zh-CN" ? "zh-CN" : "en-GB",
    {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    },
  );
}

function clockDistance(at: number) {
  const minutes = Math.max(0, Math.floor((at - Date.now()) / 60_000));
  const formatter = new Intl.RelativeTimeFormat(formatLocale(), {
    numeric: "auto",
  });
  if (minutes >= 1440)
    return formatter.format(Math.floor(minutes / 1440), "day");
  if (minutes >= 60) return formatter.format(Math.floor(minutes / 60), "hour");
  return formatter.format(minutes, "minute");
}

function RoutineFeedCard(props: {
  run: RunView;
  latest?: boolean;
  canRetry: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const c = colors();
  const sent = () => props.run.status === "sent";
  const failed = () => props.run.status === "failed";
  return (
    <View style={{ borderWidth: 1, borderColor: c().border, gap: 6 }}>
      <View style={{ padding: 12, gap: 5 }}>
        <Label size={12} tone="muted">
          {routineTime(props.run.startedAt)}
        </Label>
        <View style={{ ...row, gap: 6 }}>
          <If when={failed()}>
            <View style={{ width: 6, height: 6, backgroundColor: c().red }} />
          </If>
          <Label
            size={sent() ? 16 : 14}
            weight={600}
            tone={sent() ? "ink" : "muted"}
          >
            {sent()
              ? (props.run.title ?? uiText("report"))
              : props.run.status === "running"
                ? uiText("running")
                : uiText("noReport")}
          </Label>
        </View>
        <If when={props.latest && props.run.report}>
          <View style={{ maxHeight: 280, overflow: "hidden" }}>
            <Markdown value={props.run.report ?? ""} line={22} />
          </View>
        </If>
        <If when={props.run.error}>
          <Label size={12} tone="muted">
            {props.run.error}
          </Label>
        </If>
      </View>
      <View
        style={{
          ...row,
          borderTopWidth: 1,
          borderColor: c().border,
          paddingHorizontal: 8,
        }}
      >
        <Button
          label={sent() ? uiText("readReport") : uiText("runDetails")}
          size={30}
          tone="ghost"
          end="right"
          onPress={props.onOpen}
        />
        <If when={failed()}>
          <Button
            label={uiText("retry")}
            size={30}
            tone="ghost"
            disabled={!props.canRetry}
            onPress={props.onRetry}
          />
        </If>
      </View>
    </View>
  );
}

interface RoutineReportProps {
  routine: RoutineInfo;
  run: RunView;
  index: number;
  count: number;
  phone: boolean;
  runs: RunView[];
  onBack: () => void;
  onMove: (by: number) => void;
  canRetry: boolean;
  onRetry: () => void;
  onToggle: () => void;
  onEdit: () => void;
  feedback: string;
  onFeedback: (value: string) => void;
  onSend: () => void;
}

function runDay(at: number) {
  const date = new Date(at);
  if (date.toDateString() === new Date().toDateString())
    return routineCopy("Today", "今天");
  return date.toLocaleDateString(formatLocale(), {
    month: "short",
    day: "numeric",
  });
}

function recordedDuration(run: RunView) {
  if (
    run.finishedAt === null ||
    run.finishedAt < run.startedAt ||
    run.status === "skipped"
  )
    return undefined;
  const duration = run.finishedAt - run.startedAt;
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  if (seconds < 1) return routineCopy(`${duration}ms`, `${duration}毫秒`);
  if (!minutes) return routineCopy(`${seconds}s`, `${seconds}秒`);
  return routineCopy(
    `${minutes}m ${seconds % 60}s`,
    `${minutes}分${seconds % 60}秒`,
  );
}

function PhoneRoutineFailure(props: RoutineReportProps) {
  const c = colors();
  const previousIndex = () =>
    props.runs.findIndex(
      (run, index) =>
        index > props.index && run.status === "sent" && Boolean(run.report),
    );
  const previous = () => props.runs[previousIndex()];
  const recent = () => props.runs.slice(0, 7);
  const time = () =>
    new Date(props.run.startedAt).toLocaleTimeString(formatLocale(), {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  const status = () =>
    props.run.status === "skipped"
      ? routineCopy("Skipped", "已跳过")
      : uiText("failed");
  const error = () =>
    props.run.error ??
    (props.run.status === "skipped"
      ? uiText("theRoutineWasSkipped")
      : routineCopy(
          "The routine failed without an error message.",
          "例行任务运行失败，未返回错误详情。",
        ));
  const schedule = () =>
    [
      mobileSchedule(props.routine.schedule),
      props.run.status === "skipped"
        ? undefined
        : routineCopy("run by Captain", "由 Captain 运行"),
    ]
      .filter(Boolean)
      .join(" · ");
  const duration = () => {
    const elapsed = recordedDuration(props.run);
    return elapsed
      ? routineCopy(`took ${elapsed}`, `耗时 ${elapsed}`)
      : undefined;
  };

  return (
    <Modal
      title={props.routine.name}
      phone
      phonePage
      overPhoneNavigation
      height="100%"
      onClose={props.onBack}
      headerActions={
        <ActionMenu label={uiText("routineActions")}>
          <If when={props.index > 0}>
            <ActionItem
              label={uiText("newer")}
              onSelect={() => props.onMove(-1)}
            />
          </If>
          <ActionItem
            label={props.routine.enabled ? uiText("pause") : uiText("resume")}
            onSelect={props.onToggle}
          />
          <ActionItem label={uiText("edit")} onSelect={props.onEdit} />
        </ActionMenu>
      }
    >
      <Scroll style={grow} scrollbar={false}>
        <View style={{ padding: 16, gap: 18 }}>
          <View style={{ gap: 8 }}>
            <View style={{ ...row, gap: 8 }}>
              <View
                style={{
                  height: 18,
                  paddingHorizontal: 8,
                  justifyContent: "center",
                  backgroundColor: c().button,
                }}
              >
                <Label
                  size={10}
                  tone="buttonInk"
                  style={{ textTransform: "uppercase", letterSpacing: 0.4 }}
                >
                  {status()}
                </Label>
              </View>
              <Label size={11} tone="muted">
                {[`${runDay(props.run.startedAt)} ${time()}`, duration()]
                  .filter(Boolean)
                  .join(" · ")}
              </Label>
            </View>
            <Label size={11} tone="muted">
              {schedule()}
            </Label>
          </View>
          <View style={{ gap: 6 }}>
            <Caption text={uiText("report")} />
            <Label line={22}>{error()}</Label>
            <If when={previous()}>
              {(run) => (
                <Markdown
                  line={22}
                  value={routineCopy(
                    `Last good run (${runAgo(run().startedAt)}): ${
                      run()
                        .report?.split(/\n\s*\n/)[0]
                        ?.trim() ?? ""
                    }`,
                    `上次成功运行（${runAgo(run().startedAt)}）：${
                      run()
                        .report?.split(/\n\s*\n/)[0]
                        ?.trim() ?? ""
                    }`,
                  )}
                />
              )}
            </If>
          </View>
          <If when={previous()}>
            {(run) => (
              <View style={{ gap: 6 }}>
                <Caption text={routineCopy("Output", "输出")} />
                <View
                  role="button"
                  accessibilityLabel={run().title ?? uiText("report")}
                  onPress={() => props.onMove(previousIndex() - props.index)}
                  hoverStyle={{ backgroundColor: c().selected }}
                  focusVisibleStyle={{
                    outlineWidth: 1,
                    outlineColor: c().blue,
                  }}
                  style={{
                    ...row,
                    minHeight: 56,
                    gap: 10,
                    paddingHorizontal: 12,
                    borderWidth: 1,
                    borderColor: c().border,
                    cursor: "pointer",
                  }}
                >
                  <Icon name="panel" size={14} tone="muted" />
                  <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                    <Label size={13} lines={1}>
                      {run().title ?? uiText("report")}
                    </Label>
                    <Label
                      size={11}
                      tone="muted"
                    >{`${uiText("report")} · ${routineTime(run().startedAt)}`}</Label>
                  </View>
                  <Icon name="right" size={10} tone="muted" />
                </View>
              </View>
            )}
          </If>
          <View style={{ gap: 6 }}>
            <Caption text={routineCopy("Last 7 runs", "最近 7 次运行")} />
            <RoutineHistory runs={recent()} full />
            <View style={{ ...row, justifyContent: "space-between" }}>
              <Label size={10} tone="muted">
                {runDay(recent().at(-1)?.startedAt ?? props.run.startedAt)}
              </Label>
              <Label size={10} tone="muted">
                {runDay(recent()[0]?.startedAt ?? props.run.startedAt)}
              </Label>
            </View>
          </View>
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          paddingHorizontal: 16,
          minHeight: 64,
          gap: 8,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <Button
          label={routineCopy("Older reports", "较早的报告")}
          tone="ghost"
          disabled={props.index + 1 >= props.count}
          onPress={() => props.onMove(1)}
          style={{ paddingHorizontal: 0 }}
        />
        <Button
          label={uiText("runNow")}
          tone="primary"
          icon="right"
          size={36}
          disabled={!props.canRetry}
          onPress={props.onRetry}
        />
      </View>
    </Modal>
  );
}

function RoutineReport(props: RoutineReportProps) {
  const c = colors();
  const failed = () =>
    props.run.status === "failed" || props.run.status === "skipped";
  const date = () =>
    new Date(props.run.startedAt).toLocaleString(
      formatLocale() === "zh-CN" ? "zh-CN" : "en-GB",
      {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      },
    );
  const content = () => (
    <View style={grow}>
      <View
        style={{
          ...row,
          paddingHorizontal: 16,
          gap: 8,
          height: 40,
          borderBottomWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={!props.phone}>
          <Button
            label={props.routine.name}
            icon="back"
            tone="ghost"
            onPress={props.onBack}
          />
        </If>
        <Label size={12} tone="muted" style={{ flex: 1 }}>
          {props.phone ? uiText("reports") : uiText("reports2")}
          {`${props.index + 1} ${uiText("of")} ${props.count}`}
        </Label>
        <Button
          label={uiText("newer")}
          disabled={props.index < 1}
          onPress={() => props.onMove(-1)}
        />
        <Button
          label={uiText("older")}
          disabled={props.index + 1 >= props.count}
          onPress={() => props.onMove(1)}
        />
      </View>
      <Scroll style={grow}>
        <View style={{ padding: 16, gap: 14 }}>
          <Label size={12} tone="muted">
            {date()}
          </Label>
          <If
            when={failed()}
            else={
              <>
                <Label size={18} weight={600}>
                  {props.run.title ?? uiText("report")}
                </Label>
                <Markdown
                  value={
                    props.run.report ??
                    (props.run.status === "running"
                      ? "Routine running…"
                      : "No report")
                  }
                  line={22}
                />
                <Each of={props.run.feedback} key={(entry) => entry.id}>
                  {(entry) => (
                    <View
                      style={{
                        borderTopWidth: 1,
                        borderColor: c().border,
                        paddingTop: 10,
                        gap: 4,
                      }}
                    >
                      <Label size={12} weight={500}>
                        {uiText("me")}
                      </Label>
                      <Label>{entry().text}</Label>
                      <Label
                        size={12}
                        tone={entry().revisionFailed ? "red" : "muted"}
                      >
                        {entry().revisionFailed
                          ? uiText("theBriefCouldntBeUpdated")
                          : entry().briefVersion
                            ? uiText("briefUpdatedToV", {
                                briefVersion: entry().briefVersion,
                              })
                            : uiText("updatingTheBrief")}
                      </Label>
                    </View>
                  )}
                </Each>
              </>
            }
          >
            <Label size={18} weight={600}>
              {uiText("noReport")}
            </Label>
            <Label tone="muted">
              {props.run.error ?? uiText("theRoutineWasSkipped")}
            </Label>
            <Button
              label={uiText("retry")}
              disabled={!props.canRetry}
              onPress={props.onRetry}
              style={{ alignSelf: "flex-start" }}
            />
          </If>
        </View>
      </Scroll>
      <If when={!failed() && props.run.report}>
        <View
          style={{
            ...row,
            gap: 8,
            padding: 12,
            borderTopWidth: 1,
            borderColor: c().border,
          }}
        >
          <Field
            label={uiText("feedback")}
            placeholder={uiText("feedbackEGSkipFundingNews")}
            value={props.feedback}
            onChange={props.onFeedback}
            style={{ flex: 1 }}
          />
          <Button
            label={uiText("sendFeedback")}
            tone="primary"
            disabled={!props.feedback.trim() || props.routine.revising}
            onPress={props.onSend}
          />
        </View>
      </If>
    </View>
  );
  return (
    <If when={props.phone && props.index === 0 && failed()} else={content()}>
      <PhoneRoutineFailure {...props} />
    </If>
  );
}

function RoutineEditor(props: {
  phone: boolean;
  inline?: boolean;
  item?: RoutineInfo;
  brief?: string;
  onClose: () => void;
  onSave: (id: string) => void;
}) {
  const host = useHost();
  const name = signal(props.item?.name ?? "");
  const brief = signal(props.brief ?? "");
  const existing = props.item?.schedule;
  const kind = signal<RoutineSchedule["kind"]>(existing?.kind ?? "daily");
  const at = signal(
    existing?.kind === "daily" || existing?.kind === "weekly"
      ? existing.time
      : "08:00",
  );
  const days = signal<number[]>(
    existing?.kind === "weekly" ? existing.days : [1],
  );
  const every = signal<(typeof HOURLY_STEPS)[number]>(
    existing?.kind === "hourly" ? existing.every : 1,
  );
  const cron = signal(existing?.kind === "cron" ? existing.cron : "");
  const kinds = {
    daily: "dailySchedule",
    weekly: "weeklySchedule",
    hourly: "hourlySchedule",
    cron: "cronSchedule",
  } as const;
  const c = colors();
  function schedule(): RoutineSchedule | undefined {
    switch (kind()) {
      case "daily":
      case "weekly": {
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(at().trim())) return undefined;
        if (kind() === "daily") return { kind: "daily", time: at().trim() };
        if (days().length)
          return {
            kind: "weekly",
            time: at().trim(),
            days: [...days()].sort(),
          };
        return undefined;
      }
      case "hourly":
        return { kind: "hourly", every: every() };
      case "cron":
        if (cron().trim().split(/\s+/).length === 5)
          return { kind: "cron", cron: cron().trim() };
        return undefined;
    }
  }
  const timezone = signal(
    props.item?.timezone ??
      new Intl.DateTimeFormat().resolvedOptions().timeZone ??
      "UTC",
  );
  const busy = signal(false);
  const valid = () =>
    name().trim() && brief().trim() && timezone().trim() && schedule();
  async function save() {
    const selected = schedule();
    if (!selected || !valid() || busy()) return;
    busy.set(true);
    const fields: RoutineFields = {
      name: name().trim(),
      brief: brief().trim(),
      timezone: timezone().trim(),
      schedule: selected,
    };
    const result = await host.action(() =>
      host.call<RoutineResults["create"]>(
        "routines",
        props.item ? "update" : "create",
        props.item ? { ...fields, routineId: props.item.id } : fields,
      ),
    );
    busy.set(false);
    if (result) {
      props.onClose();
      props.onSave(result.routine.id);
    }
  }
  const form = () => (
    <View style={{ padding: 16, gap: 8 }}>
      <Field
        label={uiText("name")}
        placeholder={uiText("name")}
        value={name()}
        onChange={name.set}
      />
      <Field
        label={uiText("instructions")}
        placeholder={uiText("whatShouldCaptainDoEachTime")}
        value={brief()}
        onChange={brief.set}
        multiline
        style={{ height: 112 }}
      />
      <Caption text={uiText("schedule")} />
      <View style={{ ...row, gap: 8, flexWrap: "wrap" }}>
        <ActionMenu
          label={uiText("scheduleFrequency")}
          value={uiText(kinds[kind()])}
        >
          <Each of={Object.keys(kinds) as RoutineSchedule["kind"][]}>
            {(option) => (
              <ActionItem
                label={uiText(kinds[option()])}
                checked={kind() === option()}
                onSelect={() => kind.set(option())}
              />
            )}
          </Each>
        </ActionMenu>
        <If when={kind() === "weekly"}>
          <View style={row}>
            <Each of={[1, 2, 3, 4, 5, 6, 0]}>
              {(day) => (
                <Button
                  label={weekday(day())}
                  size={28}
                  selected={days().includes(day())}
                  tone={days().includes(day()) ? "primary" : "ghost"}
                  onPress={() =>
                    days.update((previous) =>
                      previous.includes(day())
                        ? previous.filter((item) => item !== day())
                        : [...previous, day()],
                    )
                  }
                />
              )}
            </Each>
          </View>
        </If>
        <If when={kind() === "weekly" || kind() === "daily"}>
          <Field
            label={uiText("time")}
            placeholder="HH:MM"
            value={at()}
            onChange={at.set}
            style={{ width: 100 }}
          />
        </If>
        <If when={kind() === "hourly"}>
          <ActionMenu
            label={uiText("repeatEvery")}
            value={
              every() === 1
                ? uiText("everyHour")
                : uiText("everyHours", { hours: every() })
            }
          >
            <Each of={HOURLY_STEPS}>
              {(hours) => (
                <ActionItem
                  label={
                    hours() === 1
                      ? uiText("everyHour")
                      : uiText("everyHours", { hours: hours() })
                  }
                  checked={every() === hours()}
                  onSelect={() => every.set(hours())}
                />
              )}
            </Each>
          </ActionMenu>
        </If>
      </View>
      <If when={kind() === "cron"}>
        <Field
          label={uiText("cronExpression")}
          placeholder="0 8 * * 1–5"
          value={cron()}
          onChange={cron.set}
        />
        <Label size={12} tone="muted">
          {uiText("minuteHourDayOfMonthMonth")}
        </Label>
      </If>
      <Field
        label={uiText("timeZone")}
        value={timezone()}
        onChange={timezone.set}
      />
      <View
        style={{
          ...row,
          gap: 8,
          justifyContent: "flex-end",
          borderTopWidth: 1,
          borderColor: c().border,
          paddingTop: 8,
        }}
      >
        <Button
          label={uiText("cancel")}
          disabled={busy()}
          onPress={props.onClose}
        />
        <Button
          label={props.item ? uiText("saveChanges") : uiText("createRoutine")}
          tone="primary"
          disabled={!valid() || busy()}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
  return (
    <If
      when={props.inline}
      else={
        <Modal
          title={props.item ? uiText("editRoutine") : uiText("newRoutine")}
          phone={props.phone}
          width={540}
          onClose={props.onClose}
        >
          {form()}
        </Modal>
      }
    >
      <Scroll style={grow}>
        <View style={{ padding: 12, paddingBottom: 0, gap: 6 }}>
          <Button
            label={uiText("routines2")}
            icon="back"
            tone="ghost"
            style={{ alignSelf: "flex-start" }}
            onPress={props.onClose}
          />
          <Label size={15} weight={600} style={{ paddingHorizontal: 4 }}>
            {props.item ? uiText("editRoutine") : uiText("newRoutine")}
          </Label>
        </View>
        {form()}
      </Scroll>
    </If>
  );
}

export function Plugins(props: { layout: Layout }) {
  const host = useHost();
  const c = colors();
  const tab = signal("Plugins");
  const add = signal(false);
  const config = signal("");
  const selected = signal("");
  const warnings = signal("");
  const remove = signal("");
  const list = () => host.list<PluginView>("plugins");
  const plugin = () => list().find((item) => item.name === config());
  const phone = () => props.layout === "phone";
  const tabletPlugins = () => props.layout === "tablet" && tab() === "Plugins";
  const detail = () =>
    list().find((item) => item.name === selected()) ??
    (tabletPlugins() ? list()[0] : undefined);
  const warningPlugin = () => list().find((item) => item.name === warnings());
  async function refreshPlugins() {
    await host.action(() => host.call("plugins", "recheck", {}));
  }
  async function update(name: string) {
    return (
      (await host.action(() =>
        host.call<PluginResults["update"]>("plugins", "update", { name }),
      )) !== undefined
    );
  }
  follow(() => "plugins");

  function tabs(tablet = false) {
    return (
      <View
        style={{
          ...row,
          paddingHorizontal: tablet ? 14 : phone() ? 16 : 24,
          paddingTop: tablet ? 6 : 16,
          paddingBottom: tablet ? 5 : 8,
          flexShrink: 0,
          borderBottomWidth: tablet ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <Each of={["Plugins", "Skills"]}>
          {(item) => (
            <Button
              label={uiText(item() === "Plugins" ? "plugins" : "skillsTab")}
              size={28}
              tone={tab() === item() ? "primary" : "plain"}
              style={{ flex: tablet ? 1 : undefined }}
              onPress={() => tab.set(item())}
            />
          )}
        </Each>
      </View>
    );
  }

  const detailView = () => (
    <If when={detail()}>
      {(item) => (
        <PluginDetail
          item={item()}
          phone={phone()}
          onBack={() => selected.set("")}
          onConfigure={() => config.set(item().name)}
          onUpdate={() => update(item().name)}
          onRemove={() => remove.set(item().name)}
          onRefresh={refreshPlugins}
        />
      )}
    </If>
  );
  return (
    <View style={grow}>
      <If
        when={tabletPlugins()}
        else={
          <If
            when={phone() && detail()}
            else={
              <>
                <If when={tab() === "Plugins"}>
                  <Header
                    title={uiText("plugins")}
                    layout={props.layout}
                    inset={10}
                  >
                    <View style={{ flex: 1 }} />
                    <Button
                      label={uiText("refreshPlugins")}
                      icon="refresh"
                      iconOnly
                      tone="ghost"
                      onPress={() => void refreshPlugins()}
                    />
                    <Button
                      label={uiText("addFromGit")}
                      icon="plus"
                      onPress={() => add.set(true)}
                    />
                  </Header>
                  {tabs()}
                </If>
                <If
                  when={tab() === "Plugins"}
                  else={
                    <Skills
                      layout={props.layout}
                      tabs={() => tabs(props.layout === "tablet")}
                    />
                  }
                >
                  <Scroll style={grow} scrollbar={false}>
                    <View
                      style={{
                        paddingHorizontal: phone() ? 16 : 24,
                        paddingBottom: 16,
                        gap: 16,
                      }}
                    >
                      <Label size={12} line={19} tone="muted">
                        {uiText("pluginsGiveAgentsSkillsAndMcp")}
                      </Label>
                      <If when={!list().length}>
                        <Label tone="muted">
                          {uiText("noPluginsInstalled")}
                        </Label>
                      </If>
                      <View
                        style={{
                          ...row,
                          flexWrap: "wrap",
                          alignItems: "stretch",
                          gap: 12,
                        }}
                      >
                        <Each of={list()} key={(item) => item.name}>
                          {(item) => (
                            <View
                              role={phone() ? "button" : undefined}
                              accessibilityLabel={
                                phone() ? item().name : undefined
                              }
                              onPress={
                                phone()
                                  ? () => selected.set(item().name)
                                  : undefined
                              }
                              activeStyle={{ backgroundColor: c().selected }}
                              style={{
                                width: phone()
                                  ? "100%"
                                  : props.layout === "tablet"
                                    ? "31.9%"
                                    : "24.1%",
                                minHeight: phone() ? 108 : 220,
                                padding: 12,
                                backgroundColor: c().canvas,
                                borderWidth: 1,
                                borderColor: c().border,
                                gap: 9,
                              }}
                            >
                              <View style={{ ...row, gap: 12 }}>
                                <View
                                  style={{
                                    width: 36,
                                    height: 36,
                                    alignItems: "center",
                                    justifyContent: "center",
                                    backgroundColor: c().selected,
                                  }}
                                >
                                  <Icon name="plugins" size={19} tone="muted" />
                                </View>
                                <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                                  <Label weight={600} lines={1}>
                                    {item().name}
                                  </Label>
                                  <View
                                    style={{ ...row, flexWrap: "wrap", gap: 8 }}
                                  >
                                    <Label size={12} tone="muted">
                                      {item().version ?? ""}
                                    </Label>
                                    <Label
                                      size={10}
                                      tone={
                                        item().state === "ready"
                                          ? "muted"
                                          : "amber"
                                      }
                                    >
                                      {item().state === "ready"
                                        ? uiText("canBeEnabled")
                                        : uiText("needsConfiguring")}
                                    </Label>
                                  </View>
                                </View>
                              </View>
                              <Label size={12} tone="muted" line={18}>
                                {item().description}
                              </Label>
                              <Label size={12} tone="muted" lines={1}>
                                {"repo" in item().source
                                  ? (item().source as { repo: string }).repo
                                  : uiText("localDirectory")}
                              </Label>
                              <Label size={12} tone="muted">
                                {uiText("skillsMcpServers", {
                                  length: item().skills.length,
                                  value2: item().servers.length,
                                })}
                              </Label>
                              <If when={item().problem}>
                                <Label size={12} tone="red">
                                  {item().problem}
                                </Label>
                              </If>
                              <If when={!phone()}>
                                <View style={{ flex: 1 }} />
                                <View
                                  style={{
                                    ...row,
                                    borderTopWidth: 1,
                                    borderColor: c().border,
                                    paddingTop: 10,
                                    gap: 5,
                                    justifyContent: "flex-end",
                                  }}
                                >
                                  <If when={pluginWarnings(item()).length}>
                                    <Button
                                      label={uiText("warnings")}
                                      tone="ghost"
                                      onPress={() => warnings.set(item().name)}
                                    />
                                  </If>
                                  <If when={item().source.kind === "git"}>
                                    <Button
                                      label={uiText("update")}
                                      tone="ghost"
                                      onPress={() => void update(item().name)}
                                    />
                                    <Button
                                      label={uiText("remove2")}
                                      tone="ghost"
                                      onPress={() => remove.set(item().name)}
                                    />
                                  </If>
                                  <If when={item().fields.length}>
                                    <Button
                                      label={uiText("configure")}
                                      onPress={() => config.set(item().name)}
                                    />
                                  </If>
                                </View>
                              </If>
                            </View>
                          )}
                        </Each>
                      </View>
                    </View>
                  </Scroll>
                </If>
              </>
            }
          >
            {detailView()}
          </If>
        }
      >
        <PluginTablet
          items={list()}
          current={detail()}
          tabs={tabs(true)}
          onSelect={selected.set}
          onRefresh={refreshPlugins}
          onAdd={() => add.set(true)}
          detail={detailView()}
        />
      </If>
      <If when={warningPlugin()}>
        {(item) => (
          <PluginWarningsDialog
            item={item()}
            onClose={() => warnings.set("")}
          />
        )}
      </If>
      <If when={add()}>
        <AddPlugin phone={phone()} onClose={() => add.set(false)} />
      </If>
      <If when={plugin()}>
        {(item) => (
          <ConfigurePlugin
            item={item()}
            phone={phone()}
            tablet={props.layout === "tablet"}
            onClose={() => config.set("")}
          />
        )}
      </If>
      <If when={remove()}>
        <Modal
          title={uiText("removePlugin")}
          phone={phone()}
          overPhoneNavigation={phone()}
          onClose={() => remove.set("")}
        >
          <View style={{ padding: 16, gap: 12 }}>
            <Label>{uiText("removeFromThisHost", { remove: remove() })}</Label>
            <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
              <Button label={uiText("cancel")} onPress={() => remove.set("")} />
              <Button
                label={uiText("remove2")}
                tone="danger"
                onPress={() =>
                  void host.action(async () => {
                    const name = remove();
                    await host.call("plugins", "remove", { name });
                    if (selected() === name) selected.set("");
                    remove.set("");
                  })
                }
              />
            </View>
          </View>
        </Modal>
      </If>
    </View>
  );
}

function AddPlugin(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const repo = signal("");
  const rev = signal("");
  const path = signal("");
  const busy = signal(false);
  return (
    <Modal
      title={uiText("addFromGit")}
      phone={props.phone}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 8 }}>
        <Field
          label={uiText("repository")}
          placeholder={uiText("gitRepositoryUrl")}
          value={repo()}
          onChange={repo.set}
        />
        <Field
          label={uiText("revision")}
          placeholder={uiText("branchTagOrCommit")}
          value={rev()}
          onChange={rev.set}
        />
        <Field
          label={uiText("pluginPath")}
          placeholder={uiText("directoryInTheRepositoryOptional")}
          value={path()}
          onChange={path.set}
        />
        <Button
          label={busy() ? uiText("adding") : uiText("addPlugin")}
          tone="primary"
          disabled={!repo().trim() || busy()}
          onPress={() =>
            void (async () => {
              if (busy()) return;
              busy.set(true);
              const result = await host.action(() =>
                host.call("plugins", "add", {
                  repo: repo().trim(),
                  rev: rev().trim() || undefined,
                  path: path().trim() || undefined,
                }),
              );
              busy.set(false);
              if (result) props.onClose();
            })()
          }
        />
      </View>
    </Modal>
  );
}

function ConfigurePlugin(props: {
  item: PluginView;
  phone: boolean;
  tablet: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const values = signal<Record<string, PluginValue | null>>({});
  const numberInput = signal<Record<string, string>>({});
  const issues = signal<PluginResults["configure"]["issues"]>([]);
  const busy = signal(false);
  const accessBusy = signal(false);
  async function setLevel(field: PluginFieldView, level: PluginAgentLevel) {
    if (busy() || accessBusy() || !field.levels.includes(level)) return;
    accessBusy.set(true);
    try {
      await host.action(() =>
        host.call("plugins", "setLevel", {
          name: props.item.name,
          field: field.name,
          level,
        }),
      );
    } finally {
      accessBusy.set(false);
    }
  }
  const valueOf = (field: PluginFieldView) =>
    Object.hasOwn(values(), field.name)
      ? values()[field.name]
      : (field.value ?? field.default ?? null);
  const set = (key: string, value: PluginValue | null) => {
    values.update((previous) => ({ ...previous, [key]: value }));
    issues.update((previous) =>
      previous.filter((issue) => issue.field !== key),
    );
  };
  function numericIssue(field: PluginFieldView) {
    if (field.type !== "number" || !Object.hasOwn(numberInput(), field.name))
      return "";
    const text = numberInput()[field.name]?.trim();
    if (!text) return field.required ? "Enter a value." : "";
    const value = Number(text);
    if (!Number.isFinite(value)) return uiText("pluginNumberRequired");
    if (field.int && !Number.isInteger(value))
      return uiText("pluginWholeNumberRequired");
    if (field.min !== undefined && value < field.min)
      return uiText("pluginBelowMinimum", { value: field.min });
    if (field.max !== undefined && value > field.max)
      return uiText("pluginAboveMaximum", { value: field.max });
    return "";
  }
  async function submit() {
    if (busy() || accessBusy() || props.item.fields.some(numericIssue)) return;
    busy.set(true);
    const payload = { ...values() };
    for (const [key, text] of Object.entries(numberInput()))
      payload[key] = text.trim() ? Number(text) : null;
    const result = await host.action(() =>
      host.call<PluginResults["configure"]>("plugins", "configure", {
        name: props.item.name,
        values: payload,
      }),
    );
    busy.set(false);
    if (!result) return;
    issues.set(result.issues);
    if (result.state === "ready") props.onClose();
  }
  const title = () => uiText("configureWithCount", { name: props.item.name });
  const form = () => (
    <>
      <Scroll style={grow}>
        <View style={{ padding: 16, gap: 12 }}>
          <Label size={12} line={18} tone="muted">
            {pluginConfigText("fields")}
          </Label>
          <Each of={props.item.fields} key={(field) => field.name}>
            {(field) => {
              const item = () => field();
              const value = () => valueOf(item());
              return (
                <View style={{ gap: 5 }}>
                  <If when={item().type !== "boolean"}>
                    <View style={{ ...row, gap: 5 }}>
                      <Label size={13} weight={500}>
                        {item().title}
                      </Label>
                      <Label size={10} tone="muted">
                        {pluginConfigText(
                          item().required ? "required" : "optional",
                        )}
                      </Label>
                    </View>
                  </If>
                  <If when={item().description && item().type !== "boolean"}>
                    <Label size={11} tone="muted">
                      {item().description}
                    </Label>
                  </If>
                  <If
                    when={item().type === "select"}
                    else={
                      <If
                        when={item().type === "boolean"}
                        else={
                          <Field
                            label={item().title}
                            masked={item().secret}
                            placeholder={
                              item().secret &&
                              item().set &&
                              !Object.hasOwn(values(), item().name)
                                ? uiText("valueSaved")
                                : ""
                            }
                            value={
                              item().type === "number" &&
                              Object.hasOwn(numberInput(), item().name)
                                ? (numberInput()[item().name] ?? "")
                                : String(value() ?? "")
                            }
                            onChange={(text) => {
                              if (item().type === "number") {
                                numberInput.update((previous) => ({
                                  ...previous,
                                  [item().name]: text,
                                }));
                                issues.update((previous) =>
                                  previous.filter(
                                    (issue) => issue.field !== item().name,
                                  ),
                                );
                              } else
                                set(item().name, text === "" ? null : text);
                            }}
                          />
                        }
                      >
                        <View style={{ ...row, gap: 8 }}>
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Label size={13} weight={500}>
                              {item().title}
                            </Label>
                            <If when={item().description}>
                              <Label size={11} tone="muted">
                                {item().description}
                              </Label>
                            </If>
                          </View>
                          <Switch
                            accessibilityLabel={item().title}
                            checked={value() === true}
                            disabled={busy()}
                            onChange={({ checked }) =>
                              set(item().name, checked)
                            }
                            style={{
                              width: 30,
                              height: 16,
                              borderWidth: 1,
                              borderColor: c().strong,
                              paddingHorizontal: 2,
                              backgroundColor:
                                value() === true ? c().button : c().canvas,
                              justifyContent: "center",
                              alignItems:
                                value() === true ? "flex-end" : "flex-start",
                            }}
                          >
                            <View
                              style={{
                                width: 10,
                                height: 10,
                                backgroundColor:
                                  value() === true ? c().buttonInk : c().faint,
                              }}
                            />
                          </Switch>
                        </View>
                      </If>
                    }
                  >
                    <If
                      when={
                        item().type === "select"
                          ? (item() as Extract<
                              PluginFieldView,
                              { type: "select" }
                            >)
                          : undefined
                      }
                    >
                      {(spec) => (
                        <If
                          when={spec().multiple}
                          else={
                            <PluginSelect
                              label={spec().title}
                              items={spec().options.map((option) => ({
                                value: option.value,
                                title: option.label,
                              }))}
                              value={
                                typeof value() === "string"
                                  ? String(value())
                                  : null
                              }
                              disabled={busy()}
                              onChange={(next) => set(spec().name, next)}
                            />
                          }
                        >
                          <View style={{ ...row, gap: 6, flexWrap: "wrap" }}>
                            <Each
                              of={spec().options}
                              key={(choice) => choice.value}
                            >
                              {(choice) => (
                                <Button
                                  label={choice().label}
                                  selected={
                                    Array.isArray(value()) &&
                                    (value() as string[]).includes(
                                      choice().value,
                                    )
                                  }
                                  onPress={() => {
                                    const current = value();
                                    const picked = Array.isArray(current)
                                      ? current
                                      : [];
                                    set(
                                      spec().name,
                                      picked.includes(choice().value)
                                        ? picked.filter(
                                            (option) =>
                                              option !== choice().value,
                                          )
                                        : [...picked, choice().value],
                                    );
                                  }}
                                />
                              )}
                            </Each>
                          </View>
                        </If>
                      )}
                    </If>
                    <If
                      when={
                        !item().required &&
                        Boolean(value()) &&
                        Object.hasOwn(values(), item().name)
                      }
                    >
                      <Button
                        label={uiText("clear")}
                        tone="ghost"
                        style={{ alignSelf: "flex-start" }}
                        onPress={() => set(item().name, null)}
                      />
                    </If>
                  </If>
                  <If when={item().secret}>
                    <View style={{ ...row, gap: 7 }}>
                      <Label size={11} tone="muted">
                        {pluginConfigText("access")}
                      </Label>
                      <If
                        when={
                          item().levels.length > 1 &&
                          host.can("plugins.setLevel")
                        }
                        else={
                          <Label size={11} tone="muted">
                            {pluginConfigText(item().level)}
                          </Label>
                        }
                      >
                        <PluginSelect
                          label={pluginConfigText("access")}
                          items={item().levels.map((level) => ({
                            value: level,
                            title: pluginConfigText(level),
                          }))}
                          value={item().level}
                          compact
                          disabled={accessBusy() || busy()}
                          onChange={(next) =>
                            void setLevel(item(), next as PluginAgentLevel)
                          }
                        />
                      </If>
                    </View>
                  </If>
                  <If
                    when={
                      item().secret &&
                      !item().required &&
                      item().set &&
                      !Object.hasOwn(values(), item().name)
                    }
                  >
                    <Button
                      label={uiText("clearSaved", { title: item().title })}
                      tone="ghost"
                      style={{ alignSelf: "flex-start" }}
                      onPress={() => set(item().name, null)}
                    />
                  </If>
                  <If
                    when={
                      numericIssue(item()) ||
                      issues().some((issue) => issue.field === item().name)
                    }
                  >
                    <Label size={11} tone="red">
                      {numericIssue(item()) ||
                        uiText("checkThisValueAgainstThePlugins")}
                    </Label>
                  </If>
                </View>
              );
            }}
          </Each>
          <Label size={11} tone="muted">
            {pluginConfigText("encrypted")}
          </Label>
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          padding: 12,
          gap: 8,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={props.item.state === "needs_config"}>
          <Label size={11} line={15} tone="muted" style={{ flex: 1 }}>
            {pluginConfigText("missing")}
          </Label>
        </If>
        <Button
          label={uiText("save")}
          tone="primary"
          disabled={
            busy() ||
            accessBusy() ||
            props.item.fields.some(numericIssue) ||
            !(Object.keys(values()).length || Object.keys(numberInput()).length)
          }
          onPress={() => void submit()}
        />
      </View>
    </>
  );
  return (
    <If
      when={props.tablet}
      else={
        <Modal
          title={title()}
          phone={props.phone}
          phonePage={props.phone}
          height={props.phone ? "100%" : 480}
          overPhoneNavigation={props.phone}
          onClose={props.onClose}
        >
          {form()}
        </Modal>
      }
    >
      <Dialog
        accessibilityLabel={title()}
        animation="none"
        style={{ ...fill, paddingTop: 56, alignItems: "center" }}
        backdropStyle={{ backgroundColor: c().modalShade }}
        onOpenChange={({ open }) => {
          if (!open) props.onClose();
        }}
      >
        <View
          role="dialog"
          accessibilityLabel={title()}
          style={{
            width: 578,
            maxWidth: "90%",
            height: 428,
            maxHeight: "92%",
            backgroundColor: c().canvas,
            borderWidth: 1,
            borderColor: c().border,
          }}
        >
          <Header title={title()} dialog inset={16}>
            <View style={{ flex: 1 }} />
            <Button
              label={uiText("close")}
              icon="close"
              iconOnly
              tone="ghost"
              onPress={props.onClose}
            />
          </Header>
          {form()}
        </View>
      </Dialog>
    </If>
  );
}

type SkillCall = <T>(
  action: string,
  input: Record<string, unknown>,
) => Promise<T>;

function Skills(props: { layout: Layout; tabs: () => JSX.Element }) {
  const host = useHost();
  const c = colors();
  const device = signal("");
  const scope = signal<"personal" | "project">("personal");
  const projectId = signal("");
  const query = signal("");
  const entries = signal<SkillSummary[]>([]);
  const selectedPath = signal("");
  const loading = signal(false);
  const failure = signal("");
  const retry = signal(0);
  const resolved = signal<SkillTarget>();
  follow(() => "machines");

  const phone = () => props.layout === "phone";
  const tablet = () => props.layout === "tablet";
  const available = () => host.can("skills.list");
  const devices = computed(() =>
    host
      .list<MachineView>("machines")
      .filter(
        (item) =>
          (item.kind === "primary" || item.kind === "daemon") &&
          item.status !== "revoked",
      )
      .sort(
        (a, b) => Number(b.kind === "primary") - Number(a.kind === "primary"),
      ),
  );
  const machine = () =>
    devices().find((item) => item.id === device()) ?? devices()[0];
  const projects = () =>
    host
      .projects()
      .filter(
        (item) =>
          item.kind === "project" &&
          !item.archived &&
          (item.machineId === machine()?.id ||
            (!item.machineId && machine()?.kind === "primary")),
      );
  const project = () =>
    projects().find((item) => item.id === projectId()) ?? projects()[0];
  const machineLabel = () =>
    machine()
      ? [
          machine()!.name,
          machine()!.kind === "primary" ? uiText("skillPrimaryDevice") : "",
        ]
          .filter(Boolean)
          .join(" ")
      : uiText("skillHost");
  const scopeLabel = () =>
    scope() === "project"
      ? (project()?.name ?? uiText("project2"))
      : uiText("personal");
  const selected = () => entries().find((item) => item.path === selectedPath());
  const showing = () => selected() && resolved();
  const location = computed(() => {
    const current = machine();
    const currentProject = scope() === "project" ? project() : undefined;
    if (
      !available() ||
      !current?.home ||
      (scope() === "project" && !currentProject)
    )
      return "";
    return JSON.stringify({
      machineId: current.id,
      home: current.home,
      scope: scope(),
      projectId: currentProject?.id,
    } satisfies SkillTarget);
  });
  const filesAt =
    (target: SkillTarget): SkillCall =>
    async <T,>(action: string, input: Record<string, unknown>) =>
      (await host.call<{ result: T }>("skills", action, { target, input }))
        .result;

  effect(() => {
    const locationKey = location();
    retry();
    host.subscriptionWire();
    selectedPath.set("");
    entries.set([]);
    resolved.set(undefined);
    loading.set(Boolean(locationKey));
    failure.set("");
    if (!locationKey) return;
    let active = true;
    cleanup(() => {
      active = false;
    });
    const target = JSON.parse(locationKey) as SkillTarget;
    void (async () => {
      try {
        const loaded: SkillSummary[] = [];
        let offset: number | null = 0;
        let resolvedTarget = target;
        do {
          const reply: { target: SkillTarget; result: SkillList } =
            await host.call("skills", "list", {
              target: resolvedTarget,
              input: { offset },
            });
          if (!active) return;
          loaded.push(...reply.result.entries);
          resolvedTarget = reply.target;
          offset = reply.result.next;
        } while (offset !== null);
        resolved.set(resolvedTarget);
        entries.set(loaded);
      } catch (error) {
        if (active)
          failure.set(error instanceof Error ? error.message : String(error));
      } finally {
        if (active) loading.set(false);
      }
    })();
  });

  const refresh = () => {
    selectedPath.set("");
    retry.update((value) => value + 1);
  };
  const visible = () => {
    const term = query().trim().toLowerCase();
    return entries().filter((entry) =>
      `${entry.name} ${entry.description}`.toLowerCase().includes(term),
    );
  };

  function deviceMenu(width: 160 | "100%") {
    return (
      <ActionMenu
        label={uiText("skillDevice")}
        value={machine()?.name ?? uiText("skillHost")}
        truncateValue
        triggerStyle={{ width, height: 28, paddingHorizontal: 8 }}
      >
        <Each of={devices()} key={(item) => item.id}>
          {(item) => (
            <ActionItem
              label={item().name}
              checked={machine()?.id === item().id}
              onSelect={() => {
                selectedPath.set("");
                projectId.set("");
                device.set(item().id);
              }}
            />
          )}
        </Each>
      </ActionMenu>
    );
  }

  const changeScope = (value: "personal" | "project") => {
    selectedPath.set("");
    scope.set(value);
  };
  const controls = () => (
    <View
      style={{
        ...(tablet() || phone() ? {} : { ...row }),
        alignItems: tablet() || phone() ? "stretch" : "center",
        flexWrap: tablet() || phone() ? "nowrap" : "wrap",
        gap: 8,
        paddingHorizontal: tablet() ? 14 : phone() ? 16 : 24,
        paddingTop: tablet() ? 9 : 8,
        paddingBottom: tablet() ? 10 : 16,
        borderBottomWidth: tablet() ? 1 : 0,
        borderColor: c().border,
      }}
    >
      <If when={tablet()}>{deviceMenu("100%")}</If>
      <View
        style={{
          ...row,
          alignSelf: "flex-start",
          backgroundColor: c().selected,
          padding: 1,
        }}
      >
        <Button
          label={uiText("personal")}
          tone={scope() === "personal" ? "plain" : "ghost"}
          size={26}
          onPress={() => changeScope("personal")}
        />
        <Button
          label={uiText("project2")}
          tone={scope() === "project" ? "plain" : "ghost"}
          size={26}
          onPress={() => changeScope("project")}
        />
      </View>
      <If when={scope() === "project"}>
        <ActionMenu
          label={uiText("skillProjectMenu")}
          value={
            project()
              ? `${project()!.name} · ${project()!.display}`
              : uiText("skillChooseProject")
          }
          truncateValue
          triggerStyle={{
            width: tablet() || phone() ? "100%" : 200,
            height: 28,
            paddingHorizontal: 8,
          }}
        >
          <Each of={projects()} key={(item) => item.id}>
            {(item) => (
              <ActionItem
                label={item().name}
                checked={item().id === project()?.id}
                onSelect={() => {
                  selectedPath.set("");
                  projectId.set(item().id);
                }}
              />
            )}
          </Each>
        </ActionMenu>
      </If>
      <If when={!tablet() && !phone()}>
        <View style={{ flex: 1 }} />
      </If>
      <View style={{ width: tablet() || phone() ? "100%" : 230 }}>
        <Field
          label={uiText("searchLoadedSkills")}
          placeholder={uiText("searchLoadedSkills")}
          value={query()}
          onChange={query.set}
          style={{ width: "100%", height: 28, fontSize: 12, paddingRight: 25 }}
        />
        <View
          style={{
            position: "absolute",
            right: 8,
            top: 8,
            pointerEvents: "none",
          }}
        >
          <Icon name="search" tone="muted" size={12} />
        </View>
      </View>
    </View>
  );

  const list = () => (
    <>
      {controls()}
      <If
        when={visible().length}
        else={
          <Empty
            title={
              !available()
                ? uiText("thisHostDoesNotProvideSkill")
                : loading()
                  ? uiText("loadingSkills")
                  : failure()
                    ? uiText("unableToLoadSkills")
                    : !location()
                      ? uiText("skillDirectoryUnavailable")
                      : query().trim()
                        ? uiText("noMatchingSkills")
                        : uiText("noSkillsInThisDirectory")
            }
            description={failure() || undefined}
            icon="folder"
          >
            <If when={failure()}>
              <Button label={uiText("retry")} onPress={refresh} />
            </If>
          </Empty>
        }
      >
        <Scroll style={grow} scrollbar={false}>
          <View
            style={
              tablet()
                ? {}
                : {
                    ...row,
                    flexWrap: "wrap",
                    alignItems: "stretch",
                    paddingHorizontal: phone() ? 16 : 24,
                    gap: 12,
                  }
            }
          >
            <Each of={visible()} key={(entry) => entry.path}>
              {(entry) => (
                <View
                  role="button"
                  accessibilityLabel={entry().name}
                  accessibilityState={{
                    selected: selectedPath() === entry().path,
                  }}
                  onPress={() => selectedPath.set(entry().path)}
                  hoverStyle={{ backgroundColor: c().selected }}
                  style={{
                    ...(tablet()
                      ? {
                          ...row,
                          paddingHorizontal: 14,
                          minHeight: 60,
                          borderBottomWidth: 1,
                          gap: 10,
                        }
                      : {
                          width: phone() ? "100%" : 267,
                          minHeight: 82,
                          padding: 12,
                          borderWidth: 1,
                          gap: 3,
                        }),
                    borderColor: c().border,
                    backgroundColor:
                      selectedPath() === entry().path
                        ? c().selected
                        : c().canvas,
                    cursor: "pointer",
                  }}
                >
                  <If when={tablet()}>
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        alignItems: "center",
                        justifyContent: "center",
                        borderWidth: 1,
                        borderColor: c().border,
                        backgroundColor: c().surface,
                      }}
                    >
                      <Icon name="artifact" size={14} tone="muted" />
                    </View>
                  </If>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Label
                      size={tablet() ? 13 : 14}
                      line={19}
                      weight={500}
                      lines={1}
                    >
                      {entry().name}
                    </Label>
                    <Label
                      size={tablet() ? 11 : 12}
                      line={16}
                      tone="muted"
                      lines={tablet() ? 1 : 2}
                    >
                      {entry().description}
                    </Label>
                  </View>
                </View>
              )}
            </Each>
          </View>
        </Scroll>
      </If>
    </>
  );
  const reader = () => (
    <Each of={showing() ? [selected()!] : []} key={(item) => item.path}>
      {(item) => {
        const call = filesAt(untracked(resolved)!);
        return (
          <SkillDetail
            skill={item()}
            call={call}
            layout={props.layout}
            location={machineLabel()}
            scope={scopeLabel()}
            onClose={() => selectedPath.set("")}
          />
        );
      }}
    </Each>
  );

  return (
    <If
      when={tablet()}
      else={
        <>
          <If when={!phone() || !showing()}>
            <Header title={uiText("plugins")} layout={props.layout} inset={10}>
              <View style={{ flex: 1 }} />
              <If when={!showing()}>
                {deviceMenu(160)}
                <Button
                  label={uiText("skillReload")}
                  icon="refresh"
                  iconOnly
                  tone="ghost"
                  onPress={refresh}
                />
              </If>
            </Header>
            {props.tabs()}
          </If>
          <If when={showing()} else={list()}>
            {reader()}
          </If>
        </>
      }
    >
      <View style={{ ...row, ...grow, alignItems: "stretch" }}>
        <View
          style={{
            width: 320,
            flexShrink: 0,
            borderRightWidth: 1,
            borderColor: c().border,
          }}
        >
          <Header
            title={uiText("skillsTab")}
            count={entries().length}
            layout="tablet"
            inset={14}
          >
            <View style={{ flex: 1 }} />
            <Button
              label={uiText("skillReload")}
              icon="refresh"
              iconOnly
              onPress={refresh}
            />
          </Header>
          {props.tabs()}
          {list()}
        </View>
        <View style={grow}>
          <If
            when={showing()}
            else={<Empty title={uiText("skillSelect")} icon="folder" />}
          >
            {reader()}
          </If>
        </View>
      </View>
    </If>
  );
}

function SkillDetail(props: {
  skill: SkillSummary;
  call: SkillCall;
  layout: Layout;
  location: string;
  scope: string;
  onClose: () => void;
}) {
  const c = colors();
  const handle = signal("");
  const files = signal<SkillFileEntry[]>([]);
  const file = signal<SkillFileContent>();
  const fileName = signal("");
  const directory = signal("");
  const showFiles = signal(false);
  const metadata = signal(false);
  const history = signal<{ path: string; y: number; metadata: boolean }[]>([]);
  const position = signal<SkillReadingPosition>();
  const scroll = signal<ScrollRef>();
  const contentStart = signal<ViewRef>();
  const failure = signal("");
  const reading = signal(false);
  const retry = signal(0);
  const openDiagnostics = signal<string[]>([]);
  const phone = () => props.layout === "phone";
  const tablet = () => props.layout === "tablet";
  let request = 0;
  let linkRequest = 0;
  let scrollY = 0;
  function showError(error: unknown) {
    failure.set(error instanceof Error ? error.message : String(error));
  }

  effect(() => {
    const skill = props.skill.path;
    const call = props.call;
    retry();
    let active = true;
    let opened: string | undefined;
    cleanup(() => {
      active = false;
      request++;
      if (opened) void call("close", { detail: opened }).catch(() => {});
    });
    request++;
    handle.set("");
    files.set([]);
    file.set(undefined);
    fileName.set("");
    directory.set("");
    metadata.set(false);
    history.set([]);
    position.set(undefined);
    scrollY = 0;
    reading.set(false);
    failure.set("");
    openDiagnostics.set([]);
    void call<SkillFileResults["open"]>("open", { skill }).then(
      (result) => {
        opened = result.detail;
        if (active) {
          openDiagnostics.set(result.diagnostics);
          handle.set(opened);
        } else void call("close", { detail: opened }).catch(() => {});
      },
      (error) => {
        if (active) showError(error);
      },
    );
  });

  effect(() => {
    const detail = handle();
    const path = directory();
    files.set([]);
    if (!detail) return;
    const call = props.call;
    let active = true;
    cleanup(() => {
      active = false;
    });
    void (async () => {
      try {
        let offset: number | null = 0;
        const entries: SkillFileEntry[] = [];
        do {
          const result: SkillFileResults["directory"] = await call(
            "directory",
            { detail, path, offset },
          );
          if (!active) return;
          entries.push(...result.entries);
          offset = result.next;
        } while (offset !== null);
        files.set(entries);
        if (!path && !untracked(fileName)) void read("SKILL.md");
      } catch (error) {
        if (active) showError(error);
      }
    })();
  });

  async function read(
    path: string,
    target: SkillReadingPosition = { kind: "offset", y: 0 },
    expandedMetadata = false,
  ) {
    const detail = handle();
    if (!detail) return;
    const version = ++request;
    file.set(undefined);
    fileName.set(path);
    metadata.set(expandedMetadata);
    position.set(undefined);
    scrollY = target.kind === "offset" ? target.y : 0;
    failure.set("");
    reading.set(true);
    try {
      const result = await props.call<SkillFileContent>("read", {
        detail,
        path,
      });
      if (version === request) {
        file.set(result);
        position.set(target);
      }
    } catch (error) {
      if (version === request) showError(error);
    } finally {
      if (version === request) reading.set(false);
    }
  }

  const preview = () => {
    const content = file();
    return content?.kind === "text" ? content.preview : undefined;
  };
  const refresh = () => retry.update((count) => count + 1);
  const reload = () => (
    <Button
      label={uiText("skillReloadReader")}
      icon="refresh"
      iconOnly
      tone={tablet() ? "plain" : "ghost"}
      onPress={refresh}
    />
  );
  const crumbs = () => [props.location, props.scope].join(" / ");
  async function resource(path: string) {
    return props.call<SkillFileContent>("read", { detail: handle(), path });
  }
  async function followFileLink(url: string, focusTarget?: ViewRef) {
    if (!file()) return;
    const navigation = ++linkRequest;
    if (/^https?:\/\//i.test(url)) {
      void openUrl(url).catch(showError);
      return;
    }
    const source = fileName();
    const link = skillFileLink(source, url);
    if (!link) return;
    const target: SkillReadingPosition =
      link.heading === undefined
        ? { kind: "offset", y: 0 }
        : { kind: "heading", heading: link.heading };
    if (link.path === source) {
      position.set(target);
      return;
    }
    const sourceRequest = request;
    const [preview, origin, focused] = await Promise.all([
      scroll()?.measure(),
      contentStart()?.measure(),
      focusTarget?.measure(),
    ]).catch(() => []);
    if (navigation !== linkRequest || sourceRequest !== request) return;
    // Tab can scroll to a link before the scroll event reaches the reader.
    let y =
      preview && origin
        ? Math.max(0, preview.pagePosition.y - origin.pagePosition.y)
        : scrollY;
    if (preview && origin && focused) {
      const fromTop = focused.pagePosition.y - preview.pagePosition.y;
      const viewerHeight = preview.bounds.size.height;
      const linkHeight = focused.bounds.size.height;
      if (fromTop < 0 || fromTop + linkHeight > viewerHeight) {
        // Fast Tab/Enter can leave an older focus scroll in flight. Return to the link that opened the file.
        y = Math.max(0, y + fromTop - (viewerHeight - linkHeight) / 2);
      }
    }
    history.update((entries) => [
      ...entries,
      { path: source, y, metadata: metadata() },
    ]);
    directory.set(link.path.split("/").slice(0, -1).join("/"));
    void read(link.path, target);
  }
  function previousFile() {
    const prior = history().at(-1);
    if (!prior) {
      props.onClose();
      return;
    }
    history.update((entries) => entries.slice(0, -1));
    showFiles.set(false);
    directory.set(prior.path.split("/").slice(0, -1).join("/"));
    void read(prior.path, { kind: "offset", y: prior.y }, prior.metadata);
  }
  function toggleFiles() {
    if (showFiles()) position.set({ kind: "offset", y: scrollY });
    showFiles.set(!showFiles());
  }
  async function scrollToHeading(anchor: ViewRef, isCurrent: () => boolean) {
    const start = contentStart();
    const preview = scroll();
    if (!start || !preview) return;
    const [target, origin] = await Promise.all([
      anchor.measure(),
      start.measure(),
    ]);
    if (!isCurrent() || !target || !origin) return;
    // An inline text marker sits on the first line's baseline. Leave the heading above it visible.
    preview.scrollTo({
      y: Math.max(0, target.pagePosition.y - origin.pagePosition.y - 36),
      animated: false,
    });
    position.set(undefined);
  }
  const previousButton = (iconOnly = false) => (
    <If when={history().length}>
      <Button
        label={uiText("skillPreviousFile")}
        icon="back"
        iconOnly={iconOnly}
        tone="ghost"
        onPress={previousFile}
      />
    </If>
  );
  const diagnostics = () => {
    const content = file();
    return [
      ...new Set([
        ...props.skill.diagnostics,
        ...openDiagnostics(),
        ...(content?.kind === "text" ? content.diagnostics : []),
      ]),
    ];
  };

  const fileTree = () => (
    <Scroll
      style={
        phone()
          ? grow
          : {
              width: tablet() ? 120 : 160,
              flexShrink: 0,
              borderRightWidth: 1,
              borderColor: c().border,
            }
      }
      scrollbar={false}
    >
      <View style={{ padding: 4 }}>
        <If when={directory()}>
          <Button
            label={uiText("parentDirectory")}
            icon="back"
            tone="ghost"
            style={{ justifyContent: "flex-start" }}
            onPress={() =>
              directory.set(directory().split("/").slice(0, -1).join("/"))
            }
          />
        </If>
        <Each of={files()} key={(item) => item.path}>
          {(item) => {
            const path = () =>
              [directory(), item().path].filter(Boolean).join("/");
            return (
              <View
                role="button"
                accessibilityLabel={item().path}
                accessibilityState={{
                  selected: fileName() === path(),
                  disabled: item().kind === "blocked",
                }}
                disabled={item().kind === "blocked"}
                onPress={() => {
                  if (item().kind === "directory") directory.set(path());
                  else if (item().kind === "file") {
                    history.set([]);
                    showFiles.set(false);
                    void read(path());
                  }
                }}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{
                  ...row,
                  height: 24,
                  paddingHorizontal: 8,
                  gap: 5,
                  opacity: item().kind === "blocked" ? 0.45 : 1,
                  backgroundColor:
                    fileName() === path() ? c().selected : c().canvas,
                  cursor: item().kind === "blocked" ? "default" : "pointer",
                }}
              >
                <If when={item().kind === "directory"}>
                  <Icon name="folder" size={12} />
                </If>
                <Label size={12} lines={1}>
                  {item().path}
                </Label>
              </View>
            );
          }}
        </Each>
      </View>
    </Scroll>
  );

  const filePreview = () => (
    <Scroll
      ref={scroll.set}
      style={grow}
      scrollbar={false}
      onScroll={({ offset }) => {
        if (file()) scrollY = offset.y;
      }}
    >
      <View
        ref={contentStart.set}
        style={{ paddingHorizontal: 12, paddingBottom: 12, gap: 8 }}
      >
        <If when={failure()}>
          <Label size={12} tone="red">
            {failure()}
          </Label>
          <Button
            label={uiText("retry")}
            onPress={refresh}
            style={{ alignSelf: "flex-start" }}
          />
        </If>
        <If when={preview()?.metadata}>
          <View style={{ borderBottomWidth: 1, borderColor: c().border }}>
            <Button
              label={uiText("metadata")}
              icon={metadata() ? "down" : "right"}
              tone="ghost"
              size={36}
              style={{ justifyContent: "flex-start", paddingHorizontal: 0 }}
              onPress={() => metadata.set(!metadata())}
            />
            <If when={metadata()}>
              <Label
                size={12}
                line={16}
                tone="muted"
                style={{ paddingLeft: 16, paddingBottom: 8 }}
              >
                {preview()!.metadata}
              </Label>
            </If>
          </View>
        </If>
        <If
          when={file()}
          else={
            <If when={!failure()}>
              <Label tone="muted" size={12} style={{ paddingTop: 8 }}>
                {reading() || !handle()
                  ? uiText("loadingSkill")
                  : uiText("selectAFile")}
              </Label>
            </If>
          }
        >
          {(content) => (
            <SkillFile
              content={content()}
              path={fileName()}
              position={position()}
              onLink={(url, focusTarget) =>
                void followFileLink(url, focusTarget)
              }
              onOffset={(y) => scroll()?.scrollTo({ y, animated: false })}
              onHeading={(anchor, active) =>
                void scrollToHeading(anchor, active)
              }
              read={resource}
            />
          )}
        </If>
      </View>
    </Scroll>
  );

  return (
    <View style={grow}>
      <If when={phone()}>
        <Header
          title={props.skill.name}
          layout="phone"
          onBack={previousFile}
          inset={12}
        />
        <View
          style={{
            paddingHorizontal: 16,
            paddingTop: 5,
            paddingBottom: 8,
            gap: 2,
          }}
        >
          <View style={{ ...row, height: 29 }}>
            <Label size={11} tone="muted" style={{ flex: 1 }}>
              {crumbs()}
            </Label>
            {reload()}
          </View>
          <View
            role="button"
            accessibilityLabel={uiText("files")}
            accessibilityState={{ expanded: showFiles() }}
            onPress={toggleFiles}
            style={{
              ...row,
              height: 28,
              gap: 6,
              alignSelf: "flex-start",
              paddingHorizontal: 10,
              borderWidth: 1,
              borderColor: showFiles() ? c().ink : c().strong,
              cursor: "pointer",
            }}
          >
            <Icon name="folder" size={11} />
            <Label size={12}>{uiText("files")}</Label>
            <If when={!showFiles() && fileName()}>
              <Label size={11} tone="muted">
                {fileName()}
              </Label>
            </If>
          </View>
        </View>
      </If>
      <If when={tablet()}>
        <Header title={props.skill.name} layout="tablet" inset={14}>
          <Label
            size={12}
            tone="muted"
            style={{ flex: 1 }}
          >{`${props.scope} · ${props.location}`}</Label>
          {previousButton(true)}
          {reload()}
        </Header>
      </If>
      <If when={!tablet() && !phone()}>
        <View style={{ paddingHorizontal: 24, paddingBottom: 8, gap: 6 }}>
          <View style={{ ...row, gap: 8 }}>
            <Button
              label={uiText("skillBackToList")}
              tone="ghost"
              onPress={props.onClose}
            />
            {previousButton()}
          </View>
          <View style={{ ...row, gap: 6 }}>
            <Label size={12} tone="muted">{`${crumbs()} /`}</Label>
            <Label size={12} weight={600}>
              {props.skill.name}
            </Label>
            {reload()}
          </View>
        </View>
      </If>
      <If when={diagnostics().length}>
        <View
          accessibilityLabel={uiText("skillDiagnostics")}
          style={{
            paddingHorizontal: phone() ? 16 : tablet() ? 12 : 24,
            gap: 4,
          }}
        >
          <Each of={diagnostics()} key={(message) => message}>
            {(message) => (
              <Label size={11} tone="amber">
                {message()}
              </Label>
            )}
          </Each>
        </View>
      </If>
      <View
        style={{
          ...grow,
          ...row,
          alignItems: "stretch",
          marginHorizontal: phone() ? 16 : tablet() ? 12 : 24,
          marginTop: tablet() ? 12 : 0,
          marginBottom: phone() || tablet() ? 12 : 16,
          borderWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={!phone() || showFiles()}>{fileTree()}</If>
        <If when={!phone() || !showFiles()}>{filePreview()}</If>
      </View>
    </View>
  );
}
