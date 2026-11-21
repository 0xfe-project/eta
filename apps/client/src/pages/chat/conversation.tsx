import type {
  ArtifactView,
  CaptainOperationView,
  ConversationInfo,
  HistoryResult,
  MemberView,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { ArtifactFilters } from "./artifacts/filter";
import type { PanelTab } from "./conversation-panel";
import { computed, effect, signal, View, windowSize } from "nsh";
import { paneWidth } from "../../app/pane-width";
import {
  Button,
  colors,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  PaneHandle,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { StatusDot } from "../../components/status-dot";
import { uiText } from "../../i18n";
import { CaptainFace } from "../../navigation/captain";
import { follow, useHost } from "../../services/host";
import { PendingStrip } from "./approvals";
import { defaultFilters } from "./artifacts/filter";
import { ArtifactPreview } from "./artifacts/preview";
import { Composer } from "./composer";
import { PhoneConversationInfo } from "./conversation-info";
import { ConversationPanel, panelAttention } from "./conversation-panel";
import { ConversationTimeline } from "./conversation-timeline";
import { indexInserts, InsertMessage } from "./insert-message";
import { InviteAgents, StewardMenu } from "./members";
import { RemoveMember } from "./remove-member";
import { MemberRun } from "./run/member-run";
import { RunPanel } from "./run/run-panel";

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
  const older = signal<MessageView[]>([]);
  const hasOlder = signal<boolean | undefined>(undefined);
  const paging = signal(false);
  const model = signal("");
  const target = () => `conversations.${props.id}`;
  follow(target);
  const reloadArtifacts = follow(() => "artifacts");
  const info = () => host.section<ConversationInfo>(target(), "info");
  const summary = () =>
    host.conversations().find((item) => item.id === props.id);
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
  const messages = () => [
    ...new Map(
      [...older(), ...(timeline()?.messages ?? [])].map((message) => [
        message.id,
        message,
      ]),
    ).values(),
  ];
  const indexed = computed(() => indexInserts(messages()));
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
        drawer={drawer()}
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
          inset={phone() ? (props.captain ? 16 : undefined) : 10}
          end={phone() && !props.captain ? 4 : undefined}
          compact={phone() && !props.captain}
          leading={
            phone() && props.captain ? <CaptainFace size={24} /> : undefined
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
                gap: 4,
                paddingVertical: 2,
                paddingHorizontal: 6,
                borderWidth: 1,
                borderColor: c().border,
                flexShrink: 0,
                cursor: "pointer",
              }}
            >
              <Icon name="folder" size={12} tone="muted" />
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
            <View style={{ ...row, gap: 8, marginLeft: 4 }}>
              <Each of={members()} key={(entry) => entry.agentId}>
                {(entry) => <AgentFace id={entry().agentId} size={12} />}
              </Each>
            </View>
          </If>
          <If when={!phone()}>
            <View style={{ flex: 1 }} />
          </If>
          <If when={props.layout === "tablet" || (phone() && !props.captain)}>
            <View>
              <Button
                label={phone() ? uiText("conversationInfo") : uiText("panel")}
                icon={phone() ? "info" : "sidebar"}
                iconOnly={phone()}
                tone={phone() ? "ghost" : "plain"}
                size={phone() ? 40 : undefined}
                iconSize={phone() ? 16 : undefined}
                labelVariant="caption"
                style={{ gap: 6 }}
                onPress={() => drawer.set(true)}
              />
              <If when={!phone() && panelAttention(host, props.id)}>
                <View
                  style={{
                    position: "absolute",
                    top: -3,
                    right: -3,
                    width: 6,
                    height: 6,
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
              height: 44,
              flexShrink: 0,
              gap: 8,
              paddingLeft: 16,
              paddingRight: 12,
              backgroundColor: c().selected,
              borderBottomWidth: 1,
              borderColor: c().border,
              cursor: "pointer",
            }}
          >
            <StatusDot color={c().amber} />
            <Label variant="small" lines={1} style={{ flex: 1 }}>
              {approvals().length === 1
                ? uiText("proposalWaitingForApproval")
                : uiText("proposalsWaitingForApproval", {
                    count: approvals().length,
                  })}
            </Label>
            <Label variant="small" weight={600}>
              {uiText("reviewProposals")}
            </Label>
            <View style={{ opacity: 0.45 }}>
              <Icon name="right" size={14} />
            </View>
          </View>
        </If>
        <If when={offline()}>
          <View
            role="alert"
            style={{
              ...row,
              paddingVertical: 8,
              paddingHorizontal: 16,
              gap: 8,
              // The design's state-warning at 12%.
              backgroundColor: `${c().warning}1f`,
              borderBottomWidth: 1,
              borderColor: c().warning,
            }}
          >
            <Icon name="warning" tone="warningInk" size={14} />
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
          <If when={!phone() && asking().length}>
            <View style={{ paddingHorizontal: 16, paddingTop: 8 }}>
              <PendingStrip
                items={asking()}
                onOpen={(item) => reveal?.(item.replyId)}
              />
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
              onTask={(id) => {
                props.onTask(id);
                if (!phone()) drawer.set(true);
              }}
              onArtifact={openArtifact}
              onWidgetDraft={(conversationId, text) =>
                widgetDraft.set({ conversationId, text })
              }
            />
          </View>
          <If when={lateInsert()}>
            {/* A toast over the end of the transcript, just above the composer. */}
            <View style={{ height: 0, zIndex: 10 }}>
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
                  width: phone() ? undefined : 356,
                  gap: 8,
                  paddingVertical: 12,
                  paddingHorizontal: 14,
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().canvas,
                  boxShadow: [{ x: 0, y: 4, blur: 16, color: "#0a0a0a14" }],
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
          />
        </View>
      </View>
      <If when={props.layout === "desktop"}>
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
          width={360}
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
          width={400}
          onClose={() => projectInfo.set(false)}
        >
          <Label style={{ padding: 16 }}>
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
