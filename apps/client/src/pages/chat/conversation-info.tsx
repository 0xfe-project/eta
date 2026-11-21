import type { ArtifactView, MemberView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { Scroll, View } from "nsh";
import {
  Caption,
  colors,
  Empty,
  grow,
  Icon,
  Label,
  row,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { CloseButton } from "../../components/navigation-buttons";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { TaskGlyph } from "../tasks/status";
import { memberStatus } from "./member-status";
import { messageTime } from "./message-time";

/** A phone's conversation info sheet: members, tasks and artifacts in one list. */
export function PhoneConversationInfo(props: {
  id: string;
  name: string;
  project?: string;
  members: MemberView[];
  onClose: () => void;
  onInspect: (value: { id: string; session: string }) => void;
  onTask: (id: string) => void;
  onArtifact: (artifact: ArtifactView) => void;
}) {
  const host = useHost();
  const c = colors();
  const tasks = () =>
    host
      .tasks()
      .filter((task) => task.conversationId === props.id && !task.archivedAt)
      .sort((a, b) => a.number - b.number);
  const artifacts = () =>
    host.artifacts().filter((artifact) => artifact.conversationId === props.id);
  return (
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
          <Label size={14} line={18} weight={600} lines={1}>
            {props.name}
          </Label>
          <If when={props.project}>
            <Label size={10} line={12} tone="muted" lines={1}>
              {props.project}
            </Label>
          </If>
        </View>
        <CloseButton size={32} iconSize={16} onPress={props.onClose} />
      </View>
      <Scroll style={grow} scrollbar={false}>
        <Section label={uiText("members")} count={props.members.length} first />
        <Each of={props.members} key={(member) => member.agentId}>
          {(member) => (
            <InfoRow
              height={52}
              title={host.agent(member().agentId)?.name ?? uiText("agent")}
              titleSize={14}
              detail={memberStatus(member().status)}
              onPress={
                member().sessionId
                  ? () =>
                      props.onInspect({
                        id: member().agentId,
                        session: member().sessionId!,
                      })
                  : undefined
              }
            >
              <AgentFace id={member().agentId} size={24} />
            </InfoRow>
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
        <Section label={uiText("chatArtifacts")} count={artifacts().length} />
        <Each of={artifacts()} key={(artifact) => artifact.id}>
          {(artifact) => (
            <InfoRow
              height={52}
              title={artifact().title}
              detail={[
                host.agent(artifact().publisherAgentId ?? "")?.name,
                artifact().versions[0] && `v${artifact().versions[0]!.number}`,
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
            titleLine={20}
            description={uiText("artifactsEmptyHelp")}
            descriptionSize={10}
            descriptionLine={16}
            style={{ flex: 0, paddingVertical: 32 }}
          />
        </If>
      </Scroll>
    </View>
  );

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
        <Label size={10} line={12} tone="muted">
          {section.count}
        </Label>
        {section.children}
      </View>
    );
  }
}

function InfoRow(props: {
  height: number;
  title: string;
  titleSize?: number;
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
        <Label size={props.titleSize ?? 13} line={18} lines={1}>
          {props.title}
        </Label>
        <If when={props.detail}>
          <Label size={11} line={14} tone="muted" lines={1}>
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
