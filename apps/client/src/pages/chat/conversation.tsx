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
import type { Layout } from "../../components";
import type { ArtifactFilters } from "./artifacts/filter";
import type { PanelTab } from "./conversation-panel";
import { computed, effect, signal, View, windowSize } from "nsh";
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
import { uiText } from "../../i18n";
import { CaptainFace } from "../../navigation/captain";
import { follow, useHost } from "../../services/host";
import { isActiveRunStatus } from "../tasks/run-log";
import { flashQuestion, PendingStrip, pendingStripHeight } from "./approvals";
import { defaultFilters } from "./artifacts/filter";
import { ArtifactPreview } from "./artifacts/preview";
import { Composer } from "./composer";
import { PhoneConversationInfo } from "./conversation-info";
import { ConversationPanel, panelAttention } from "./conversation-panel";
import { ConversationTimeline } from "./conversation-timeline";
import { indexInserts, InsertMessage } from "./insert-message";
import { keptMessages } from "./kept-messages";
import { InviteAgents, StewardMenu } from "./members";
import { questionRowIndex, questionSource } from "./question-row";
import { RemoveMember } from "./remove-member";
import { MemberRun } from "./run/member-run";
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
  const c = colors();
  const panel = signal<PanelTab>("Context");
  const drawer = signal(false);
  const invite = signal(false);
  const removing = signal<string | undefined>(undefined);
  const projectInfo = signal(false);
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
  const messages = computed(() => {
    const waiting = new Set(held().map((message) => message.id));
    return keep(
      [
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
    );
  });
  const indexed = computed(() => indexInserts(messages()));
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
    if (source?.kind === "task") openTask(source.taskId);
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
            phone() && props.captain ? (
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
          <If when={!phone() && project() && group()}>
            <View
              role="button"
              accessibilityLabel={project()?.name ?? ""}
              onPress={() => {
                panel.set("Context");
                if (props.layout === "desktop") projectInfo.set(true);
                else drawer.set(true);
              }}
              hoverStyle={{ backgroundColor: c().selected }}
              style={{
                ...row,
                gap: space[4],
                paddingVertical: space[2],
                paddingHorizontal: space[8],
                borderWidth: 1,
                borderColor: c().border,
                flexShrink: 0,
                cursor: "pointer",
              }}
            >
              <Icon name="folder" size={icon.sm} tone="muted" />
              <Label variant="small" tone="muted" lines={1}>
                {project()?.name ?? ""}
              </Label>
            </View>
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
              recipients={indexed().recipients}
              members={members()}
              onMember={(agentId) => {
                const named = members().find((m) => m.agentId === agentId);
                if (named)
                  member.set({ id: agentId, session: named.sessionId ?? "" });
              }}
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
                  host.call("conversations", "update", {
                    conversationId: props.id,
                    archived: false,
                  }),
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
      <If when={projectInfo() && project()}>
        <Modal
          title={project()?.name ?? uiText("directory")}
          width={dialogWidth.md}
          onClose={() => projectInfo.set(false)}
        >
          <Label style={{ padding: space[16] }}>
            {project()?.display ?? project()?.path}
          </Label>
        </Modal>
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
          title={uiText("runTranscript")}
          phone={phone()}
          onClose={() => member.set(undefined)}
        >
          <MemberRun
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
