import type {
  ArtifactView,
  BoardTaskDetail,
  CaptainOperationView,
  ConversationInfo,
  HistoryResult,
  InteractionView,
  MemberView,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { ViewRef } from "nsh";
import type { Layout } from "../../components";
import type { ArtifactFilters } from "./artifacts/filter";
import type { PanelTab } from "./conversation-panel";
import { computed, effect, signal, untracked, View, windowSize } from "nsh";
import { desktopPanelOpen, setDesktopPanelOpen } from "../../app/desktop-panel";
import { paneWidth } from "../../app/pane-width";
import {
  Button,
  colors,
  dialogWidth,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  PaneHandle,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { dotSize, StatusDot } from "../../components/status-dot";
import {
  avatar,
  control,
  icon,
  layer,
  opacity,
  shadow,
  space,
  weight,
} from "../../components/tokens";
import { uiText, useText } from "../../i18n";
import { CaptainFace } from "../../navigation/captain";
import { RailButton } from "../../navigation/rail-controls";
import { follow, useHost } from "../../services/host";
import { isActiveRunStatus } from "../tasks/run-log";
import { flashQuestion, PendingStrip, pendingStripHeight } from "./approvals";
import { defaultFilters } from "./artifacts/filter";
import { ArtifactPreview } from "./artifacts/preview";
import { Composer } from "./composer";
import { openComposerDraft, placedNow, retryOutgoing } from "./composer-draft";
import { PhoneConversationInfo } from "./conversation-info";
import { ConversationPanel, panelAttention } from "./conversation-panel";
import { ConversationTimeline } from "./conversation-timeline";
import { indexInserts, InsertMessage } from "./insert-message";
import { keptMessages } from "./kept-messages";
import { InviteAgents, StewardMenu } from "./members";
import { deliveries, outgoingRow, waitsForOf } from "./outbox";
import { QuestionDialog } from "./pending";
import { questionRowIndex, questionSource } from "./question-row";
import { RemoveMember } from "./remove-member";
import { MemberInspect } from "./run/member-inspect";
import { RunPanel } from "./run/run-panel";

/** The toast that says a late insert went in, as wide as the app's toasts. */
const lateInsertWidth = 356;

function FollowTask(props: { id: string }) {
  follow(() => `tasks.${props.id}`);
  return null;
}

export function Conversation(props: {
  id: string;
  layout: Layout;
  captain?: boolean;
  onBack?: () => void;
  /** A tablet's group list is folded away: the button that brings it back, before the title. */
  onExpandList?: () => void;
  attachExpandList?: (node: ViewRef | null) => void;
  onTask: (id: string) => void;
  onRelatedTask: (id: string) => void;
  onReadDraft?: () => void;
  onAccessLost: () => void;
  onRoutines: (id?: string) => void;
  /** Opens the Pending tab, from Captain's approvals strip on a phone. */
  onPending?: () => void;
  contentWidth?: number;
  alignComposer?: boolean;
  rail?: boolean;
  taskId?: string;
  onCloseTask: () => void;
}) {
  const host = useHost();
  const text = useText();
  const c = colors();
  const panel = signal<PanelTab>("Context");
  const drawer = signal(false);
  const invite = signal(false);
  const removing = signal<string | undefined>(undefined);
  const member = signal<{ id: string; session: string }>();
  const memberSteps = signal("");
  // The Artifacts tab's search, filters and page: kept across tabs, dropped for another group.
  const artifactFilters = signal<ArtifactFilters>(defaultFilters);
  let filtersFor = props.id;
  effect(() => {
    if (props.id === filtersFor) return;
    filtersFor = props.id;
    artifactFilters.set(defaultFilters);
  });
  const preview = signal<{ artifact: ArtifactView; version?: number }>();
  const openArtifact = (artifact: ArtifactView, version?: number) =>
    preview.set({ artifact, version });
  const widgetDraft = signal<
    { conversationId: string; text: string } | undefined
  >(undefined);
  const quote = signal<{ conversationId: string; text: string } | undefined>(
    undefined,
  );
  const older = signal<MessageView[]>([]);
  const hasOlder = signal<boolean | undefined>(undefined);
  const paging = signal(false);
  const model = signal("");
  const target = () => `conversations.${props.id}`;
  follow(target);
  const reloadArtifacts = follow(() => "artifacts");
  const info = () => host.section<ConversationInfo>(target(), "info");
  const summary = () => host.conversation(props.id);
  const members = () =>
    host.section<MemberView[]>(target(), "members") ??
    summary()?.participants ??
    [];
  const title = () =>
    info()?.name ?? summary()?.name ?? (props.captain ? "Captain" : "Chat");
  const group = () => (info()?.kind ?? summary()?.kind) === "group";
  const project = () =>
    host
      .projects()
      .find((item) => item.id === (info()?.projectId ?? summary()?.projectId));
  const stewardId = () => (info() ? info()!.stewardId : summary()?.stewardId);
  const timeline = () => host.section<TimelineSection>(target(), "timeline");
  const approvals = () =>
    host
      .list<CaptainOperationView>("captain", "operations")
      .filter((op) => op.requiresApproval && op.status === "pending");
  let reveal: ((replyId: string | null) => void) | undefined;
  const asking = () =>
    host.pending().filter((entry) => entry.conversationId === props.id);
  /** The question whose dialog is open, when the strip had nowhere else to go. */
  const questionId = signal("");
  const question = () => asking().find((entry) => entry.id === questionId());
  // The board list does not carry a task's runs, so the tasks that could have asked (running, in
  // this conversation) are followed while the strip shows their question and matched by session.
  const askingTasks = (item: InteractionView) =>
    host
      .tasks()
      .filter(
        (task) =>
          task.conversationId === item.conversationId &&
          task.runStatus !== null &&
          isActiveRunStatus(task.runStatus),
      );
  const held = () => timeline()?.held ?? [];
  /*
   * A message that waits for a lane is not in the conversation yet, and neither is the reply the
   * host queued for it. The host leaves the message out of the window but not the reply rows under
   * it (they carry no `held` of their own), so they are held back here: otherwise the transcript
   * draws an empty turn, as if the message had gone out. Both stay in the lane above the composer
   * until a lane takes the message.
   */
  const keep = keptMessages();
  /*
   * The reader's messages on their way (the outbox the composer sends from, and the ones the host
   * took whose row has not come yet). One that goes into the conversation is a row at the end of
   * the transcript under the id the host will give it, so the host's row takes its place without
   * the list moving; one that will wait is in the queue above the composer.
   */
  const outbox = openComposerDraft(host.address()!.origin, props.id);
  const shownIds = computed(
    () =>
      new Set(
        [...(timeline()?.messages ?? []), ...held()].map(
          (message) => message.id,
        ),
      ),
  );
  const onTheWay = computed(() =>
    deliveries({
      outgoing: outbox.value().outgoing,
      landed: outbox.landed(),
      shown: shownIds(),
    }),
  );
  // The host's rows came: they show from now on.
  effect(() => outbox.settle([...shownIds()]));
  // A message saved by an earlier run of the app is placed once its chat knows who is busy.
  effect(() => {
    const kind = info()?.kind ?? summary()?.kind;
    const memberViews = members();
    if (!kind || !memberViews.length || !outbox.ready()) return;
    const unplaced = outbox.value().outgoing.filter((item) => !item.waitsFor);
    if (!unplaced.length) return;
    untracked(() =>
      outbox.edit({
        outgoing: outbox.value().outgoing.map((item) =>
          item.waitsFor
            ? item
            : placedNow({
                ...item,
                at: item.at ?? Date.now(),
                waitsFor: waitsForOf({
                  kind,
                  members: memberViews,
                  steward: stewardId(),
                  mentions: item.mentions,
                }),
              }),
        ),
      }),
    );
  });
  const deliveryActions = (id: string) => ({
    onRetry: () =>
      retryOutgoing(outbox, host, host.address()!.origin, props.id, id),
    onEdit: () => {
      const message = outbox.value().outgoing.find((item) => item.id === id);
      if (message) outbox.editing.set(message);
    },
    onDiscard: () =>
      outbox.edit({
        outgoing: outbox.value().outgoing.filter((item) => item.id !== id),
      }),
  });
  const sending = computed(() =>
    onTheWay().filter((entry) => !entry.waitsFor.length),
  );
  const deliveryRows = computed(
    () =>
      new Map(
        // One the host took is sent: it reads as sent while its row is on the way.
        sending().flatMap((entry) =>
          entry.landed
            ? []
            : [
                [
                  entry.message.id,
                  {
                    failure: entry.failure,
                    ...deliveryActions(entry.message.id),
                  },
                ] as const,
              ],
        ),
      ),
  );
  /** Messages this window sent: the transcript is taken to the end when one of them lands in it. */
  const mine = signal<ReadonlySet<string>>(new Set());
  effect(() => {
    const ids = onTheWay().map((entry) => entry.message.id);
    const known = untracked(mine);
    if (ids.some((id) => !known.has(id))) mine.set(new Set([...known, ...ids]));
  });
  const messages = computed(() => {
    const waiting = new Set(held().map((message) => message.id));
    return keep([
      ...[
        ...new Map(
          [...older(), ...(timeline()?.messages ?? [])].map((message) => [
            message.id,
            message,
          ]),
        ).values(),
      ].filter(
        (message) =>
          !waiting.has(message.id) &&
          !(
            message.author === "agent" &&
            (waiting.has(message.rootMessageId ?? "") ||
              waiting.has(message.replyToId ?? ""))
          ),
      ),
      ...sending().map((entry) => outgoingRow(props.id, entry.message)),
    ]);
  });
  const indexed = computed(() => indexInserts(messages()));
  /** The newest of this window's messages in the transcript, and whether it failed. */
  const ownNewest = computed(() => {
    const own = messages().findLast((message) => mine().has(message.id));
    return (
      own && `${own.id}${deliveryRows().get(own.id)?.failure ? ":failed" : ""}`
    );
  });
  const questionSourceOf = (item: InteractionView) =>
    questionSource(
      item,
      indexed().rows,
      askingTasks(item).flatMap((task) => {
        const detail = host.section<BoardTaskDetail>(
          `tasks.${task.id}`,
          "task",
        );
        return detail ? [{ id: task.id, runs: detail.runs }] : [];
      }),
    );
  // The rows on screen, once the transcript says; until then a loaded reply counts as on screen,
  // so the strip does not flash up while the transcript opens.
  const visibleRows = signal<ReadonlySet<string> | undefined>(undefined);
  const onScreen = (item: InteractionView) => {
    if (item.replyId === null) return false;
    const seen = visibleRows();
    return seen
      ? seen.has(item.replyId)
      : questionRowIndex(indexed().rows, item.replyId) !== undefined;
  };
  // The strip shows one question: the oldest one waiting that is not on screen.
  const offScreen = () =>
    [...asking()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .find((item) => !onScreen(item));
  // A question no loaded row carries may come from a task: its tasks are followed to find out.
  const stripTasks = () => {
    const item = offScreen();
    return item && questionRowIndex(indexed().rows, item.replyId) === undefined
      ? askingTasks(item)
      : [];
  };
  const inserting = signal<
    { message: MessageView; recipients: string[] } | undefined
  >(undefined);
  const lateInsert = signal(false);
  // The late-insert toast goes by itself, as a toast does.
  effect(() => {
    if (!lateInsert()) return;
    const timer = setTimeout(() => lateInsert.set(false), 6000);
    return () => clearTimeout(timer);
  });
  const phone = () => props.layout === "phone";
  const offline = () => phone() && host.disconnected();
  const noCachedMessages = () => offline() && !messages().length;
  let previousRead = 0;
  effect(() => {
    const visible = timeline()?.messages.at(-1)?.seq;
    if (
      !visible ||
      visible <= previousRead ||
      !summary()?.unread ||
      host.state().status !== "open"
    )
      return;
    previousRead = visible;
    void host
      .call("conversations", "read", { conversationId: props.id, seq: visible })
      .catch(() => {
        if (previousRead === visible) previousRead = 0;
      });
  });

  async function history() {
    if (paging()) return;
    paging.set(true);
    const page = await host.action(() =>
      host.call<HistoryResult>("conversations", "history", {
        conversationId: props.id,
        beforeSeq: messages()[0]?.seq,
      }),
    );
    if (page) {
      older.update((list) => [...page.messages, ...list]);
      hasOlder.set(page.hasMore);
    }
    paging.set(false);
  }
  function openTask(id: string) {
    props.onTask(id);
    if (props.layout === "desktop") setDesktopPanelOpen(true);
    else if (!phone()) drawer.set(true);
  }
  /**
   * Goes to a question: to its reply in the transcript (loading older messages until it is there),
   * or, when this conversation has no such reply, to the task whose run asked it.
   */
  async function jumpTo(item: InteractionView) {
    const loaded = () => questionRowIndex(indexed().rows, item.replyId);
    if (item.replyId !== null)
      while (
        loaded() === undefined &&
        (hasOlder() ?? timeline()?.hasMore) &&
        !paging()
      ) {
        const before = messages().length;
        await history();
        if (messages().length === before) break;
      }
    if (loaded() !== undefined) {
      reveal?.(item.replyId);
      flashQuestion(item.id);
      return;
    }
    const source = questionSourceOf(item);
    if (source?.kind === "task") {
      // The task's detail carries the question's card, over its comment box.
      openTask(source.taskId);
      flashQuestion(item.id);
      return;
    }
    // Nowhere to take the user (no loaded reply, no task matched yet): it is answered right here.
    questionId.set(item.id);
  }
  function retryReply(reply: MessageView) {
    const rows = indexed().rows;
    const replyIndex = rows.findIndex((entry) => entry.id === reply.id);
    const source =
      rows.find(
        (entry) =>
          entry.author === "user" &&
          (entry.id === reply.replyToId || entry.id === reply.rootMessageId),
      ) ??
      rows
        .slice(0, replyIndex >= 0 ? replyIndex : rows.length)
        .findLast((entry) => entry.author === "user");
    if (!source?.text.trim()) return;
    void host.action(() =>
      host.call("conversations", "send", {
        conversationId: props.id,
        clientId: crypto.randomUUID(),
        text: source.text,
        mode: "queue",
        mentions: reply.agentId ? [reply.agentId] : source.mentions,
      }),
    );
  }
  function closeDrawer() {
    drawer.set(false);
    member.set(undefined);
    props.onCloseTask();
  }
  function Panel() {
    return (
      <ConversationPanel
        id={props.id}
        layout={props.layout}
        captain={props.captain}
        taskId={props.taskId}
        drawer={props.layout === "tablet" && drawer()}
        tab={panel}
        artifactFilters={artifactFilters}
        model={model}
        info={info()}
        members={members()}
        group={group()}
        memberSteps={memberSteps()}
        onToggleSteps={(session) =>
          memberSteps.set(memberSteps() === session ? "" : session)
        }
        onInspect={member.set}
        onInvite={() => invite.set(true)}
        onRemove={removing.set}
        onTask={props.onTask}
        onRelatedTask={props.onRelatedTask}
        onCloseTask={props.onCloseTask}
        onCloseDrawer={() => drawer.set(false)}
        onRoutines={props.onRoutines}
        onArtifact={openArtifact}
        reloadArtifacts={reloadArtifacts}
      />
    );
  }
  return (
    <View style={{ ...row, ...grow, alignItems: "stretch" }}>
      <View style={grow}>
        <Header
          title={title()}
          layout={props.layout}
          onBack={props.onBack}
          inset={phone() ? (props.captain ? space[16] : undefined) : space[12]}
          end={phone() && !props.captain ? space[4] : undefined}
          compact={phone() && !props.captain}
          leading={
            props.onExpandList ? (
              <RailButton
                label={text("expandSidebar")}
                icon="sidebar"
                size={control.md}
                iconSize={icon.md}
                expanded={false}
                attach={props.attachExpandList}
                onPress={() => props.onExpandList?.()}
              />
            ) : phone() && props.captain ? (
              <CaptainFace size={avatar.md} />
            ) : undefined
          }
        >
          <If when={phone() && props.captain}>
            <Label variant="caption" tone="muted">
              {uiText(
                host.captain()?.status === "working" ? "working" : "idle",
              )}
            </Label>
          </If>
          <If when={!phone() && group()}>
            <StewardMenu
              conversationId={props.id}
              members={members()}
              current={stewardId()}
            />
          </If>
          <If when={!phone() && members().length > 1}>
            <View style={{ ...row, gap: space[8], marginLeft: space[4] }}>
              <Each of={members()} key={(entry) => entry.agentId}>
                {(entry) => <AgentFace id={entry().agentId} size={avatar.sm} />}
              </Each>
            </View>
          </If>
          <If when={!phone()}>
            <View style={{ flex: 1 }} />
          </If>
          <If when={!phone() || !props.captain}>
            <View>
              <If
                when={props.layout === "desktop"}
                else={
                  <Button
                    label={
                      phone() ? uiText("conversationInfo") : uiText("panel")
                    }
                    icon={phone() ? "info" : "sidebar"}
                    iconOnly={phone()}
                    tone={phone() ? "ghost" : "plain"}
                    size={phone() ? control.touch : undefined}
                    iconSize={phone() ? icon.md : undefined}
                    labelVariant="caption"
                    style={{ gap: space[4] }}
                    onPress={() => drawer.set(true)}
                  />
                }
              >
                <Button
                  label={uiText(desktopPanelOpen() ? "hidePanel" : "showPanel")}
                  tooltip={uiText(
                    desktopPanelOpen() ? "hidePanel" : "showPanel",
                  )}
                  expanded={desktopPanelOpen()}
                  icon="sidebar"
                  iconOnly
                  tone="ghost"
                  labelTone="muted"
                  hoverTone="ink"
                  size={control.md}
                  iconSize={icon.md}
                  onPress={() => setDesktopPanelOpen(!desktopPanelOpen())}
                />
              </If>
              <If
                when={
                  props.layout === "tablet" && panelAttention(host, props.id)
                }
              >
                <View
                  testID="panel-attention"
                  style={{
                    position: "absolute",
                    top: -3,
                    right: -3,
                    width: dotSize,
                    height: dotSize,
                    backgroundColor: c().blue,
                  }}
                />
              </If>
            </View>
          </If>
        </Header>
        <If when={phone() && props.captain && approvals().length}>
          <View
            role="button"
            accessibilityLabel={uiText("reviewProposals")}
            onPress={() => props.onPending?.()}
            style={{
              ...row,
              height: control.touch,
              flexShrink: 0,
              gap: space[8],
              paddingLeft: space[16],
              paddingRight: space[12],
              backgroundColor: c().selected,
              borderBottomWidth: 1,
              borderColor: c().border,
              cursor: "pointer",
            }}
          >
            <StatusDot color={c().warning} />
            <Label variant="small" lines={1} style={{ flex: 1 }}>
              {approvals().length === 1
                ? uiText("proposalWaitingForApproval")
                : uiText("proposalsWaitingForApproval", {
                    count: approvals().length,
                  })}
            </Label>
            <Label variant="small" weight={weight.strong}>
              {uiText("reviewProposals")}
            </Label>
            <View style={{ opacity: opacity.disabled }}>
              <Icon name="right" size={icon.md} />
            </View>
          </View>
        </If>
        <If when={offline()}>
          <View
            role="alert"
            style={{
              ...row,
              paddingVertical: space[8],
              paddingHorizontal: space[16],
              gap: space[8],
              backgroundColor: c().warningFill,
              borderBottomWidth: 1,
              borderColor: c().warning,
            }}
          >
            <Icon name="warning" tone="warningInk" size={icon.md} />
            <Label variant="small" tone="warningInk" style={{ flex: 1 }}>
              {uiText("connectionLostReconnectingWhatYouSee")}
            </Label>
          </View>
        </If>
        <View
          style={{
            ...grow,
            width: "100%",
            maxWidth: props.contentWidth,
            alignSelf: "center",
          }}
        >
          {/* The strip's room stays while questions wait, so the transcript
              does not move when the strip comes and goes with scrolling. */}
          <If when={!phone() && asking().length}>
            <View
              style={{
                height: pendingStripHeight + space[8],
                paddingHorizontal: space[16],
                paddingTop: space[8],
              }}
            >
              <If when={offScreen()}>
                {(item) => (
                  <PendingStrip
                    item={item()}
                    more={asking().length - 1}
                    onJump={(entry) => void jumpTo(entry)}
                  />
                )}
              </If>
              <Each of={stripTasks()} key={(task) => task.id}>
                {(task) => <FollowTask id={task().id} />}
              </Each>
            </View>
          </If>
          {/* The message area takes all the room between the header and the
              composer, whatever it holds (loading, empty, an error or a few
              rows), so the composer stays at the bottom by layout. */}
          <View testID="conversation-messages" style={grow}>
            <ConversationTimeline
              revealer={(fn) => {
                reveal = fn;
              }}
              onVisibleRows={visibleRows.set}
              onAccessLost={props.onAccessLost}
              title={title()}
              projectName={
                host.state().missing.projects ? undefined : project()?.name
              }
              accessible={!host.state().missing[target()] && Boolean(summary())}
              onReadDraft={props.onReadDraft}
              rows={indexed().rows}
              additions={indexed().additions}
              deliveries={deliveryRows()}
              sendingId={ownNewest()}
              recipients={indexed().recipients}
              members={members()}
              onMember={(agentId) => {
                const named = members().find((m) => m.agentId === agentId);
                if (named)
                  member.set({ id: agentId, session: named.sessionId ?? "" });
              }}
              target={target()}
              loaded={Boolean(timeline())}
              noCachedMessages={noCachedMessages()}
              hasMessages={messages().length > 0}
              hasOlder={hasOlder() ?? timeline()?.hasMore}
              paging={paging()}
              phone={phone()}
              compact={props.layout === "tablet" || props.alignComposer}
              captain={props.captain}
              rail={props.rail}
              onPending={props.onPending}
              onPageOlder={() => void history()}
              onInsert={(message) => {
                lateInsert.set(false);
                inserting.set({
                  message,
                  recipients: indexed().recipients.get(message.id) ?? [],
                });
              }}
              insertingId={inserting()?.message.id}
              onInsertClose={() => inserting.set(undefined)}
              insertPanel={() => (
                <If when={inserting()}>
                  {(entry) => (
                    <InsertMessage
                      message={entry().message}
                      initialRecipients={entry().recipients}
                      recipients={() =>
                        indexed().recipients.get(entry().message.id) ?? []
                      }
                      phone={phone()}
                      onLate={() => lateInsert.set(true)}
                      onClose={() => inserting.set(undefined)}
                    />
                  )}
                </If>
              )}
              onTask={openTask}
              onArtifact={openArtifact}
              onWidgetDraft={(conversationId, text) =>
                widgetDraft.set({ conversationId, text })
              }
              onQuote={(conversationId, text) =>
                quote.set({ conversationId, text })
              }
              onRetryReply={
                host.state().status === "open" ? retryReply : undefined
              }
            />
          </View>
          <If when={lateInsert()}>
            {/* A toast over the end of the transcript, just above the composer. */}
            <View style={{ height: 0, zIndex: layer.sticky }}>
              <View
                role="button"
                accessibilityLabel={uiText("dismiss")}
                onPress={() => lateInsert.set(false)}
                style={{
                  ...row,
                  position: "absolute",
                  bottom: 12,
                  right: 16,
                  left: phone() ? 16 : undefined,
                  width: phone() ? undefined : lateInsertWidth,
                  gap: space[8],
                  paddingVertical: space[12],
                  paddingHorizontal: space[16],
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().canvas,
                  boxShadow: [shadow.float],
                  cursor: "pointer",
                }}
              >
                <Label variant="small" style={{ flex: 1 }}>
                  {uiText("insertEnded")}
                </Label>
              </View>
            </View>
          </If>
          <Composer
            id={props.id}
            name={title()}
            members={members()}
            steward={stewardId()}
            group={group()}
            projectId={project()?.id}
            blocked={
              (info()?.archived ?? summary()?.archived)
                ? "archived"
                : (info() || summary()) && !members().length
                  ? "empty"
                  : undefined
            }
            onResolveBlock={() => {
              if (info()?.archived ?? summary()?.archived)
                void host.action(() =>
                  host.optimistic(props.id, { archived: false }, () =>
                    host.call("conversations", "update", {
                      conversationId: props.id,
                      archived: false,
                    }),
                  ),
                );
              else invite.set(true);
            }}
            writing={messages().some(
              (message) =>
                message.author === "agent" &&
                (message.status === "working" ||
                  message.status === "waiting_for_input"),
            )}
            phone={phone()}
            tablet={props.layout === "tablet"}
            alignWithContent={props.alignComposer}
            held={timeline()?.held ?? []}
            kind={
              info()?.kind ??
              summary()?.kind ??
              (props.captain ? "captain" : "group")
            }
            widgetDraft={widgetDraft()}
            quote={quote()}
          />
        </View>
      </View>
      <If when={props.layout === "desktop" && desktopPanelOpen()}>
        <View
          style={{
            width: paneWidth("panel"),
            borderLeftWidth: 1,
            borderColor: c().border,
            flexShrink: 0,
          }}
        >
          <Panel />
          <PaneHandle pane="panel" />
        </View>
      </If>
      <If
        when={drawer() && !invite() && !preview() && props.layout !== "desktop"}
      >
        <Modal
          title={phone() ? uiText("conversationInfo") : uiText("panel")}
          width={dialogWidth.sm}
          side={!phone()}
          hideHeader
          sheet={phone()}
          blurBackdrop={false}
          overPhoneNavigation
          height={phone() ? Math.max(0, windowSize().height - 104) : "100%"}
          phone={phone()}
          onClose={closeDrawer}
        >
          <If when={phone()} else={<Panel />}>
            <PhoneConversationInfo
              id={props.id}
              name={title()}
              project={project()?.display ?? project()?.path}
              members={members()}
              onClose={closeDrawer}
              onInspect={member.set}
              onTask={(id) => {
                drawer.set(false);
                props.onTask(id);
              }}
              onArtifact={openArtifact}
              artifactFilters={artifactFilters}
            />
          </If>
        </Modal>
      </If>
      <If when={question()}>
        {(item) => (
          <>
            {/* Its task may still be found while the dialog is open: it then offers to go there. */}
            <Each of={askingTasks(item())} key={(task) => task.id}>
              {(task) => <FollowTask id={task().id} />}
            </Each>
            <QuestionDialog
              item={item()}
              phone={phone()}
              onClose={() => questionId.set("")}
              onSource={
                questionSourceOf(item())
                  ? () => {
                      questionId.set("");
                      void jumpTo(item());
                    }
                  : undefined
              }
            />
          </>
        )}
      </If>
      <If when={removing() && info() ? removing() : undefined}>
        {(agentId) => (
          <RemoveMember
            info={info()!}
            members={members()}
            agentId={agentId()}
            phone={phone()}
            onClose={() => removing.set(undefined)}
          />
        )}
      </If>
      <If when={invite()}>
        <InviteAgents
          conversationId={props.id}
          members={members()}
          layout={props.layout}
          onClose={() => invite.set(false)}
        />
      </If>
      <If when={member()}>
        <RunPanel
          title={uiText("inspectRun")}
          phone={phone()}
          onClose={() => member.set(undefined)}
        >
          <MemberInspect
            session={member()!.session}
            agentId={member()!.id}
            phone={phone()}
            reply={messages().findLast(
              (message) =>
                message.author === "agent" && message.agentId === member()!.id,
            )}
            onClose={() => member.set(undefined)}
          />
        </RunPanel>
      </If>
      <If when={preview()}>
        {(selection) => (
          <ArtifactPreview
            artifact={selection().artifact}
            initialVersion={selection().version}
            layout={props.layout}
            onClose={() => preview.set(undefined)}
          />
        )}
      </If>
    </View>
  );
}
