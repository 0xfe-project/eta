import type {
  ArtifactView,
  ConversationInfo,
  HistoryResult,
  MemberView,
  MessageView,
  TimelineSection,
} from "@eta/client-contracts";
import type { Layout } from "../../components";
import type { PanelTab } from "./conversation-panel";
import { computed, effect, signal, View, windowSize } from "nsh";
import {
  Button,
  colors,
  grow,
  Header,
  Icon,
  Label,
  Modal,
  row,
  sizes,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";
import { PendingStrip } from "./approvals";
import { ArtifactPreview } from "./artifacts/preview";
import { Composer } from "./composer";
import { ConversationActions } from "./conversation-actions";
import { ConversationPanel, panelAttention } from "./conversation-panel";
import { ConversationTimeline } from "./conversation-timeline";
import { indexInserts, InsertMessage } from "./insert-message";
import { activeReply } from "./member-status";
import { InviteAgents, StewardMenu } from "./members";
import { MemberRun } from "./run/member-run";

export function Conversation(props: {
  id: string;
  layout: Layout;
  captain?: boolean;
  onBack?: () => void;
  onTask: (id: string) => void;
  onRelatedTask: (id: string) => void;
  onRoutines: (id?: string) => void;
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
  const actions = signal(false);
  const projectInfo = signal(false);
  const member = signal<{ id: string; session: string }>();
  const memberSteps = signal("");
  const artifactSearch = signal("");
  const artifactOffset = signal(0);
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
  const phone = () => props.layout === "phone";
  const offline = () => phone() && host.state().status === "reconnecting";
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
  function Panel() {
    return (
      <ConversationPanel
        id={props.id}
        layout={props.layout}
        captain={props.captain}
        taskId={props.taskId}
        drawer={drawer()}
        tab={panel}
        artifactSearch={artifactSearch}
        artifactOffset={artifactOffset}
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
        onActions={() => actions.set(true)}
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
          inset={10}
        >
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
              <Label size={12} line={16} tone="muted" lines={1}>
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
          <View style={{ flex: 1 }} />
          <If when={props.layout !== "desktop"}>
            <View>
              <Button
                label={phone() ? uiText("conversationInfo") : uiText("panel")}
                icon={phone() ? "info" : "sidebar"}
                iconOnly={phone()}
                tone={phone() ? "ghost" : "plain"}
                labelSize={11}
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
        <If when={offline()}>
          <View
            role="alert"
            style={{
              ...row,
              paddingVertical: 8,
              paddingHorizontal: 14,
              gap: 8,
              backgroundColor: c().amberFill,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Icon name="info" tone="amber" size={13} />
            <Label size={12} line={15} tone="amber" style={{ flex: 1 }}>
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
              <PendingStrip items={asking()} />
            </View>
          </If>
          <ConversationTimeline
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
            onPageOlder={() => void history()}
            onInsert={(message) => {
              lateInsert.set(false);
              inserting.set({
                message,
                recipients: indexed().recipients.get(message.id) ?? [],
              });
            }}
            onTask={(id) => {
              props.onTask(id);
              if (!phone()) drawer.set(true);
            }}
            onArtifact={openArtifact}
            onWidgetDraft={(conversationId, text) =>
              widgetDraft.set({ conversationId, text })
            }
          />
          <If when={lateInsert()}>
            <View style={{ ...row, paddingHorizontal: 12, gap: 8 }}>
              <Label size={12} tone="muted" style={{ flex: 1 }}>
                {uiText("theTurnEndedYourAdditionWas")}
              </Label>
              <Button
                label={uiText("dismiss")}
                tone="ghost"
                onPress={() => lateInsert.set(false)}
              />
            </View>
          </If>
          <Composer
            id={props.id}
            name={title()}
            members={members()}
            steward={stewardId()}
            group={group()}
            phone={phone()}
            tablet={props.layout === "tablet"}
            alignWithContent={props.alignComposer}
            held={timeline()?.held ?? []}
            widgetDraft={widgetDraft()}
            onStopMember={(agentId) => {
              const reply = messages().findLast(
                (message) =>
                  message.agentId === agentId && activeReply(message.status),
              );
              void host.action(() =>
                host.call("conversations", "stop", {
                  conversationId: props.id,
                  messageId: reply?.id,
                }),
              );
            }}
          />
        </View>
      </View>
      <If when={props.layout === "desktop"}>
        <View
          style={{
            width: sizes.panel,
            borderLeftWidth: 1,
            borderColor: c().border,
            flexShrink: 0,
          }}
        >
          <Panel />
        </View>
      </If>
      <If
        when={drawer() && !invite() && !preview() && props.layout !== "desktop"}
      >
        <Modal
          title={phone() ? uiText("conversationInfo") : uiText("panel")}
          width={360}
          side={!phone()}
          hideHeader={!phone()}
          blurBackdrop={false}
          overPhoneNavigation={!phone()}
          height={phone() ? "70%" : "100%"}
          phone={phone()}
          onClose={() => {
            drawer.set(false);
            member.set(undefined);
            props.onCloseTask();
          }}
        >
          <Panel />
        </Modal>
      </If>
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
      <If when={actions() ? info() : undefined}>
        {(active) => (
          <ConversationActions
            info={active()}
            members={members()}
            captain={props.captain}
            phone={phone()}
            onClose={() => actions.set(false)}
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
        <Modal
          title={uiText("runTranscript")}
          width={
            props.layout === "desktop"
              ? 960
              : Math.max(0, windowSize().width - 144)
          }
          height={
            phone()
              ? "100%"
              : Math.max(
                  0,
                  windowSize().height - (props.layout === "desktop" ? 100 : 48),
                )
          }
          phone={phone()}
          phonePage={phone()}
          hideHeader={!phone()}
          blurBackdrop={props.layout === "desktop"}
          overPhoneNavigation
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
        </Modal>
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
