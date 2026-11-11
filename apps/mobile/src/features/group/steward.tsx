// 03l Choose steward. The effective steward is the conversation's own pick, else its project's, so there are
// two levels, as on the web: this conversation (an agent, follow the project, or none at all) and
// the project.

import type { ConversationInfo, ProjectView } from "@eta/client-contracts";
import { Scroll, signal, Text, View } from "nsh";
import { agents } from "../../app/lists";
import { t } from "../../i18n";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { call } from "../../wire/target";
import { act, agentName, RowCaret, SheetRow, SheetTitle } from "./shared";

const Check = () => <Icon name="check" size={16} />;
const NoAvatar = () => <View class="size-5 shrink-0" />;

function ProjectLevel(props: { project: ProjectView; onDone: () => void }) {
  const pick = (agentId: string | null) =>
    act(
      call("projects", "setSteward", { projectId: props.project.id, agentId }),
      props.onDone,
    );
  return (
    <>
      <SheetTitle
        title={t("group.steward.projectRow", { name: props.project.name })}
        body={t("group.steward.projectHint")}
      />
      <Scroll style={{ maxHeight: 416 }}>
        <Each of={agents()} key={(agent) => agent.id}>
          {(agent) => (
            <SheetRow
              title={agent().name}
              testID={`project-steward-${agent().id}`}
              leading={<AgentAvatar id={agent().id} size={20} />}
              trailing={
                props.project.stewardId === agent().id ? <Check /> : undefined
              }
              onPress={() => pick(agent().id)}
            />
          )}
        </Each>
        <SheetRow
          title={t("group.steward.none")}
          testID="project-steward-none"
          leading={<NoAvatar />}
          trailing={props.project.stewardId === null ? <Check /> : undefined}
          onPress={() => pick(null)}
        />
      </Scroll>
    </>
  );
}

function ConversationLevel(props: {
  id: string;
  info: ConversationInfo | undefined;
  project: ProjectView | undefined;
  onProject: () => void;
  onDone: () => void;
}) {
  const override = () => props.info?.stewardOverrideId ?? null;
  const pick = (agentId: string | null, none = false) =>
    act(
      call("conversations", "setSteward", {
        conversationId: props.id,
        agentId,
        none,
      }),
      props.onDone,
    );
  const projectSteward = () => {
    const steward = props.project?.stewardId ?? null;
    return steward === null ? t("group.steward.none") : agentName(steward);
  };
  const noSteward = () => props.info?.noSteward === true;
  return (
    <>
      <SheetTitle
        title={t("group.steward.title")}
        body={t("group.steward.hint")}
      />
      <Scroll style={{ maxHeight: 416 }}>
        <SheetRow
          title={t("group.steward.follow")}
          testID="steward-follow"
          subtitle={
            props.project === undefined
              ? undefined
              : t("group.steward.followHint", {
                  name: props.project.name,
                  steward: projectSteward(),
                })
          }
          leading={<NoAvatar />}
          trailing={override() === null ? <Check /> : undefined}
          onPress={() => pick(null)}
        />
        <Each of={agents()} key={(agent) => agent.id}>
          {(agent) => (
            <SheetRow
              title={agent().name}
              testID={`steward-${agent().id}`}
              leading={<AgentAvatar id={agent().id} size={20} />}
              trailing={override() === agent().id ? <Check /> : undefined}
              onPress={() => pick(agent().id)}
            />
          )}
        </Each>
        <SheetRow
          title={t("group.steward.none")}
          testID="steward-none"
          leading={<NoAvatar />}
          trailing={noSteward() ? <Check /> : undefined}
          onPress={() => pick(null, true)}
        />
        <If when={props.project}>
          {(project) => (
            <SheetRow
              thick
              title={t("group.steward.projectRow", { name: project().name })}
              testID="steward-project"
              trailing={
                <>
                  <AgentName name={projectSteward()} />
                  <RowCaret />
                </>
              }
              onPress={props.onProject}
            />
          )}
        </If>
      </Scroll>
    </>
  );
}

function AgentName(props: { name: string }) {
  return (
    <Text class="text-md leading-4 text-muted-foreground">{props.name}</Text>
  );
}

export function StewardSheet(props: {
  open: boolean;
  id: string;
  info: ConversationInfo | undefined;
  project: ProjectView | undefined;
  onClose: () => void;
}) {
  const level = signal<"conversation" | "project">("conversation");
  const close = () => {
    level.set("conversation");
    props.onClose();
  };
  return (
    <Sheet open={props.open} onClose={close}>
      <If
        when={level() === "project" && props.project}
        else={
          <ConversationLevel
            id={props.id}
            info={props.info}
            project={props.project}
            onProject={() => level.set("project")}
            onDone={close}
          />
        }
      >
        {(project) => (
          <ProjectLevel project={project() as ProjectView} onDone={close} />
        )}
      </If>
    </Sheet>
  );
}
