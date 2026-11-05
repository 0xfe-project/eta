import type { ConversationResults } from "@eta/client-contracts";
import { signal, Text, View } from "nsh";
import { agents } from "../../app/lists";
import { t } from "../../i18n";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { reason } from "../../ui/format";
import { Icon } from "../../ui/Icon";
import { Body, Page } from "../../ui/Page";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { enterChat } from "./enter";
import { Caption, Cta, Title, TopBar } from "./fields";
import {
  choosableProjects,
  folderName,
  placeLine,
  useProjectChoice,
} from "./project";

function ProjectRow(props: {
  name: string;
  place: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <View
      role="button"
      accessibilityLabel={props.name}
      onPress={props.onPress}
      class={`h-[60px] shrink-0 flex-row items-center gap-3 border-t border-border px-4 ${props.selected ? "bg-muted" : "active:bg-muted"}`}
    >
      <View class="min-w-0 grow basis-0">
        <Text class="truncate text-lead leading-[22px] text-foreground">
          {props.name}
        </Text>
        <Text class="truncate text-sm leading-4 text-muted-foreground">
          {props.place}
        </Text>
      </View>
      <If when={props.selected}>
        <Icon name="check" size={18} />
      </If>
    </View>
  );
}

/** 07: a project and an agent. What it makes is a conversation with the agent in that project. */
export function NewConversationScreen(_props: {}) {
  const projects = useProjectChoice();
  const agentId = signal<string | undefined>(undefined);
  const sending = signal(false);
  const chosen = () => agentId() ?? agents()[0]?.id;

  const start = async () => {
    const agent = chosen();
    if (agent === undefined || sending()) return;
    sending.set(true);
    try {
      const target = await projects.resolve(agent);
      const { conversation } = await call<ConversationResults["create"]>(
        "conversations",
        "create",
        { projectId: target.id, agentIds: [agent] },
      );
      enterChat(conversation.id);
    } catch (error) {
      toast(t("common.failed", { message: reason(error) }));
    } finally {
      sending.set(false);
    }
  };

  return (
    <Page>
      <TopBar />
      <Body>
        <Title
          title={t("create.conversation.title")}
          hint={t("create.conversation.hint")}
        />
        <Caption title={t("create.project")} height={30} />
        <If when={projects.adding() && projects.choice().path.trim() !== ""}>
          <ProjectRow
            selected
            name={folderName(projects.choice().path.trim())}
            place={placeLine(projects.chosenPlace())}
            onPress={projects.browse}
          />
        </If>
        <Each of={choosableProjects()} key={(project) => project.id}>
          {(project) => (
            <ProjectRow
              name={project().name}
              place={placeLine(project())}
              selected={projects.project()?.id === project().id}
              onPress={() =>
                projects.choice.set({
                  ...projects.choice(),
                  projectId: project().id,
                })
              }
            />
          )}
        </Each>
        <View
          role="button"
          accessibilityLabel={t("create.addPath")}
          onPress={projects.browse}
          class="h-[52px] shrink-0 flex-row items-center justify-between border-y border-border px-4 active:bg-muted"
        >
          <Text class="text-base leading-[18px] text-foreground">
            {t("create.addPath")}
          </Text>
          <Icon name="caretRight" size={14} color="faint" />
        </View>
        <Caption title={t("create.agents")} height={42} />
        <View class="border-b border-border">
          <Each of={agents()} key={(agent) => agent.id}>
            {(agent) => (
              <View
                role="button"
                accessibilityLabel={agent().name}
                onPress={() => agentId.set(agent().id)}
                class={`h-[52px] shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 ${chosen() === agent().id ? "bg-muted" : "active:bg-muted"}`}
              >
                <AgentAvatar id={agent().id} size={20} />
                <Text class="min-w-0 grow basis-0 truncate text-lead leading-[18px] text-foreground">
                  {agent().name}
                </Text>
                <If when={chosen() === agent().id}>
                  <Icon name="check" size={18} />
                </If>
              </View>
            )}
          </Each>
        </View>
      </Body>
      <Cta
        title={t("create.conversation.start")}
        testID="start"
        disabled={sending() || chosen() === undefined || projects.missing()}
        onPress={() => void start()}
      />
    </Page>
  );
}
