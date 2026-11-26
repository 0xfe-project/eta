import type {
  AgentFields,
  AgentResults,
  AgentRuntime,
  AgentRuntimeInfo,
  MachineView,
  ModelThinking,
  ThinkingLevel,
} from "@eta/client-contracts";
import {
  AGENT_RUNTIMES,
  agentThinking,
  keptLevel,
} from "@eta/client-contracts";
import { cleanup, effect, signal } from "nsh";
import { colors, textFaces } from "../../../components";
import { useModels } from "../../../components/model-select";
import { space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { follow, useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { askRuntimes, runtimeReason } from "../runtimes/status";
import { createAvatarDraw } from "./avatar";

export interface AgentEditorProps {
  id?: string;
  phone: boolean;
  tablet?: boolean;
  onClose: () => void;
  onModelServices: () => void;
  /** Leave for Settings › Runtimes, where a runtime's sign-in is shown; no link without it. */
  onRuntimes?: () => void;
  /** Start from a template instead (the template gallery); no button without it. */
  onTemplates?: () => void;
}

export function createAgentForm(props: AgentEditorProps) {
  const host = useHost();
  const saved = props.id ? host.agent(props.id) : undefined;
  const name = signal(saved?.name ?? "");
  const instructions = signal(saved?.instructions ?? "");
  const model = signal(saved?.model ?? "");
  const runtime = signal<AgentRuntime>(saved?.runtime ?? "eta");
  const persona = signal(saved?.persona ?? "");
  const plugins = signal(saved?.plugins ?? []);
  const machineId = signal<string | null>(saved?.machineId ?? null);
  const thinking = signal<ThinkingLevel | null>(saved?.thinkingLevel ?? null);
  /** The level the last change of model or runtime cleared, because the new one does not take it. */
  const thinkingCleared = signal<ThinkingLevel | undefined>(undefined);
  const busy = signal(false);
  const customPersona = signal(false);
  /** The machine's runtimes: undefined while it answers, null when it could not be asked. */
  const installed = signal<AgentRuntimeInfo[] | null | undefined>(undefined);
  /** A retry under way, and why the last one failed. */
  const probing = signal(false);
  const probeError = signal<string | undefined>(undefined);
  const models = useModels();
  const creating = !props.id;
  /** An agent's face is drawn and saved apart from the form: it needs no Save. */
  const avatar = props.id ? createAvatarDraw(props.id) : undefined;
  const phoneEditor = () => props.phone && !creating;
  const stacked = () => creating || props.phone;
  const controlHeight = () => (phoneEditor() ? 32 : creating ? 28 : 24);
  const c = colors();
  const type = textFaces();
  /** The editor's selects and fields: 24px with a strong border in the dialog. */
  const compact = () => !phoneEditor() && !creating;
  const selectStyle = () => ({
    height: controlHeight(),
    ...(compact()
      ? {
          paddingLeft: space[12],
          paddingRight: space[8],
          borderColor: c().strong,
        }
      : {}),
    ...(phoneEditor() ? { paddingHorizontal: space[12] } : {}),
    // The creator's selects take the input token's border, like its fields.
    ...(creating ? { borderColor: c().border } : {}),
  });
  const fieldStyle = () => ({
    height: controlHeight(),
    fontSize: type("small").size,
    ...(phoneEditor()
      ? { paddingHorizontal: space[12], borderColor: c().strong }
      : {}),
    ...(compact()
      ? {
          lineHeight: type("small").line,
          paddingHorizontal: space[12],
          paddingVertical: space[4],
          borderColor: c().strong,
        }
      : {}),
  });
  const canDelete = () =>
    !!saved && saved.systemRole !== "captain" && host.can("agents.delete");
  const canSave = () => {
    if (busy() || !name().trim()) return false;
    return (
      runtime() !== "eta" ||
      Boolean(model().trim()) ||
      Boolean(saved?.runtime === "eta" && !saved.model)
    );
  };
  follow(() => "machines");
  follow(() => "plugins");
  follow(() => "personas");
  const machines = () =>
    host
      .list<MachineView>("machines")
      .filter(
        (item) =>
          item.id === machineId() ||
          item.status === "online" ||
          item.status === "offline",
      );
  const showRunsOn = () =>
    creating ||
    runtime() === "eta" ||
    Boolean(machineId()) ||
    machines().length > 1;
  /** Why a runtime cannot run here, or undefined when it can (or is not known yet). */
  const runtimeReasonOf = (id: AgentRuntime) => {
    const info = installed()?.find((item) => item.id === id);
    return info ? runtimeReason(info) : undefined;
  };
  /**
   * Every runtime to offer, the ones that can run here first and the rest after them: a runtime
   * that cannot run stays in the list (the agent's own one is still readable there) but last.
   */
  const runtimeList = () => {
    const all = [
      ...new Set<AgentRuntime>([
        ...AGENT_RUNTIMES,
        ...(installed()?.map((item) => item.id) ?? []),
        runtime(),
      ]),
    ];
    return [
      ...all.filter((id) => !runtimeReasonOf(id)),
      ...all.filter((id) => runtimeReasonOf(id)),
    ];
  };
  const external = () => installed()?.find((item) => item.id === runtime());
  const runtimeLabel = (id: AgentRuntime) =>
    id === "eta"
      ? uiText("etaBuiltIn")
      : (installed()?.find((item) => item.id === id)?.label ??
        (
          {
            claude: "Claude Code",
            codex: "Codex",
            opencode: "OpenCode",
            pi: "Pi",
            grok: "Grok Build",
            qwen: "Qwen Code",
          } as Record<string, string>
        )[id] ??
        id);
  const noModels = () => runtime() === "eta" && models().length === 0;
  const missingModel = () =>
    Boolean(model().trim()) &&
    (runtime() === "eta"
      ? !models().some((entry) => entry.id === model())
      : external()?.status === "missing" ||
        Boolean(
          external()?.models.length &&
            !external()?.models.some(
              (entry) => `${runtime()}:${entry.id}` === model(),
            ),
        ));
  effect(() => {
    const machine = machineId();
    if (!host.can("agents.runtimes")) return;
    let current = true;
    installed.set(undefined);
    probeError.set(undefined);
    cleanup(() => {
      current = false;
    });
    void askRuntimes(host, machine).then(
      (runtimes) => {
        if (current) installed.set(runtimes);
      },
      () => {
        if (current) installed.set(null);
      },
    );
  });
  /** Ask the machine's runtimes again, past the host's cache (`agents.runtimes { fresh: true }`). */
  async function reprobe() {
    if (probing()) return;
    const machine = machineId();
    probing.set(true);
    probeError.set(undefined);
    try {
      const runtimes = await askRuntimes(host, machine, true);
      if (machineId() === machine) installed.set(runtimes);
    } catch (error) {
      probeError.set(problemText(error));
    } finally {
      probing.set(false);
    }
  }
  function close() {
    if (!busy()) props.onClose();
  }
  /**
   * The levels an agent on this runtime and model can be set to: an eta model's from its
   * declaration, an external runtime's from the machine's list (`agentThinking`).
   */
  function thinkingOf(on: AgentRuntime, chosen: string): ModelThinking {
    if (on === "eta") {
      const found = models().find((entry) => entry.id === chosen.trim());
      if (found !== undefined) return found.thinking;
    }
    return agentThinking(on, chosen, { runtimes: installed() });
  }
  const levels = () => thinkingOf(runtime(), model());
  /** Keep the level where the new model takes it (or may); clear it, and say so, where not. */
  function settleThinking() {
    const level = thinking();
    const kept = keptLevel(levels(), level);
    thinkingCleared.set(kept === level ? undefined : (level ?? undefined));
    thinking.set(kept);
  }
  function chooseRuntime(next: AgentRuntime) {
    if (runtime() === next) return;
    runtime.set(next);
    model.set("");
    settleThinking();
  }
  function chooseModel(next: string) {
    if (model() === next) return;
    model.set(next);
    settleThinking();
  }
  function chooseThinking(next: ThinkingLevel | null) {
    thinkingCleared.set(undefined);
    thinking.set(next);
  }
  function runtimeModel() {
    const value = model().trim();
    if (!value) return null;
    return runtime() !== "eta" && !value.includes(":") && value !== saved?.model
      ? `${runtime()}:${value}`
      : value;
  }

  async function save() {
    if (!canSave()) return;
    const fields: AgentFields = {
      name: name().trim(),
      instructions: instructions(),
      model: runtimeModel(),
      runtime: runtime(),
      plugins: plugins(),
      persona: persona(),
      machineId: machineId(),
      thinkingLevel: thinking(),
    };
    const patch = saved
      ? {
          ...(fields.name !== saved.name && { name: fields.name }),
          ...(fields.instructions !== saved.instructions && {
            instructions: fields.instructions,
          }),
          ...(fields.model !== saved.model && { model: fields.model }),
          ...(fields.runtime !== saved.runtime && { runtime: fields.runtime }),
          ...(fields.persona !== saved.persona && { persona: fields.persona }),
          ...(fields.machineId !== saved.machineId && {
            machineId: fields.machineId,
          }),
          ...(fields.thinkingLevel !== saved.thinkingLevel && {
            thinkingLevel: fields.thinkingLevel,
          }),
          ...(JSON.stringify(fields.plugins) !==
            JSON.stringify(saved.plugins) && { plugins: fields.plugins }),
        }
      : fields;
    busy.set(true);
    const result = await host.action(() =>
      props.id
        ? host.call<AgentResults["update"]>("agents", "update", {
            agentId: props.id,
            ...patch,
          })
        : host.call<AgentResults["create"]>("agents", "create", fields),
    );
    busy.set(false);
    if (result) close();
  }
  async function remove() {
    if (!canDelete() || !props.id || busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call<AgentResults["delete"]>("agents", "delete", {
        agentId: props.id!,
      }),
    );
    busy.set(false);
    if (result) close();
  }

  return {
    name,
    instructions,
    model,
    runtime,
    persona,
    plugins,
    machineId,
    thinking,
    thinkingCleared,
    levels,
    chooseThinking,
    saved,
    avatar,
    customPersona,
    creating,
    phoneEditor,
    stacked,
    controlHeight,
    selectStyle,
    fieldStyle,
    machines,
    showRunsOn,
    runtimeList,
    runtimeLabel,
    external,
    installed,
    probing,
    probeError,
    reprobe,
    noModels,
    missingModel,
    chooseRuntime,
    chooseModel,
    canSave,
    canDelete,
    busy,
    close,
    save,
    remove,
  };
}

export type AgentForm = ReturnType<typeof createAgentForm>;
