import type {
  AgentFields,
  AgentResults,
  AgentRuntime,
  AgentRuntimeInfo,
  MachineView,
  ThinkingLevel,
} from "@eta/client-contracts";
import type { ScrollRef } from "nsh";
import type { SelectOption } from "../../ui/SelectSheet";
import type { Model } from "./models";
import { computed, effect, signal, Text, untracked, View } from "nsh";
import { agents, machines } from "../../app/lists";
import { t } from "../../i18n";
import { nav, open } from "../../nav/stack";
import { reason } from "../../ui/format";
import { Body, Page } from "../../ui/Page";
import { SelectSheet } from "../../ui/SelectSheet";
import { toast } from "../../ui/toast";
import { call, useTarget } from "../../wire/target";
import { enterChat } from "./enter";
import { ChoiceField, Cta, TextField, Title, TopBar } from "./fields";
import { runtimeModelsOf, useModels } from "./models";
import { primaryMachine } from "./project";
import { lastModel, loadRemembered, rememberModel } from "./remember";

interface PersonaCard {
  id: string;
  name: string;
  description: string;
  custom: boolean;
}

/** What the pickers offer; `xhigh` and `max` only some models accept. */
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly ThinkingLevel[];

const INSTRUCTIONS_MAX = 10_000;

/** A machine's external runtimes: undefined while it is asked, null when it could not be. */
type Answer = AgentRuntimeInfo[] | null | undefined;

/** The form, kept above its two pages. Nothing goes out until 创建. */
function useDraft() {
  const name = signal("");
  const machineId = signal("");
  const runtime = signal<AgentRuntime>("eta");
  const model = signal("");
  const thinking = signal("");
  const persona = signal("");
  const instructions = signal("");
  const answers = signal<Record<string, Answer>>({});
  const note = signal<string | undefined>(undefined);
  const nameError = signal<string | undefined>(undefined);
  const machineError = signal<string | undefined>(undefined);
  const modelError = signal<string | undefined>(undefined);
  const providerModels = useModels();

  /** What `agents.runtimes` is asked by: the primary is the question without a machine. */
  const keyOf = (id: string) => (id === "" ? (primaryMachine()?.id ?? "") : id);
  const ask = async (machine: MachineView) => {
    const primary = machine.kind === "primary";
    try {
      const { runtimes } = await call<AgentResults["runtimes"]>(
        "agents",
        "runtimes",
        primary ? {} : { machineId: machine.id },
      );
      answers.set({ ...untracked(() => answers()), [machine.id]: runtimes });
    } catch {
      answers.set({ ...untracked(() => answers()), [machine.id]: null });
    }
  };

  /** The machines a new agent can be pinned to. */
  const listed = () =>
    machines().filter(
      (machine) =>
        (machine.kind === "primary" || machine.kind === "daemon") &&
        machine.status !== "pending" &&
        machine.status !== "revoked",
    );
  for (const machine of untracked(listed)) {
    if (machine.status === "online") void ask(machine);
  }

  const runtimes = (): Answer => answers()[keyOf(machineId())];
  const external = () => runtime() !== "eta";
  const models = computed((): Model[] | null | undefined => {
    if (!external()) return providerModels();
    const known = runtimes();
    if (!known) return known;
    const info = known.find((entry) => entry.id === runtime());
    return info === undefined ? [] : runtimeModelsOf(info);
  });
  const usable = () => (models() ?? []).filter((item) => item.available);
  const machine = () => machines().find((item) => item.id === machineId());
  const machineName = () => machine()?.name ?? primaryMachine()?.name ?? "";

  // The last used model, else the default one, else the first. A runtime starts on its own.
  void loadRemembered();
  effect(() => {
    if (model() !== "" || external() || lastModel() === undefined) return;
    const preferred =
      usable().find((item) => item.id === lastModel()) ??
      usable().find((item) => item.default) ??
      usable()[0];
    if (preferred !== undefined) model.set(preferred.id);
  });

  // Nothing is saved on a runtime yet: a machine without it moves the draft to eta's own loop.
  effect(() => {
    if (!external()) return;
    const known = runtimes();
    if (known === undefined) return;
    const info = known?.find((item) => item.id === runtime());
    if (info?.status === "available") return;
    const next = t("create.agent.runtimeEta");
    note.set(
      known === null
        ? t("create.agent.runtimeUnknown", { machine: machineName(), next })
        : t("create.agent.runtimeMissing", {
            machine: machineName(),
            runtime: info?.label ?? runtime(),
            next,
          }),
    );
    runtime.set("eta");
    model.set("");
    modelError.set(undefined);
  });

  // The runtime is here but its model is not: the runtime's own default stands in.
  effect(() => {
    if (
      external() &&
      models() &&
      model() !== "" &&
      !usable().some((item) => item.id === model())
    )
      model.set("");
  });

  const checking = () => external() && runtimes() === undefined;

  const valid = (): boolean => {
    const trimmed = name().trim();
    nameError.set(trimmed === "" ? t("create.agent.nameRequired") : undefined);
    const gone = machine();
    machineError.set(
      gone !== undefined && gone.status !== "online"
        ? t("create.agent.wentOffline", { machine: gone.name })
        : undefined,
    );
    // Agents can be created before any account is connected, not after.
    const unchosen = !external() && model() === "" && usable().length > 0;
    modelError.set(unchosen ? t("create.agent.modelRequired") : undefined);
    return (
      trimmed !== "" && machineError() === undefined && !unchosen && !checking()
    );
  };

  const fields = (): AgentFields => ({
    name: name().trim(),
    instructions: instructions(),
    persona: persona(),
    runtime: runtime(),
    model: model() || null,
    thinkingLevel: (thinking() || null) as ThinkingLevel | null,
    machineId: machineId() || null,
    plugins: [],
  });

  return {
    name,
    machineId,
    runtime,
    model,
    thinking,
    persona,
    instructions,
    note,
    nameError,
    machineError,
    modelError,
    answers,
    keyOf,
    listed,
    runtimes,
    external,
    models,
    usable,
    checking,
    valid,
    fields,
  };
}

type Draft = ReturnType<typeof useDraft>;

function Steps(props: { step: 1 | 2 }) {
  const step = (at: 1 | 2) =>
    `text-md leading-[20px] ${props.step === at ? "text-foreground" : "text-faint"}`;
  return (
    <View class="flex-row items-center gap-3">
      <Text class={step(1)}>{t("create.agent.step1")}</Text>
      <Text class={step(2)}>{t("create.agent.step2")}</Text>
    </View>
  );
}

const SUFFIX = {
  unauthenticated: "create.agent.status.unauthenticated",
  missing: "create.agent.status.missing",
  error: "create.agent.status.error",
} as const;

type Picking = "machine" | "runtime" | "model" | "thinking";

/** 07c. */
export function NewAgentScreen(_props: {}) {
  const draft = useDraft();
  const picking = signal<Picking | undefined>(undefined);
  const sentinel = "__follow__";

  const running = (id: string) =>
    agents().filter(
      (agent) => agent.machineId === id && agent.status === "working",
    ).length;
  const machineState = (machine: MachineView) => {
    const status = t(
      machine.status === "online"
        ? "create.agent.online"
        : "create.agent.offline",
    );
    return machine.status === "online" && running(machine.id) > 0
      ? `${status} · ${t("create.agent.running", { count: running(machine.id) })}`
      : status;
  };
  const machineHint = (machine: MachineView) => {
    if (machine.status !== "online") return t("create.agent.offlineHint");
    const answer = draft.answers()[machine.id];
    if (answer === undefined) return t("create.agent.runtimeLoading");
    if (answer === null) return t("create.agent.runtimesUnknown");
    return [
      t("create.agent.runtimeEta"),
      ...answer
        .filter((each) => each.status === "available")
        .map((each) => each.label),
    ].join(" · ");
  };
  const machineLabel = (machine: MachineView) =>
    `${machine.name}${machine.kind === "primary" ? t("create.agent.primarySuffix") : ""}`;
  const chosenMachine = () =>
    draft.listed().find((each) => each.id === draft.machineId());

  const machineOptions = (): SelectOption<string>[] => [
    {
      value: sentinel,
      label: t("create.agent.followProject"),
      hint: t("create.agent.followHint"),
    },
    ...draft.listed().map((machine) => ({
      value: machine.id,
      label: machineLabel(machine),
      hint: machineHint(machine),
      aside: machineState(machine),
      disabled: machine.status !== "online",
    })),
  ];

  const runtimeOptions = (): SelectOption<string>[] => {
    const known = draft.runtimes();
    const options: SelectOption<string>[] = [
      { value: "eta", label: t("create.agent.runtimeEta") },
    ];
    if (known === undefined)
      options.push({
        value: "__loading__",
        label: t("create.agent.runtimeLoading"),
        disabled: true,
      });
    for (const runtime of known ?? []) {
      options.push({
        value: runtime.id,
        label:
          runtime.status === "available"
            ? runtime.label
            : `${runtime.label}${t(SUFFIX[runtime.status])}`,
        disabled: runtime.status !== "available",
      });
    }
    return options;
  };

  /** Under their provider, unusable ones listed but out of reach. */
  const modelOptions = (): SelectOption<string>[] => {
    const seen = new Set<string>();
    const options: SelectOption<string>[] = draft.external()
      ? [{ value: sentinel, label: t("create.agent.modelDefault") }]
      : [];
    for (const model of draft.models() ?? []) {
      const group = `${model.provider}\n${model.providerName}`;
      options.push({
        value: model.id,
        label: model.available
          ? model.name
          : `${model.name}${t("create.agent.unavailable")}`,
        disabled: !model.available && model.id !== draft.model(),
        ...(seen.has(group) ? {} : { group: model.providerName }),
      });
      seen.add(group);
    }
    return options;
  };

  const thinkingOptions = (): SelectOption<string>[] => [
    { value: sentinel, label: t("create.agent.thinkingDefault") },
    ...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
  ];

  const modelLabel = () => {
    const chosen = (draft.models() ?? []).find(
      (each) => each.id === draft.model(),
    );
    if (chosen !== undefined) return chosen.name;
    if (draft.model() !== "") return draft.model();
    if (draft.external()) return t("create.agent.modelDefault");
    return draft.models() === undefined
      ? t("create.agent.modelLoading")
      : t("create.agent.modelSelect");
  };

  const sheet = () => {
    switch (picking()) {
      case "machine":
        return {
          title: t("create.agent.machine"),
          options: machineOptions(),
          value: draft.machineId() || sentinel,
        };
      case "runtime":
        return {
          title: t("create.agent.runtime"),
          options: runtimeOptions(),
          value: draft.runtime() as string,
        };
      case "model":
        return {
          title: t("create.agent.model"),
          options: modelOptions(),
          value: draft.model() || sentinel,
        };
      case "thinking":
        return {
          title: t("create.agent.thinking"),
          options: thinkingOptions(),
          value: draft.thinking() || sentinel,
        };
      default:
        return { title: "", options: [], value: undefined };
    }
  };

  const choose = (value: string) => {
    const empty = value === sentinel ? "" : value;
    switch (untracked(() => picking())) {
      case "machine":
        draft.note.set(undefined);
        draft.machineError.set(undefined);
        draft.machineId.set(empty);
        break;
      case "runtime":
        draft.note.set(undefined);
        draft.runtime.set(value as AgentRuntime);
        // Another runtime has other models.
        draft.model.set("");
        draft.modelError.set(undefined);
        break;
      case "model":
        draft.model.set(empty);
        draft.modelError.set(undefined);
        break;
      case "thinking":
        draft.thinking.set(empty);
        break;
    }
  };

  return (
    <Page form>
      <TopBar />
      <Body>
        <Title title={t("create.agent.title")}>
          <Steps step={1} />
        </Title>
        <TextField
          testID="agent-name"
          label={t("create.agent.name")}
          value={draft.name()}
          onChange={(value) => {
            draft.name.set(value);
            draft.nameError.set(undefined);
          }}
          placeholder={t("create.agent.namePlaceholder")}
          maxLength={100}
          autoFocus
          error={draft.nameError()}
        />
        <If when={draft.listed().length > 1}>
          <ChoiceField
            testID="agent-machine"
            label={t("create.agent.machine")}
            value={
              chosenMachine() === undefined
                ? t("create.agent.followProject")
                : machineLabel(chosenMachine()!)
            }
            hint={
              chosenMachine() === undefined
                ? t("create.agent.followHint")
                : machineHint(chosenMachine()!)
            }
            error={draft.machineError()}
            onPress={() => picking.set("machine")}
          />
        </If>
        <ChoiceField
          testID="agent-runtime"
          label={t("create.agent.runtime")}
          value={
            draft.external()
              ? (draft.runtimes()?.find((each) => each.id === draft.runtime())
                  ?.label ?? draft.runtime())
              : t("create.agent.runtimeEta")
          }
          hint={
            draft.runtimes() === null
              ? t("create.agent.runtimeUnreachable")
              : undefined
          }
          note={draft.note()}
          onPress={() => picking.set("runtime")}
        />
        <ChoiceField
          testID="agent-model"
          label={t("create.agent.model")}
          value={modelLabel()}
          hint={
            !draft.external() &&
            draft.models()?.some((each) => each.available) === false
              ? t("create.agent.modelNone")
              : undefined
          }
          error={draft.modelError()}
          disabled={draft.models() === undefined}
          onPress={() => picking.set("model")}
        />
        <View class="border-b border-border">
          <ChoiceField
            testID="agent-thinking"
            label={t("create.agent.thinking")}
            value={draft.thinking() || t("create.agent.thinkingDefault")}
            onPress={() => picking.set("thinking")}
          />
        </View>
        <If when={draft.listed().length > 1 && draft.machineId() === ""}>
          <View class="px-4 py-3">
            <Text class="text-sm leading-[18px] text-muted-foreground">
              {t("create.agent.followNote")}
            </Text>
          </View>
        </If>
      </Body>
      <Cta
        title={t("create.agent.next")}
        testID="agent-next"
        disabled={draft.checking()}
        onPress={() => {
          if (draft.valid())
            open("new:agent:instructions", () => (
              <InstructionsStep draft={draft} />
            ));
        }}
      />
      <SelectSheet
        open={picking() !== undefined}
        title={sheet().title}
        options={sheet().options}
        value={sheet().value}
        onChange={choose}
        onClose={() => picking.set(undefined)}
      />
    </Page>
  );
}

/** 07d. A failure stays here with every field kept, to retry. */
function InstructionsStep(props: { draft: Draft }) {
  const draft = props.draft;
  const cards = useTarget("personas");
  const personas = () => cards.section<PersonaCard[]>("cards") ?? [];
  const picking = signal(false);
  const sending = signal(false);
  const failure = signal<string | undefined>(undefined);
  // The field fills the page when it takes the focus, so the host scrolls its caption out of sight
  // on the way to showing it; once the keyboard is up everything fits from the top.
  let body: ScrollRef | undefined;
  const showField = () => setTimeout(() => body?.scrollTo({ y: 0 }), 350);

  const create = async () => {
    if (sending()) return;
    // It may have gone back to a machine that went away, or the name may have been cleared.
    if (!draft.valid()) {
      nav.pop();
      return;
    }
    sending.set(true);
    failure.set(undefined);
    const fields = draft.fields();
    let made: AgentResults["create"]["agent"];
    try {
      ({ agent: made } = await call<AgentResults["create"]>(
        "agents",
        "create",
        fields,
      ));
    } catch (error) {
      failure.set(reason(error));
      sending.set(false);
      return;
    }
    if (fields.model && fields.runtime === "eta") rememberModel(fields.model);
    toast(t("create.agent.created", { name: made.name }));
    try {
      const { conversation } = await call<AgentResults["direct"]>(
        "agents",
        "direct",
        {
          agentId: made.id,
        },
      );
      enterChat(conversation.id, 2);
    } catch (error) {
      // The agent exists: going again here would make a second one.
      toast(t("common.failed", { message: reason(error) }));
      nav.pop(2);
    }
  };

  return (
    <Page form>
      <TopBar icon="caretLeft" />
      <Body fill ref={(scroll) => (body = scroll)}>
        <Title title={t("create.agent.title")}>
          <Steps step={2} />
        </Title>
        <ChoiceField
          testID="agent-persona"
          label={t("create.agent.persona")}
          value={
            personas().find((card) => card.id === draft.persona())?.name ??
            t("create.agent.personaDefault")
          }
          onPress={() => picking.set(true)}
        />
        <TextField
          testID="agent-instructions"
          onFocus={showField}
          label={t("create.agent.instructions")}
          value={draft.instructions()}
          onChange={(value) => draft.instructions.set(value)}
          placeholder={t("create.agent.instructionsPlaceholder")}
          maxLength={INSTRUCTIONS_MAX}
          multiline
          grow
          height={140}
        />
        <View class="shrink-0 border-t border-border px-4 py-[10px]">
          <Text class="text-sm leading-[18px] text-muted-foreground">
            {t("create.agent.instructionsHelp")}
          </Text>
        </View>
        <If when={failure() !== undefined}>
          <View class="shrink-0 border-t border-state-error px-4 py-[10px]">
            <Text class="text-md leading-[20px] text-state-error">
              {t("create.agent.failed", { message: failure() ?? "" })}
            </Text>
          </View>
        </If>
      </Body>
      <Cta
        title={
          sending()
            ? t("create.agent.creating")
            : failure() === undefined
              ? t("create.agent.create")
              : t("create.agent.retry")
        }
        testID="agent-create"
        disabled={sending()}
        onPress={() => void create()}
      />
      <SelectSheet
        open={picking()}
        title={t("create.agent.persona")}
        value={draft.persona() || "__default__"}
        options={[
          { value: "__default__", label: t("create.agent.personaDefault") },
          ...personas().map((card) => ({
            value: card.id,
            label: card.name,
            hint: card.description,
          })),
        ]}
        onChange={(value) =>
          draft.persona.set(value === "__default__" ? "" : value)
        }
        onClose={() => picking.set(false)}
      />
    </Page>
  );
}
