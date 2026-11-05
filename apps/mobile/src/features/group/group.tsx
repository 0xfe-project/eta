// 03j 群信息: what the group is working on, who is in it, and the group's own actions. The order is
// the web's context panel: what the group made first, the background after.

import type {
  ArtifactView,
  BoardTaskView,
  ConversationInfo,
  MemberView,
  RoutineSummary,
  TimelineSection,
} from "@eta/client-contracts";
import type { JSX } from "nsh";
import type { IconName } from "../../ui/icons";
import { computed, Scroll, signal, Text, View } from "nsh";
import { agents, boardTasks, conversations, machineById, projectById } from "../../app/lists";
import { t } from "../../i18n";
import { go } from "../../nav/links";
import { open } from "../../nav/stack";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Empty } from "../../ui/States";
import { Icon } from "../../ui/Icon";
import { Body, Header, Page } from "../../ui/Page";
import { Sheet } from "../../ui/Sheet";
import { moment } from "../../ui/format";
import { toast } from "../../ui/toast";
import { call, eager, useTarget } from "../../wire/target";
import { EditGroupScreen } from "./edit";
import { MemberSheet } from "./member";
import { act, agentName, Caption, modelName, RowCaret, SheetRow, SheetTitle, statusLabel, tokens, useSession } from "./shared";
import { StewardSheet } from "./steward";

const CLOSED = new Set(["done", "cancelled"]);
const SHOWN_TASKS = 5;

const TASK_ICONS: Record<BoardTaskView["status"], IconName> = {
  backlog: "circleDashed",
  todo: "circle",
  in_progress: "circleHalf",
  in_review: "eye",
  done: "check",
  blocked: "prohibit",
  cancelled: "x",
};

function TaskIcon(props: { status: BoardTaskView["status"] }) {
  return (
    <Icon
      name={TASK_ICONS[props.status]}
      size={18}
      color={props.status === "blocked" ? "state-error" : "muted-foreground"}
    />
  );
}

function FactRow(props: { label: string; value: string; onPress?: () => void }) {
  return (
    <View
      role={props.onPress ? "button" : undefined}
      accessibilityLabel={props.onPress ? props.label : undefined}
      onPress={props.onPress}
      class={`h-11 shrink-0 flex-row items-center gap-3 border-b border-border px-4 ${props.onPress ? "active:bg-muted" : ""}`}
    >
      <Text class="w-12 shrink-0 text-sm leading-4 text-muted-foreground">{props.label}</Text>
      <Text class="truncate grow basis-0 text-base leading-[18px] text-foreground">{props.value}</Text>
      <If when={props.onPress !== undefined}>
        <RowCaret />
      </If>
    </View>
  );
}

function LinkRow(props: { icon: JSX.Element; title: string; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      class="h-12 shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted"
    >
      {props.icon}
      <Text class="truncate grow basis-0 text-base leading-[18px] text-foreground">{props.title}</Text>
      <RowCaret />
    </View>
  );
}

function Quiet(props: { text: string }) {
  return (
    <View class="border-t border-border px-4 py-3">
      <Text class="text-sm leading-[18px] text-muted-foreground">{props.text}</Text>
    </View>
  );
}

function MemberRow(props: {
  member: MemberView;
  steward: boolean;
  onPress: () => void;
}) {
  const session = useSession(() => props.member.sessionId);
  const status = () =>
    props.steward
      ? `${t("group.steward")} · ${statusLabel(props.member.status)}`
      : statusLabel(props.member.status);
  const facts = () => {
    if (props.member.sessionId === null) return t("group.member.noSession");
    const view = session();
    const model = view?.model?.id;
    return `${model === undefined ? "—" : modelName(model)} · in ${tokens(view?.usage?.input)} · out ${tokens(view?.usage?.output)}`;
  };
  return (
    <View
      role="button"
      accessibilityLabel={agentName(props.member.agentId)}
      testID={`member-${props.member.agentId}`}
      onPress={props.onPress}
      class="h-[60px] shrink-0 flex-row items-center gap-3 border-t border-border px-4 active:bg-muted"
    >
      <AgentAvatar id={props.member.agentId} size={32} />
      <View class="min-w-0 grow basis-0">
        <Text class="truncate text-base leading-[20px] text-foreground">
          {agentName(props.member.agentId)} <Text class="text-sm text-muted-foreground">{status()}</Text>
        </Text>
        <Text class="truncate text-sm leading-4 text-muted-foreground">{facts()}</Text>
      </View>
      <RowCaret />
    </View>
  );
}

/** 邀请: every agent not in the group yet. */
function InviteSheet(props: { open: boolean; id: string; members: MemberView[]; onClose: () => void }) {
  const others = () => agents().filter((agent) => !props.members.some((m) => m.agentId === agent.id));
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <SheetTitle title={t("group.invite.title")} body={t("group.invite.body")} />
      <If when={others().length === 0}>
        <Quiet text={t("group.invite.empty")} />
      </If>
      <Each of={others()} key={(agent) => agent.id}>
        {(agent) => (
          <SheetRow
            title={agent().name}
            testID={`invite-${agent().id}`}
            leading={<AgentAvatar id={agent().id} size={20} />}
            onPress={() =>
              act(
                call("conversations", "invite", { conversationId: props.id, agentId: agent().id }),
                props.onClose,
              )
            }
          />
        )}
      </Each>
    </Sheet>
  );
}

/** 相关任务: link a board task to this group, or take one off it. */
function RelatedSheet(props: { open: boolean; id: string; archived: boolean; onClose: () => void }) {
  const linked = () => boardTasks().filter((task) => task.conversationId === props.id);
  const others = () => boardTasks().filter((task) => task.conversationId !== props.id);
  const link = (taskId: string, conversationId: string | null) =>
    act(call("tasks", "link", { taskId, conversationId }));
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <SheetTitle title={t("group.menu.related")} body={t("group.related.help")} />
      <Scroll style={{ maxHeight: 416 }}>
        <Each of={linked()} key={(task) => task.id}>
          {(task) => (
            <SheetRow
              title={`#${task().number} ${task().title}`}
              testID={`related-${task().number}`}
              leading={<TaskIcon status={task().status} />}
              trailing={<Text class="text-md leading-4 text-muted-foreground">{t("group.related.unlink")}</Text>}
              onPress={() => link(task().id, null)}
            />
          )}
        </Each>
        <If when={!props.archived}>
          <Each of={others()} key={(task) => task.id}>
            {(task) => (
              <SheetRow
                title={`#${task().number} ${task().title}`}
                testID={`related-${task().number}`}
                leading={<Icon name="plus" size={18} color="muted-foreground" />}
                onPress={() => link(task().id, props.id)}
              />
            )}
          </Each>
        </If>
      </Scroll>
    </Sheet>
  );
}

function MenuItem(props: { title: string; first?: boolean; onPress: () => void }) {
  return (
    <View
      role="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      class={`h-11 shrink-0 flex-row items-center px-3 active:bg-muted ${props.first ? "" : "border-t border-border"}`}
    >
      <Text class="text-base leading-[18px] text-foreground">{props.title}</Text>
    </View>
  );
}

export function GroupInfoScreen(props: { id: string }) {
  const target = useTarget(`conversations.${props.id}`);
  const artifactList = useTarget("artifacts");
  const group = () => conversations().find((conversation) => conversation.id === props.id);
  const info = () => target.section<ConversationInfo>("info");
  const isGroup = () => group()?.kind !== "direct";
  const archived = () => group()?.archived ?? false;
  const project = () => projectById(group()?.projectId);
  const projectLine = () => {
    const place = project();
    if (place === undefined) return "—";
    const machine = machineById(place.machineId);
    return machine === undefined ? place.name : `${place.name} · ${machine.name}`;
  };

  const groupTasks = () => boardTasks().filter((task) => task.conversationId === props.id);
  const openTasks = computed(() =>
    groupTasks()
      .filter((task) => !CLOSED.has(task.status))
      .sort((a, b) => b.updatedAt - a.updatedAt),
  );
  const artifacts = () =>
    (artifactList.section<ArtifactView[]>("list") ?? []).filter(
      (artifact) => artifact.conversationId === props.id,
    );
  const routines = () =>
    (eager<RoutineSummary[]>("routines", "list") ?? []).filter(
      (routine) => routine.conversationId === props.id,
    );
  const members = () => group()?.participants ?? [];

  const menu = signal(false);
  const inviting = signal(false);
  const relating = signal(false);
  const choosingSteward = signal(false);
  const memberOpen = signal<string | undefined>(undefined);

  const choose = (action: () => void) => {
    menu.set(false);
    action();
  };
  const toggleArchive = () => {
    const next = !archived();
    act(call("conversations", "update", { conversationId: props.id, archived: next }), () => {
      if (next) toast(t("group.archived"));
    });
  };
  const edit = () =>
    open(`group-edit:${props.id}`, () => <EditGroupScreen id={props.id} />);

  return (
    <Page>
      <View class="relative flex-1">
        <Header
          title={group()?.name ?? ""}
          right={
            <If when={group() !== undefined}>
              <View
                role="button"
                accessibilityLabel={t("group.more")}
                testID="group-more"
                onPress={() => menu.set(!menu())}
                class="-mr-2 h-11 w-10 items-center justify-center active:opacity-60"
              >
                <Icon name="dotsThree" size={20} />
              </View>
            </If>
          }
        />
        <If when={group() !== undefined} else={<Empty title={t("group.gone")} />}>
          <Body>
            <View class="shrink-0">
              <FactRow label={t("group.project")} value={projectLine()} />
              <If when={isGroup()}>
                <FactRow
                  label={t("group.steward")}
                  value={group()?.stewardId ? agentName(group()?.stewardId) : t("group.steward.none")}
                  onPress={() => choosingSteward.set(true)}
                />
              </If>
            </View>

            <View class="shrink-0">
              <Caption title={t("group.tasks", { count: openTasks().length })} />
              <If
                when={openTasks().length > 0}
                else={<Quiet text={t(groupTasks().length === 0 ? "group.tasks.empty" : "group.tasks.noOpen")} />}
              >
                <View class="border-b border-border">
                  <Each of={openTasks().slice(0, SHOWN_TASKS)} key={(task) => task.id}>
                    {(task) => (
                      <LinkRow
                        icon={<TaskIcon status={task().status} />}
                        title={`#${task().number} ${task().title}`}
                        onPress={() => go.task(task().id)}
                      />
                    )}
                  </Each>
                </View>
              </If>
            </View>

            <View class="shrink-0">
              <Caption title={t("group.artifacts", { count: artifacts().length })} />
              <If when={artifacts().length > 0} else={<Quiet text={t("group.artifacts.empty")} />}>
                <View class="border-b border-border">
                  <Each of={artifacts()} key={(artifact) => artifact.id}>
                    {(artifact) => (
                      <LinkRow
                        icon={<Icon name="appWindow" size={18} color="muted-foreground" />}
                        title={t("group.artifacts.row", {
                          title: artifact().title,
                          version: artifact().versions[0]?.number ?? 0,
                        })}
                        onPress={() => go.artifact(artifact().id)}
                      />
                    )}
                  </Each>
                </View>
              </If>
            </View>

            <If when={routines().length > 0}>
              <View class="shrink-0">
                <Caption title={t("group.routines", { count: routines().length })} />
                <View class="border-b border-border">
                  <Each of={routines()} key={(routine) => routine.id}>
                    {(routine) => (
                      <View class="h-12 shrink-0 flex-row items-center gap-[10px] border-t border-border px-4">
                        <Text class="truncate grow basis-0 text-base leading-[18px] text-foreground">
                          {routine().name}
                        </Text>
                        <Text class="shrink-0 text-sm leading-4 text-muted-foreground">
                          {routine().nextRunAt === null ? "—" : moment(routine().nextRunAt as number)}
                        </Text>
                      </View>
                    )}
                  </Each>
                </View>
              </View>
            </If>

            <View class="shrink-0">
              <Caption
                title={t("group.members", { count: members().length })}
                right={
                  <If when={isGroup() && !archived()}>
                    <Text
                      role="button"
                      accessibilityLabel={t("group.invite")}
                      hitSlop={12}
                      onPress={() => inviting.set(true)}
                      class="text-md leading-[18px] text-foreground active:opacity-60"
                    >
                      {t("group.invite")}
                    </Text>
                  </If>
                }
              />
              <View class="border-b border-border">
                <Each of={members()} key={(member) => member.agentId}>
                  {(member) => (
                    <MemberRow
                      member={member()}
                      steward={group()?.stewardId === member().agentId}
                      onPress={() => memberOpen.set(member().agentId)}
                    />
                  )}
                </Each>
              </View>
            </View>

            <If when={(info()?.goal ?? "") !== ""}>
              <View class="shrink-0 gap-1 p-4">
                <Text class="text-sm leading-[18px] text-muted-foreground">{t("group.goal")}</Text>
                <Text class="text-base leading-[23px] text-foreground">{info()?.goal}</Text>
              </View>
            </If>
          </Body>
        </If>

        <If when={menu()}>
          <View
            class="absolute top-0 right-0 bottom-0 left-0"
            onPress={() => menu.set(false)}
          >
            <View
              class="absolute top-[44px] right-2 w-[172px] border border-border-strong bg-background"
            >
              <MenuItem first title={t("group.menu.edit")} onPress={() => choose(edit)} />
              <MenuItem title={t("group.menu.related")} onPress={() => choose(() => relating.set(true))} />
              <MenuItem
                title={t(archived() ? "group.menu.unarchive" : "group.menu.archive")}
                onPress={() => choose(toggleArchive)}
              />
            </View>
          </View>
        </If>
      </View>

      <InviteSheet open={inviting()} id={props.id} members={members()} onClose={() => inviting.set(false)} />
      <RelatedSheet open={relating()} id={props.id} archived={archived()} onClose={() => relating.set(false)} />
      <StewardSheet
        open={choosingSteward()}
        id={props.id}
        info={info()}
        project={project()}
        onClose={() => choosingSteward.set(false)}
      />
      <MemberSheet
        conversationId={props.id}
        agentId={memberOpen()}
        steward={group()?.stewardId === memberOpen()}
        removable={isGroup() && members().length > 1}
        member={members().find((member) => member.agentId === memberOpen())}
        messages={target.section<TimelineSection>("timeline")?.messages ?? []}
        onClose={() => memberOpen.set(undefined)}
      />
    </Page>
  );
}
