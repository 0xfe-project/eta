import type { ConversationArgs, ConversationResults } from "@eta/client-contracts";
import type { SelectOption } from "../../ui/SelectSheet";
import { signal, Text, View } from "nsh";
import { agents, machineById } from "../../app/lists";
import { t } from "../../i18n";
import { AgentAvatar } from "../../ui/AgentAvatar";
import { reason } from "../../ui/format";
import { Body, Page } from "../../ui/Page";
import { SelectSheet } from "../../ui/SelectSheet";
import { toast } from "../../ui/toast";
import { call } from "../../wire/target";
import { enterChat } from "./enter";
import { Caption, CheckBox, ChoiceField, Cta, TextField, Title, TopBar } from "./fields";
import { choosableProjects, folderName, useProjectChoice } from "./project";

const ADD = "__add__";

/** 07b. A name left empty goes as empty: the host names the group after its project. */
export function NewGroupScreen(_props: {}) {
  const projects = useProjectChoice();
  const name = signal("");
  const goal = signal("");
  const chosen = signal<string[]>([]);
  const picking = signal(false);
  const sending = signal(false);

  const toggle = (id: string) =>
    chosen.set(
      chosen().includes(id) ? chosen().filter((each) => each !== id) : [...chosen(), id],
    );

  const projectLabel = () => {
    const project = projects.project();
    if (project !== undefined)
      return `${project.name} · ${machineById(project.machineId)?.name ?? ""}`;
    const place = projects.chosenPlace();
    if (place.path === "") return t("create.addPath");
    return `${folderName(place.path)} · ${machineById(place.machineId)?.name ?? ""}`;
  };

  const options = (): SelectOption<string>[] => [
    ...choosableProjects().map((project) => ({
      value: project.id,
      label: project.name,
      aside: machineById(project.machineId)?.name ?? "",
    })),
    { value: ADD, label: t("create.addPath") },
  ];

  const create = async () => {
    if (sending()) return;
    sending.set(true);
    try {
      const target = await projects.resolve(chosen()[0] ?? null);
      const { conversation } = await call<ConversationResults["create"]>(
        "conversations",
        "create",
        { projectId: target.id, name: name().trim(), agentIds: chosen() },
      );
      if (goal().trim() !== "") {
        // The group exists by now: a goal that did not stick is no reason to make it twice.
        await call("conversations", "update", {
          conversationId: conversation.id,
          goal: goal(),
        } satisfies ConversationArgs["update"]).catch((error: unknown) =>
          toast(t("common.failed", { message: reason(error) })),
        );
      }
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
        <Title title={t("create.group.title")} hint={t("create.group.hint")} />
        <TextField
          testID="group-name"
          label={t("create.group.name")}
          value={name()}
          onChange={(value) => name.set(value)}
          placeholder={t("create.group.namePlaceholder")}
          maxLength={100}
        />
        <ChoiceField
          testID="group-project"
          label={t("create.project")}
          value={projectLabel()}
          onPress={() => picking.set(true)}
        />
        <TextField
          testID="group-goal"
          label={t("create.group.goal")}
          value={goal()}
          onChange={(value) => goal.set(value)}
          maxLength={10_000}
          multiline
          height={112}
        />
        <View class="border-t border-border">
          <Caption title={t("create.group.members")} height={34} />
        </View>
        <View class="border-b border-border">
          <Each of={agents()} key={(agent) => agent.id}>
            {(agent) => (
              <View
                role="checkbox"
                accessibilityLabel={agent().name}
                onPress={() => toggle(agent().id)}
                class="h-[52px] shrink-0 flex-row items-center gap-[10px] border-t border-border px-4 active:bg-muted"
              >
                <CheckBox checked={chosen().includes(agent().id)} size={18} />
                <AgentAvatar id={agent().id} size={20} />
                <Text class="min-w-0 grow basis-0 truncate text-lead leading-[18px] text-foreground">
                  {agent().name}
                </Text>
              </View>
            )}
          </Each>
        </View>
      </Body>
      <Cta
        title={t("create.group.create")}
        testID="create-group"
        disabled={sending() || chosen().length === 0 || projects.missing()}
        onPress={() => void create()}
      />
      <SelectSheet
        open={picking()}
        title={t("create.project")}
        value={projects.project()?.id}
        options={options()}
        onChange={(value) => {
          if (value === ADD) projects.browse();
          else projects.choice.set({ ...projects.choice(), projectId: value });
        }}
        onClose={() => picking.set(false)}
      />
    </Page>
  );
}
