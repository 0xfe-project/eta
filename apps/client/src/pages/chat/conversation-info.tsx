import type { ArtifactView, MemberView } from "@eta/client-contracts";
import type { JSX, Signal } from "nsh";
import type { TextVariant } from "../../components";
import type { ArtifactFilters } from "./artifacts/filter";
import { signal, View } from "nsh";
import {
  Caption,
  colors,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../components";
import { AgentFace } from "../../components/agent-face";
import { ContextRing, useContextUsage } from "../../components/context-ring";
import { EmptyState } from "../../components/empty-state";
import { BackButton, CloseButton } from "../../components/navigation-buttons";
import { StatusDot } from "../../components/status-dot";
import {
  avatar,
  control,
  icon,
  opacity,
  space,
  weight,
} from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { useLoadState } from "../../services/load-status";
import { statusName, TaskGlyph } from "../tasks/status";
import { ArtifactBrowser } from "./artifacts/conversation-artifacts";
import { RECENT, recentArtifacts } from "./artifacts/filter";
import { memberStatus } from "./member-status";
import { messageTime } from "./message-time";
import { SubtaskProgress, SubtaskToggle } from "./panel-tasks";
import { needingYou, setParentOpen, taskRoots, treeRows } from "./panel-tree";
import { ViewAll } from "./section-heading";

/**
 * A phone's conversation info sheet: members, tasks and the latest artifacts in one list; "View
 * all" turns the sheet into the group's whole Artifacts list (search, filter, pages).
 */
/** A task's row, and a row with a second line (an artifact, a member). */
const rowHeight = { task: 48, twoLine: 52 } as const;
/** An empty section's line, in from the edge as the rows are. */
const infoEmpty = { paddingHorizontal: space[16] };

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
  const tasksLoad = useLoadState({ targets: () => ["tasks"] });
  const artifactsLoad = useLoadState({ targets: () => ["artifacts"] });
  const c = colors();
  const allArtifacts = signal(false);
  const tasks = () =>
    host
      .tasks()
      .filter((task) => task.conversationId === props.id && !task.archivedAt);
  // Parents folded over their subtasks, as the Context tab lists them.
  const tree = () => {
    const { roots, revealed } = taskRoots(tasks(), host.tasks());
    return {
      count: roots.length,
      rows: treeRows(
        roots.sort((a, b) => a.number - b.number),
        revealed,
        host.tasks(),
      ),
    };
  };
  const artifacts = () =>
    host.artifacts().filter((artifact) => artifact.conversationId === props.id);
  return (
    <If when={!allArtifacts()} else={<AllArtifacts />}>
      <View style={grow}>
        <View
          style={{
            ...row,
            height: control.touch,
            paddingLeft: space[16],
            paddingRight: space[8],
            flexShrink: 0,
          }}
        >
          <View style={{ flex: 1, minWidth: 0 }}>
            <Label weight={weight.strong} lines={1}>
              {props.name}
            </Label>
            <If when={props.project}>
              <Label variant="caption" tone="muted" lines={1}>
                {props.project}
              </Label>
            </If>
          </View>
          <CloseButton
            size={control.lg}
            iconSize={icon.md}
            onPress={props.onClose}
          />
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
          <If when={!props.members.length}>
            <EmptyState
              size="row"
              status="empty"
              loading={null}
              error={null}
              empty={{ title: uiText("noMembersYet") }}
              style={infoEmpty}
            />
          </If>
          <Section label={uiText("tasks2")} count={tree().count} />
          <If when={!tree().rows.length}>
            <EmptyState
              size="row"
              status={tasksLoad.shown()}
              loading={uiText("loadingTasks")}
              error={{
                title: uiText("tasksDidNotLoad"),
                retry: tasksLoad.retry,
                retrying: tasksLoad.retrying(),
              }}
              empty={{ title: uiText("noTasksYet") }}
              style={infoEmpty}
            />
          </If>
          <Each of={tree().rows} key={(entry) => entry.task.id}>
            {(entry) => (
              <InfoRow
                height={rowHeight.task}
                // Under the parent's title: its mark and the row's gap, a step per level.
                indent={entry().depth * (icon.md + space[12])}
                title={`#${entry().task.number} ${entry().task.title}`}
                detail={
                  entry().depth ? statusName(entry().task.status) : undefined
                }
                onPress={() => props.onTask(entry().task.id)}
                trailing={
                  entry().parent ? (
                    <>
                      <If
                        when={
                          !entry().open &&
                          needingYou(entry().task, host.tasks())
                        }
                      >
                        <StatusDot color={c().warning} />
                      </If>
                      <SubtaskProgress task={entry().task} />
                      <SubtaskToggle
                        task={entry().task}
                        open={entry().open}
                        size={control.touch}
                        onToggle={() =>
                          setParentOpen(entry().task.id, !entry().open)
                        }
                      />
                    </>
                  ) : undefined
                }
              >
                <TaskGlyph status={entry().task.status} size={icon.md} />
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
                height={rowHeight.twoLine}
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
                <Icon name="artifact" size={icon.md} />
              </InfoRow>
            )}
          </Each>
          <If when={!artifacts().length}>
            <EmptyState
              size="card"
              status={artifactsLoad.shown()}
              loading={uiText("artifactsLoading")}
              error={{
                title: uiText("artifactLoadError"),
                retry: artifactsLoad.retry,
                retrying: artifactsLoad.retrying(),
              }}
              empty={{
                art: "artifacts",
                title: uiText("noArtifactsYet"),
                description: uiText("artifactsEmptyHelp"),
              }}
              style={{ paddingHorizontal: space[16] }}
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
            height: control.touch,
            gap: space[4],
            paddingLeft: space[4],
            paddingRight: space[8],
            flexShrink: 0,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <BackButton
            size={control.lg}
            iconSize={icon.md}
            onPress={() => allArtifacts.set(false)}
          />
          <Label weight={weight.strong} lines={1}>
            {uiText("chatArtifacts")}
          </Label>
          <Label variant="small" tone="muted" style={{ flex: 1 }}>
            {artifacts().length}
          </Label>
          <CloseButton
            size={control.lg}
            iconSize={icon.md}
            onPress={props.onClose}
          />
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
          height: space[32],
          gap: space[4],
          paddingHorizontal: space[16],
          flexShrink: 0,
          backgroundColor: c().selected,
          borderTopWidth: section.first ? 1 : 0,
          borderBottomWidth: section.first ? 0 : 1,
          borderColor: c().border,
        }}
      >
        <Caption text={section.label} />
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
    return current
      ? `${status} · ${current.label === "N/A" ? current.detail : current.label}`
      : status;
  };
  return (
    <InfoRow
      height={rowHeight.twoLine}
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
              width: space[32],
              height: space[32],
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <AgentFace id={props.member.agentId} size={avatar.md} />
          </View>
        }
      >
        <ContextRing usage={usage} size={avatar.lg} label={false}>
          <AgentFace id={props.member.agentId} size={avatar.md} />
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
  /** How far in it starts, for a subtask under its parent. */
  indent?: number;
  /** In place of the chevron. */
  trailing?: JSX.Element | undefined;
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
        gap: space[12],
        paddingLeft: space[16] + (props.indent ?? 0),
        paddingRight: space[12],
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
      <If
        when={props.trailing}
        else={
          <View style={{ opacity: opacity.disabled }}>
            <Icon name="right" size={icon.md} />
          </View>
        }
      >
        <View style={{ ...row, gap: space[8], flexShrink: 0 }}>
          {props.trailing}
        </View>
      </If>
    </View>
  );
}
