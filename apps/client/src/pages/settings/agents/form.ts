import type {
  AgentFields,
  AgentResults,
  AgentRuntime,
  AgentRuntimeInfo,
  MachineView,
  ThinkingLevel,
} from "@eta/client-contracts";
import { AGENT_RUNTIMES } from "@eta/client-contracts";
import { cleanup, effect, signal } from "nsh";
import { colors, textFaces } from "../../../components";
import { useModels } from "../../../components/model-select";
import { uiText } from "../../../i18n";
import { follow, useHost } from "../../../services/host";
import { askRuntimes } from "../runtimes/status";

export interface AgentEditorProps {
  id?: string;
  phone: boolean;
  tablet?: boolean;
  onClose: () => void;
  onModelServices: () => void;
  /** Leave for Settings › Runtimes, where a runtime's sign-in is shown; no link without it. */
  onRuntimes?: () => void;
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
  const busy = signal(false);
  const customPersona = signal(false);
  /** The machine's runtimes: undefined while it answers, null when it could not be asked. */
  const installed = signal<AgentRuntimeInfo[] | null | undefined>(undefined);
  /** A retry under way, and why the last one failed. */
  const probing = signal(false);
  const probeError = signal<string | undefined>(undefined);
  const models = useModels();
  const creating = !props.id;
  const phoneEditor = () => props.phone && !creating;
  const stacked = () => creating || props.phone;
  const controlHeight = () => (phoneEditor() ? 32 : creating ? 28 : 24);
  const c = colors();
  const type = textFaces();
  /** The editor's selects and fields: 24px with a strong border in the dialog. */
  const compact = () => !phoneEditor() && !creating;
  const selectStyle = () => ({
    height: controlHeight(),
    ...(compact() ? { paddingLeft: 10, paddingRight: 8 } : {}),
    ...(phoneEditor() ? { paddingHorizontal: 12 } : {}),
    // The creator's selects take the input token's border, like its fields.
    ...(creating ? { borderColor: c().border } : {}),
  });
  const fieldStyle = () => ({
    height: controlHeight(),
    fontSize: type("small").size,
    ...(phoneEditor()
      ? { paddingHorizontal: 10, borderColor: c().strong }
      : {}),
    ...(compact()
      ? {
          lineHeight: type("small").line,
          paddingHorizontal: 10,
          paddingVertical: 3,
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
  const runtimeList = () => [
    ...new Set<AgentRuntime>([
      ...AGENT_RUNTIMES,
      ...(installed()?.map((item) => item.id) ?? []),
      runtime(),
    ]),
  ];
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
      probeError.set(error instanceof Error ? error.message : String(error));
    } finally {
      probing.set(false);
    }
  }
  /** The runtimes that cannot be picked and say why in their own words. */
  const explained = () =>
    (installed() ?? []).filter(
      (item) => item.status !== "available" && item.detail,
    );

  function close() {
    if (!busy()) props.onClose();
  }
  function chooseRuntime(next: AgentRuntime) {
    if (runtime() === next) return;
    runtime.set(next);
    model.set("");
    thinking.set(null);
  }
  function chooseModel(next: string) {
    if (model() === next) return;
    model.set(next);
    thinking.set(null);
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
    saved,
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
    explained,
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
