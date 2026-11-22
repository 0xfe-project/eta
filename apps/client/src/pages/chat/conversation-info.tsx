import type { ArtifactView, MemberView } from "@eta/client-contracts";
import type { JSX, Signal } from "nsh";
import type { TextVariant } from "../../components";
import type { ArtifactFilters } from "./artifacts/filter";
import { signal, View } from "nsh";
import {
  Caption,
  colors,
  Empty,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { ContextRing, useContextUsage } from "../../components/context-ring";
import { BackButton, CloseButton } from "../../components/navigation-buttons";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskGlyph } from "../tasks/status";
import { ArtifactBrowser } from "./artifacts/conversation-artifacts";
import { RECENT, recentArtifacts } from "./artifacts/filter";
import { memberStatus } from "./member-status";
import { messageTime } from "./message-time";
import { ViewAll } from "./section-heading";

/**
 * A phone's conversation info sheet: members, tasks and the latest artifacts in one list; "View
 * all" turns the sheet into the group's whole Artifacts list (search, filter, pages).
 */
export function PhoneConversationInfo(props: {
  id: string;
  name: string;
  project?: string;
  members: MemberView[];
  onClose: () => void;
  onInspect: (value: { id: string; session: string }) => void;
  onTask: (id: string) => void;
  onArtifact: (artifact: ArtifactView) => void;
  artifactFilters: Signal<ArtifactFilters>;
}) {
  const host = useHost();
  const c = colors();
  const allArtifacts = signal(false);
  const tasks = () =>
    host
      .tasks()
      .filter((task) => task.conversationId === props.id && !task.archivedAt)
      .sort((a, b) => a.number - b.number);
  const artifacts = () =>
    host.artifacts().filter((artifact) => artifact.conversationId === props.id);
  return (
    <If when={!allArtifacts()} else={<AllArtifacts />}>
      <View style={grow}>
        <View
          style={{
            ...row,
            height: 44,
            paddingLeft: 16,
            paddingRight: 8,
            flexShrink: 0,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label weight={600} lines={1}>
              {props.name}
            </Label>
            <If when={props.project}>
              <Label variant="caption" tone="muted" lines={1}>
                {props.project}
              </Label>
            </If>
          </View>
          <CloseButton size={32} iconSize={16} onPress={props.onClose} />
        </View>
        <SmoothScroll style={grow} scrollbar={false}>
          <Section
            label={uiText("members")}
            count={props.members.length}
            first
          />
          <Each of={props.members} key={(member) => member.agentId}>
            {(member) => (
              <MemberRow
                member={member()}
                onInspect={(session) =>
                  props.onInspect({ id: member().agentId, session })
                }
              />
            )}
          </Each>
          <Section label={uiText("tasks2")} count={tasks().length} />
          <Each of={tasks()} key={(task) => task.id}>
            {(task) => (
              <InfoRow
                height={48}
                title={`#${task().number} ${task().title}`}
                onPress={() => props.onTask(task().id)}
              >
                <TaskGlyph status={task().status} size={14} />
              </InfoRow>
            )}
          </Each>
          <Section label={uiText("chatArtifacts")} count={artifacts().length}>
            <If when={artifacts().length > RECENT}>
              <View style={{ flex: 1 }} />
              <ViewAll
                label={uiText("artifactsViewAll")}
                phone
                onPress={() => allArtifacts.set(true)}
              />
            </If>
          </Section>
          <Each
            of={recentArtifacts(artifacts())}
            key={(artifact) => artifact.id}
          >
            {(artifact) => (
              <InfoRow
                height={52}
                title={artifact().title}
                detail={[
                  host.agent(artifact().publisherAgentId ?? "")?.name,
                  artifact().versions[0] &&
                    `v${artifact().versions[0]!.number}`,
                  messageTime(artifact().updatedAt, true),
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onPress={() => props.onArtifact(artifact())}
              >
                <Icon name="artifact" size={16} />
              </InfoRow>
            )}
          </Each>
          <If when={!artifacts().length}>
            <Empty
              icon="appWindow"
              iconSize={24}
              title={uiText("noArtifactsYet")}
              description={uiText("artifactsEmptyHelp")}
              descriptionVariant="caption"
              style={{ flex: 0, paddingVertical: 32 }}
            />
          </If>
        </SmoothScroll>
      </View>
    </If>
  );

  function AllArtifacts() {
    return (
      <View style={grow}>
        <View
          style={{
            ...row,
            height: 44,
            gap: 4,
            paddingLeft: 4,
            paddingRight: 8,
            flexShrink: 0,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <BackButton
            size={32}
            iconSize={16}
            onPress={() => allArtifacts.set(false)}
          />
          <Label weight={600} lines={1}>
            {uiText("chatArtifacts")}
          </Label>
          <Label variant="small" tone="muted" style={{ flex: 1 }}>
            {artifacts().length}
          </Label>
          <CloseButton size={32} iconSize={16} onPress={props.onClose} />
        </View>
        <ArtifactBrowser
          artifacts={artifacts()}
          filters={props.artifactFilters}
          phone
          onOpen={props.onArtifact}
          onTask={props.onTask}
        />
      </View>
    );
  }

  function Section(section: {
    label: string;
    count: number;
    first?: boolean;
    children?: JSX.Element;
  }) {
    return (
      <View
        style={{
          ...row,
          height: 32,
          gap: 6,
          paddingHorizontal: 16,
          flexShrink: 0,
          backgroundColor: c().selected,
          borderTopWidth: section.first ? 1 : 0,
          borderBottomWidth: section.first ? 0 : 1,
          borderColor: c().border,
        }}
      >
        <Caption text={section.label} phone />
        <Label variant="caption" tone="muted">
          {section.count}
        </Label>
        {section.children}
      </View>
    );
  }
}

/**
 * A member in the sheet: the face ringed by how full its context is, and the status with the
 * same percentage beside it, since a phone has no hover to ask the ring.
 */
function MemberRow(props: {
  member: MemberView;
  onInspect: (session: string) => void;
}) {
  const host = useHost();
  const usage = useContextUsage(() => props.member.sessionId ?? undefined);
  const detail = () => {
    const status = memberStatus(props.member.status);
    const current = usage();
    return current ? `${status} · ${current.percent}%` : status;
  };
  return (
    <InfoRow
      height={52}
      title={host.agent(props.member.agentId)?.name ?? uiText("agent")}
      titleVariant="body"
      detail={detail()}
      onPress={
        props.member.sessionId
          ? () => props.onInspect(props.member.sessionId!)
          : undefined
      }
    >
      <If
        when={props.member.sessionId}
        else={
          <View
            style={{
              width: 32,
              height: 32,
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <AgentFace id={props.member.agentId} size={20} />
          </View>
        }
      >
        <ContextRing usage={usage} size={32} label={false}>
          <AgentFace id={props.member.agentId} size={20} />
        </ContextRing>
      </If>
    </InfoRow>
  );
}

function InfoRow(props: {
  height: number;
  title: string;
  titleVariant?: TextVariant;
  detail?: string;
  children: JSX.Element;
  onPress?: () => void;
}) {
  const c = colors();
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={() => props.onPress?.()}
      hoverStyle={props.onPress ? { backgroundColor: c().selected } : undefined}
      style={{
        ...row,
        height: props.height,
        gap: 12,
        paddingLeft: 16,
        paddingRight: 12,
        flexShrink: 0,
        borderBottomWidth: 1,
        borderColor: c().border,
        cursor: props.onPress ? "pointer" : "default",
      }}
    >
      {props.children}
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Label variant={props.titleVariant ?? "small"} lines={1}>
          {props.title}
        </Label>
        <If when={props.detail}>
          <Label variant="caption" tone="muted" lines={1}>
            {props.detail}
          </Label>
        </If>
      </View>
      <View style={{ opacity: 0.45 }}>
        <Icon name="right" size={14} />
      </View>
    </View>
  );
}
