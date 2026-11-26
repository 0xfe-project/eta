import type {
  AcpAgentConfig,
  AcpAgentView,
  AcpDraft,
  AcpDraftProblems,
  AcpMachineList,
  AcpTestResult,
  MachineView,
} from "@eta/client-contracts";
import {
  acpDraftOf,
  acpSlug,
  checkAcpDraft,
  emptyAcpDraft,
} from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  dialogWidth,
  Field,
  grow,
  Label,
  Modal,
  row,
  textFaces,
  textStyle,
} from "../../components";
import { BackButton } from "../../components/navigation-buttons";
import { StatusDot } from "../../components/status-dot";
import { control, icon, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { problemText } from "../../services/problem-text";
import { acpStatus } from "./external-agent";

/** A multi-line field (the command's arguments, its environment), and the machine menu off
 * phones. */
const multilineHeight = 64;
const machineMenuWidth = 488;

// Settings › External agents: one form to add an agent to a machine's ~/.eta/acp.json or to change
// one there. The fields are checked by the same rules
// (`checkAcpDraft` in @eta/client-contracts); the host still has the last word, and what it
// refuses is shown in its own words. A draft can be tested before it is saved.

/** The primary and every daemon: the primary first, then by name. */
export function acpMachines(machines: readonly MachineView[]): MachineView[] {
  return machines
    .filter(
      (machine) => machine.kind === "primary" || machine.kind === "daemon",
    )
    .sort(
      (a, b) =>
        Number(b.kind === "primary") - Number(a.kind === "primary") ||
        a.name.localeCompare(b.name),
    );
}

/** A machine that can be asked: the primary always, a daemon while it is online. */
const acpReachable = (machine: MachineView) =>
  machine.kind === "primary" || machine.status === "online";

/** Whether agents on the machine can be added or changed now: it answers, and its list came whole. */
export function acpWritable(
  machine: MachineView | undefined,
  lists: Record<string, AcpMachineList>,
) {
  if (!machine || !acpReachable(machine)) return false;
  const list = lists[machine.id];
  return list !== undefined && list.error === undefined;
}

const problemMessages: Record<string, Parameters<typeof uiText>[0]> = {
  "errors.labelRequired": "acpErrorLabelRequired",
  "errors.idRequired": "acpErrorIdRequired",
  "errors.idFormat": "acpErrorIdFormat",
  "errors.idTaken": "acpErrorIdTaken",
  "errors.commandRequired": "acpErrorCommandRequired",
  "errors.env.noEquals": "acpErrorEnvNoEquals",
  "errors.env.emptyKey": "acpErrorEnvEmptyKey",
  "errors.env.duplicate": "acpErrorEnvDuplicate",
};

type Outcome =
  | { kind: "testing" }
  | { kind: "tested"; label: string; result: AcpTestResult }
  | { kind: "testError"; message: string }
  | { kind: "saveFailed"; message: string };

const messageOf = (cause: unknown) => problemText(cause);

/**
 * Add an agent (`agent` absent: on the machine chosen in the form, `machineId` to begin with) or
 * edit `agent` on `machineId`, which then cannot change. `onSaved` gets the id it was saved as.
 */
export function ExternalAgentForm(props: {
  machines: MachineView[];
  lists: Record<string, AcpMachineList>;
  machineId: string;
  agent?: AcpAgentView;
  phone: boolean;
  onSaved: (machineId: string, id: string) => void;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const editing = props.agent !== undefined;
  const machineId = signal(props.machineId);
  const draft = signal<AcpDraft>(
    props.agent ? acpDraftOf(props.agent) : emptyAcpDraft,
  );
  // A new agent's id follows its name until the id is typed in by hand.
  let idTouched = editing;
  const problems = signal<AcpDraftProblems>({});
  const outcome = signal<Outcome | undefined>(undefined);
  const saving = signal(false);
  const listed = () => acpMachines(props.machines);
  const machine = () => listed().find((item) => item.id === machineId());
  const usable = () => acpWritable(machine(), props.lists);
  const testing = () => outcome()?.kind === "testing";
  const machineName = (item: MachineView | undefined) =>
    item
      ? `${item.name}${item.kind === "primary" ? uiText("acpPrimarySuffix") : ""}`
      : machineId();
  // The chosen machine's ids only: another machine may have the same one.
  const taken = () =>
    (props.lists[machineId()]?.agents ?? [])
      .map((item) => item.id)
      .filter((id) => id !== props.agent?.id);

  function change(key: keyof AcpDraft, value: string) {
    draft.update((current) => {
      const next = { ...current, [key]: value };
      if (key === "label" && !idTouched) next.id = acpSlug(value);
      return next;
    });
    if (key === "id") idTouched = true;
    problems.update((current) => {
      const rest = { ...current };
      delete rest[key as keyof AcpDraftProblems];
      if (key === "label" && !idTouched) delete rest.id;
      return rest;
    });
    // What was tested or refused was another draft.
    if (outcome() && outcome()?.kind !== "testing") outcome.set(undefined);
  }

  function chooseMachine(next: string) {
    machineId.set(next);
    outcome.set(undefined);
    // A clash was with the other machine's ids.
    problems.update(({ id: _id, ...rest }) => rest);
  }

  function checked(): AcpAgentConfig | undefined {
    const result = checkAcpDraft(draft(), taken());
    if (!result.ok) {
      problems.set(result.problems);
      return undefined;
    }
    problems.set({});
    return result.config;
  }

  async function test() {
    if (testing() || saving() || !usable()) return;
    const config = checked();
    if (!config) return;
    outcome.set({ kind: "testing" });
    try {
      const result = await host.call<AcpTestResult>(
        "acp",
        "test",
        { machineId: machineId(), agent: config },
        { timeoutMs: 60_000 },
      );
      outcome.set({ kind: "tested", label: config.label, result });
    } catch (cause) {
      outcome.set({ kind: "testError", message: messageOf(cause) });
    }
  }

  async function save() {
    if (saving() || !usable()) return;
    const config = checked();
    if (!config) return;
    saving.set(true);
    if (outcome()?.kind === "saveFailed") outcome.set(undefined);
    try {
      const saved = await host.call<AcpAgentView>(
        "acp",
        "save",
        {
          machineId: machineId(),
          agent: config,
          // An edit always names the agent it edits: without `previousId` the host takes it
          // for a new one, and refuses the id it already has.
          ...(props.agent ? { previousId: props.agent.id } : {}),
        },
        { timeoutMs: 30_000 },
      );
      saving.set(false);
      props.onSaved(machineId(), saved.id);
    } catch (cause) {
      saving.set(false);
      outcome.set({ kind: "saveFailed", message: messageOf(cause) });
    }
  }

  const problemText = (field: keyof AcpDraftProblems) => {
    const problem = problems()[field];
    if (!problem) return undefined;
    const key = problemMessages[problem.key];
    return key ? uiText(key, { line: problem.line ?? "" }) : problem.key;
  };
  const inputStyle = (invalid: boolean, multiline = false) => ({
    height: multiline
      ? multilineHeight
      : props.phone
        ? control.touch
        : control.lg,
    ...textStyle(type(props.phone ? "body" : "small")),
    paddingHorizontal: space[12],
    paddingVertical: multiline ? space[8] : undefined,
    borderColor: invalid ? c().red : c().strong,
  });
  const hint = (text: string) => (
    <Label variant="small" tone="muted">
      {text}
    </Label>
  );
  const error = (text: string) => (
    <Label variant="small" tone="red">
      {text}
    </Label>
  );
  const field = (p: {
    name: keyof AcpDraft;
    title: string;
    placeholder?: string;
    /** Read when drawn, so a hint that follows the draft doesn't rebuild the field. */
    hint?: () => string;
    multiline?: boolean;
  }) => {
    const problem = () =>
      p.name in problems()
        ? problemText(p.name as keyof AcpDraftProblems)
        : undefined;
    return (
      <View style={{ gap: space[4] }}>
        <Label variant="small" weight={weight.regular}>
          {p.title}
        </Label>
        <Field
          label={p.title}
          value={draft()[p.name]}
          placeholder={p.placeholder}
          multiline={p.multiline}
          readonly={saving()}
          style={inputStyle(problem() !== undefined, p.multiline)}
          onChange={(value) => change(p.name, value)}
        />
        <If when={problem()} else={p.hint ? hint(p.hint()) : undefined}>
          {(text) => error(text())}
        </If>
      </View>
    );
  };
  const statusLine = (
    dot: string,
    text: string,
    detail?: string,
    tone: "ink" | "red" | "mutedInk" = "ink",
  ) => (
    <View
      style={{
        gap: space[2],
        paddingHorizontal: space[12],
        paddingVertical: space[8],
        borderWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ ...row, gap: space[4], alignItems: "flex-start" }}>
        <View style={{ paddingTop: space[4] }}>
          <StatusDot color={dot} />
        </View>
        <Label variant="small" tone={tone} style={{ flex: 1, minWidth: 0 }}>
          {text}
        </Label>
      </View>
      <If when={detail}>
        <Label
          variant="small"
          tone="warning"
          style={{ paddingLeft: space[12] }}
        >
          {detail}
        </Label>
      </If>
    </View>
  );
  const status = () => {
    if (!usable())
      return statusLine(
        c().faint,
        uiText("acpMachineOffline", { name: machine()?.name ?? machineId() }),
        undefined,
        "mutedInk",
      );
    const current = outcome();
    if (!current) return undefined;
    switch (current.kind) {
      case "testing":
        return statusLine(
          c().faint,
          uiText("acpTestingOn", { machine: machine()?.name ?? machineId() }),
          undefined,
          "mutedInk",
        );
      case "tested": {
        const { result, label } = current;
        if (result.ok)
          return statusLine(
            c().green,
            uiText("acpTestOk", {
              label,
              agent:
                [result.agentName, result.version].filter(Boolean).join(" ") ||
                label,
            }),
            result.detail,
          );
        return statusLine(
          result.status === "error" ? c().red : c().warning,
          uiText("acpTestFailed", {
            label,
            status: uiText(acpStatus[result.status]),
          }),
          result.detail,
        );
      }
      case "testError":
        return statusLine(c().red, current.message, undefined, "red");
      case "saveFailed":
        return statusLine(
          c().red,
          uiText("acpSaveFailed", { message: current.message }),
          undefined,
          "red",
        );
    }
  };
  const title = () =>
    props.agent
      ? uiText("acpEditTitle", { label: props.agent.label })
      : uiText("acpAddTitle");
  const machineField = () => (
    <View style={{ gap: space[4] }}>
      <Label variant="small" weight={weight.regular}>
        {uiText("externalAgentMachine")}
      </Label>
      <If
        when={!editing}
        else={
          <View
            role="text"
            accessibilityLabel={uiText("externalAgentMachine")}
            style={{
              ...row,
              height: props.phone ? control.touch : control.lg,
              paddingHorizontal: space[12],
              borderWidth: 1,
              borderColor: c().border,
              backgroundColor: c().surface,
            }}
          >
            <Label variant={props.phone ? "body" : "small"} tone="mutedInk">
              {usable()
                ? machineName(machine())
                : uiText("acpOfflineOption", { name: machineName(machine()) })}
            </Label>
          </View>
        }
      >
        <ActionMenu
          label={uiText("externalAgentMachine")}
          value={machineName(machine())}
          popupWidth={props.phone ? undefined : machineMenuWidth}
          sheetTitle={uiText("externalAgentMachine")}
          triggerStyle={{
            width: "100%",
            height: props.phone ? control.touch : control.lg,
            paddingLeft: space[12],
            paddingRight: space[8],
          }}
        >
          <Each of={listed()} key={(item) => item.id}>
            {(item) => (
              <ActionItem
                label={
                  acpReachable(item())
                    ? machineName(item())
                    : uiText("acpOfflineOption", {
                        name: machineName(item()),
                      })
                }
                checked={item().id === machineId()}
                disabled={!acpWritable(item(), props.lists)}
                onSelect={() => chooseMachine(item().id)}
              />
            )}
          </Each>
        </ActionMenu>
      </If>
      {hint(
        editing ? uiText("acpMachineEditHint") : uiText("acpMachineAddHint"),
      )}
    </View>
  );
  const fields = () => (
    <View style={{ gap: space[12] }}>
      {machineField()}
      {field({
        name: "label",
        title: uiText("acpName"),
        placeholder: uiText("acpNamePlaceholder"),
      })}
      {field({
        name: "id",
        title: uiText("acpId"),
        placeholder: "my-agent",
        hint: () =>
          uiText("acpIdHint", { runtime: `acp.${draft().id || "…"}` }),
      })}
      {field({
        name: "command",
        title: uiText("externalAgentCommand"),
        placeholder: "npx",
      })}
      {field({
        name: "args",
        title: uiText("acpArgs"),
        placeholder: "-y\n@example/agent\n--acp",
        hint: () => uiText("acpArgsHint"),
        multiline: true,
      })}
      {field({
        name: "env",
        title: uiText("acpEnv"),
        placeholder: "API_KEY=…",
        hint: () => uiText("acpEnvHint"),
        multiline: true,
      })}
      {status()}
    </View>
  );
  const saveLabel = () => (editing ? uiText("save") : uiText("acpAdd"));
  return (
    <Modal
      title={title()}
      phone={props.phone}
      phonePage={props.phone}
      hideHeader={props.phone}
      height={props.phone ? "100%" : undefined}
      width={dialogWidth.lg}
      dismissible={!saving()}
      onClose={props.onClose}
    >
      <If when={props.phone}>
        <View
          style={{
            ...row,
            height: space[48],
            flexShrink: 0,
            gap: space[4],
            paddingHorizontal: space[8],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <BackButton
            size={control.touch}
            iconSize={icon.md}
            disabled={saving()}
            onPress={props.onClose}
          />
          <Label weight={weight.strong} lines={1} style={{ flex: 1 }}>
            {title()}
          </Label>
        </View>
      </If>
      {/* eslint-disable-next-line no-restricted-syntax -- as on main since #776; not this change's */}
      <Scroll style={props.phone ? grow : { flexShrink: 1 }} scrollbar={false}>
        <View
          style={{
            paddingHorizontal: space[16],
            paddingVertical: space[12],
          }}
        >
          {fields()}
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          gap: space[8],
          flexShrink: 0,
          paddingHorizontal: space[16],
          paddingVertical: space[12],
          borderTopWidth: props.phone ? 1 : 0,
          borderColor: c().border,
        }}
      >
        <If when={host.can("acp.test")}>
          <Button
            label={uiText("test")}
            size={props.phone ? control.lg : control.md}
            style={{ paddingHorizontal: props.phone ? space[16] : space[8] }}
            disabled={saving() || !usable()}
            busy={testing()}
            onPress={() => void test()}
          />
        </If>
        <If when={!props.phone} else={<View style={{ width: 0 }} />}>
          <View style={{ flex: 1 }} />
          <Button
            label={uiText("cancel")}
            size={control.md}
            style={{ paddingHorizontal: space[8] }}
            disabled={saving()}
            onPress={props.onClose}
          />
        </If>
        <Button
          label={saveLabel()}
          tone="primary"
          size={props.phone ? control.lg : control.md}
          style={
            props.phone
              ? { flex: 1, justifyContent: "center" }
              : { paddingHorizontal: space[8] }
          }
          disabled={!usable()}
          busy={saving()}
          onPress={() => void save()}
        />
      </View>
    </Modal>
  );
}
