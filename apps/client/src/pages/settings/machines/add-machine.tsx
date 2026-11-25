import type { MachineInstallView, MachineResults } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { cleanup, Clipboard, effect, signal, View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Field,
  grow,
  Label,
  Modal,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../../components";
import { ToggleSwitch } from "../../../components/toggle-switch";
import {
  control as controlHeight,
  space,
  weight,
} from "../../../components/tokens";
import { formatLocale, uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { problemText } from "../../../services/problem-text";
import { Tabs } from "../../../ui";
import { PaneBack } from "../section";

/** A field beside its label, the title row with its back link, and the method menu. */
const fieldWidth = 240;
const titleRow = 24;
const methodWidth = 160;

export function AddMachine(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const mode = signal<"command" | "ssh">("command");
  const name = signal("");
  const address = signal("");
  const destination = signal("");
  const password = signal("");
  const keyless = signal(false);
  const enrollment = signal<MachineResults["enroll"] | undefined>(undefined);
  const commandOptions = signal(false);
  const installId = signal("");
  const busy = signal(false);
  const copied = signal(false);
  const install = () =>
    host
      .list<MachineInstallView>("machines", "installs")
      .find((item) => item.id === installId());
  const stages = {
    connect: "machineInstallConnecting",
    send: "machineInstallSending",
    register: "machineInstallRegistering",
    service: "machineInstallService",
    done: "machineInstallConnected",
    failed: "machineInstallFailed",
  } as const satisfies Record<
    MachineInstallView["step"],
    Parameters<typeof uiText>[0]
  >;
  const installing = () =>
    Boolean(installId()) && !["done", "failed"].includes(install()?.step ?? "");
  const installSlow = signal(false);
  effect(() => {
    const active = installing();
    const step = install()?.step ?? "connect";
    installSlow.set(false);
    if (!active) return;
    void step;
    const timer = setTimeout(() => installSlow.set(true), 10_000);
    cleanup(() => clearTimeout(timer));
  });
  async function create() {
    if (busy() || installing()) return;
    busy.set(true);
    const args = {
      name: name().trim() || undefined,
      url: address().trim() || host.address()?.origin,
    };
    try {
      if (mode() === "command") {
        const result = await host.action(() =>
          host.call<MachineResults["enroll"]>("machines", "enroll", args),
        );
        if (result) {
          enrollment.set(result);
          commandOptions.set(false);
          copied.set(false);
        }
      } else if (destination().trim()) {
        const result = await host.action(() =>
          host.call<MachineResults["install"]>("machines", "install", {
            ...args,
            host: destination().trim(),
            password: keyless() ? undefined : password() || undefined,
          }),
        );
        if (result) installId.set(result.installId);
      }
    } finally {
      password.set("");
      busy.set(false);
    }
  }
  const command = () => mode() === "command";
  const warning = () => uiText("agentsRunOnThatMachineWith");
  const title = () => uiText("addMachine");
  const method = () => uiText(command() ? "runACommand" : "installOverSsh");

  const preference = () =>
    ({
      ...row,
      minHeight: space[40],
      gap: space[16],
      paddingHorizontal: space[16],
      paddingVertical: space[8],
      borderBottomWidth: 1,
      borderColor: c().border,
    }) as const;
  const sshReady = () =>
    !!destination().trim() && (keyless() || password() !== "");

  function control() {
    return (
      <Button
        label={uiText(command() ? "machineGenerateCommand" : "sshInstall")}
        tone="primary"
        size={props.phone ? controlHeight.touch : controlHeight.sm}
        style={{ paddingHorizontal: space[12] }}
        disabled={!command() && !sshReady()}
        busy={busy() || installing()}
        onPress={() => void create()}
      />
    );
  }

  /** A field row: the label beside the field off phones, above it on a phone. */
  function fieldRow(row_: {
    label: string;
    hint?: string;
    field: (style: Record<string, unknown>) => JSX.Element;
  }) {
    return (
      <If
        when={props.phone}
        else={
          <View style={preference()}>
            <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
              <Label>{row_.label}</Label>
              <If when={row_.hint}>
                <Label variant="small" tone="muted">
                  {row_.hint}
                </Label>
              </If>
            </View>
            {row_.field({
              width: fieldWidth,
              height: space[24],
              ...textStyle(type("small")),
              paddingHorizontal: space[12],
              paddingVertical: space[4],
              borderColor: c().strong,
            })}
          </View>
        }
      >
        <View
          style={{
            gap: space[4],
            paddingHorizontal: space[16],
            paddingVertical: space[12],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label>{row_.label}</Label>
          {row_.field({
            height: space[40],
            ...textStyle(type("body")),
            paddingHorizontal: space[12],
            borderColor: c().strong,
          })}
          <If when={row_.hint}>
            <Label variant="small" tone="mutedInk">
              {row_.hint}
            </Label>
          </If>
        </View>
      </If>
    );
  }

  /** Install over SSH: Target, the keyless switch and the password, as the web app asks. */
  const sshForm = () => (
    <>
      {fieldRow({
        label: uiText("sshTarget"),
        field: (style) => (
          <Field
            label={uiText("sshTarget")}
            placeholder={uiText("userHostOrSshAlias")}
            value={destination()}
            onChange={destination.set}
            style={style}
          />
        ),
      })}
      <View
        style={{
          ...preference(),
          gap: props.phone ? space[12] : space[16],
          paddingVertical: props.phone ? space[12] : space[8],
        }}
      >
        <Label style={{ flex: 1, minWidth: 0 }}>{uiText("sshKeyless")}</Label>
        <ToggleSwitch
          label={uiText("sshKeyless")}
          checked={keyless()}
          onChange={keyless.set}
        />
      </View>
      <If when={!keyless()}>
        {fieldRow({
          label: uiText("sshPassword"),
          hint: uiText("sshPasswordPromise"),
          field: (style) => (
            <Field
              label={uiText("sshPassword")}
              value={password()}
              onChange={password.set}
              masked
              style={style}
            />
          ),
        })}
      </If>
      <If when={installId()}>
        <View
          style={{
            paddingHorizontal: space[16],
            paddingVertical: space[12],
            gap: space[4],
          }}
        >
          <Label tone={install()?.step === "failed" ? "red" : "muted"}>
            {uiText(stages[install()?.step ?? "connect"])}
          </Label>
          <If when={installSlow() && installing()}>
            <Label variant="small" tone="warningInk">
              {uiText("takingLongerThanUsual")}
            </Label>
          </If>
          <If when={install()?.error}>
            <Label variant="small" tone="red">
              {problemText(install()?.error ?? "")}
            </Label>
          </If>
        </View>
      </If>
      <If when={props.phone}>
        <View style={{ padding: space[16] }}>{control()}</View>
      </If>
    </>
  );

  const content = () => (
    <SmoothScroll style={grow} scrollbar={false}>
      <If when={props.phone}>
        <View
          style={{
            paddingHorizontal: space[16],
            paddingVertical: space[12],
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Label>{warning()}</Label>
        </View>
      </If>
      <If when={!command()}>{sshForm()}</If>
      <If when={command() && props.phone && !enrollment()}>
        <View style={{ padding: space[16] }}>{control()}</View>
      </If>
      <If when={command() ? enrollment() : undefined}>
        {(item) => (
          <View style={{ padding: space[16], gap: space[8] }}>
            <Label>{uiText("runTheCommandInThatMachines")}</Label>
            <If when={commandOptions()}>
              <Field
                label={uiText("machineName")}
                placeholder={uiText("nameOptional")}
                value={name()}
                onChange={name.set}
              />
              <Field
                label={uiText("hostAddress")}
                placeholder={host.address()?.origin ?? ""}
                value={address()}
                onChange={address.set}
              />
            </If>
            <View
              style={{
                gap: space[8],
                padding: space[12],
                borderWidth: 1,
                borderColor: c().border,
              }}
            >
              <Label variant="small">{item().command}</Label>
              <Button
                label={uiText(copied() ? "copied" : "copyInstallCommand")}
                size={props.phone ? controlHeight.lg : controlHeight.sm}
                onPress={() =>
                  void host.action(async () => {
                    await Clipboard.writeText(item().command);
                    copied.set(true);
                  })
                }
              />
            </View>
            <Label variant="small" tone="muted">
              {uiText("thisOneTimeCommandIsValid", {
                toLocaleString: new Date(item().expiresAt).toLocaleString(
                  formatLocale(),
                ),
              })}
            </Label>
            <Label variant="small" tone="muted">
              {uiText("machineWaitingForCommand")}
            </Label>
            <If when={!props.phone}>
              <Button
                label={uiText("machineCommandOptions")}
                selected={commandOptions()}
                end={commandOptions() ? "down" : "right"}
                style={{ alignSelf: "flex-start" }}
                onPress={() => commandOptions.set(!commandOptions())}
              />
            </If>
          </View>
        )}
      </If>
    </SmoothScroll>
  );

  /** Off phones the action sits in a footer; a phone keeps it under the form. */
  const footer = () => (
    <If
      when={!props.phone && (!command() || !enrollment() || commandOptions())}
    >
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingHorizontal: space[16],
          paddingVertical: space[12],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        {control()}
      </View>
    </If>
  );

  return (
    <If
      when={props.phone}
      else={
        <View style={grow}>
          <View
            style={{
              borderBottomWidth: 1,
              borderColor: c().border,
              paddingHorizontal: space[16],
              paddingVertical: space[8],
              gap: space[4],
            }}
          >
            <View style={{ ...row, gap: space[8], height: titleRow }}>
              <PaneBack label={uiText("machineBack")} onPress={props.onClose} />
              <Label weight={weight.strong}>{title()}</Label>
            </View>
            <Label variant="small" tone="muted">
              {warning()}
            </Label>
          </View>
          <View
            style={{
              ...row,
              minHeight: space[40],
              paddingHorizontal: space[16],
              paddingVertical: space[8],
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label style={{ flex: 1 }}>{uiText("machineMethod")}</Label>
            <ActionMenu
              label={uiText("machineMethod")}
              value={method()}
              triggerStyle={{
                width: methodWidth,
                height: space[24],
                paddingLeft: space[12],
                paddingRight: space[8],
              }}
            >
              <ActionItem
                label={uiText("runACommand")}
                checked={command()}
                onSelect={() => mode.set("command")}
              />
              <If when={host.can("machines.install")}>
                <ActionItem
                  label={uiText("installOverSsh")}
                  checked={!command()}
                  onSelect={() => mode.set("ssh")}
                />
              </If>
            </ActionMenu>
          </View>
          {content()}
          {footer()}
        </View>
      }
    >
      <Modal
        title={title()}
        phone
        phonePage
        height="100%"
        onClose={props.onClose}
      >
        <Tabs
          value={mode()}
          stretch
          options={(host.can("machines.install")
            ? (["command", "ssh"] as const)
            : (["command"] as const)
          ).map((item) => ({
            value: item,
            label: uiText(
              item === "command" ? "runACommand" : "installOverSsh",
            ),
          }))}
          onChange={mode.set}
        />
        {content()}
        {footer()}
      </Modal>
    </If>
  );
}
