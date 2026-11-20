import type { MachineInstallView, MachineResults } from "@eta/client-contracts";
import { Clipboard, Scroll, signal, View } from "nsh";
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
} from "../../../components";
import { formatLocale, uiText } from "../../../i18n";
import { useHost } from "../../../services/host";
import { PaneBack } from "../section";

export function AddMachine(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const c = colors();
  const mode = signal<"command" | "ssh">("command");
  const name = signal("");
  const address = signal("");
  const destination = signal("");
  const password = signal("");
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
            password: password() || undefined,
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

  function control() {
    return (
      <Button
        label={uiText(command() ? "machineGenerateCommand" : "startSshInstall")}
        tone="primary"
        size={props.phone ? 32 : 24}
        style={{ paddingHorizontal: 12 }}
        disabled={
          busy() || installing() || (!command() && !destination().trim())
        }
        onPress={() => void create()}
      />
    );
  }

  const content = () => (
    <Scroll style={grow} scrollbar={false}>
      <If when={props.phone}>
        <View
          style={{ padding: 16, borderBottomWidth: 1, borderColor: c().border }}
        >
          <Label>{warning()}</Label>
        </View>
      </If>
      <If when={!command() || props.phone || enrollment()}>
        <View style={{ padding: 16, gap: 10 }}>
          <If
            when={command()}
            else={
              <>
                <Field
                  label={uiText("sshDestination")}
                  placeholder={uiText("userHostOrSshAlias")}
                  value={destination()}
                  onChange={destination.set}
                />
                <Field
                  label={uiText("sshPassword")}
                  placeholder={uiText("optionalWhenSshUsesAPassword")}
                  value={password()}
                  onChange={password.set}
                  masked
                />
              </>
            }
          >
            <Label>{uiText("runTheCommandInThatMachines")}</Label>
          </If>
          <If
            when={
              !command() || (props.phone && !enrollment()) || commandOptions()
            }
          >
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
          <If when={command() ? enrollment() : undefined}>
            {(item) => (
              <>
                <View
                  style={{
                    gap: 8,
                    padding: 12,
                    borderWidth: 1,
                    borderColor: c().border,
                  }}
                >
                  <Label size={12} line={19}>
                    {item().command}
                  </Label>
                  <Button
                    label={uiText(copied() ? "copied" : "copyInstallCommand")}
                    size={props.phone ? 32 : 24}
                    onPress={() =>
                      void host.action(async () => {
                        await Clipboard.writeText(item().command);
                        copied.set(true);
                      })
                    }
                  />
                </View>
                <Label size={12} tone="muted">
                  {uiText("thisOneTimeCommandIsValid", {
                    toLocaleString: new Date(item().expiresAt).toLocaleString(
                      formatLocale(),
                    ),
                  })}
                </Label>
                <Label size={12} tone="muted">
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
              </>
            )}
          </If>
          <If when={!command() && installId()}>
            <Label tone={install()?.step === "failed" ? "red" : "muted"}>
              {uiText(stages[install()?.step ?? "connect"])}
            </Label>
            <If when={install()?.error}>
              <Label size={12} tone="red">
                {install()?.error}
              </Label>
            </If>
          </If>
        </View>
      </If>
    </Scroll>
  );

  const footer = () => (
    <If when={!command() || !enrollment() || commandOptions()}>
      <View
        style={{
          ...(props.phone ? {} : { ...row, justifyContent: "flex-end" }),
          paddingHorizontal: 16,
          paddingVertical: 12,
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
              paddingHorizontal: 16,
              paddingVertical: 8,
              gap: 4,
            }}
          >
            <View style={{ ...row, gap: 10, height: 22 }}>
              <PaneBack label={uiText("machineBack")} onPress={props.onClose} />
              <Label size={14} line={20} weight={600}>
                {title()}
              </Label>
            </View>
            <Label size={12} line={16} tone="muted">
              {warning()}
            </Label>
          </View>
          <View
            style={{
              ...row,
              minHeight: 40,
              paddingHorizontal: 16,
              paddingVertical: 8,
              borderBottomWidth: 1,
              borderColor: c().border,
            }}
          >
            <Label style={{ flex: 1 }}>{uiText("machineMethod")}</Label>
            <ActionMenu
              label={uiText("machineMethod")}
              value={method()}
              triggerStyle={{
                width: 160,
                height: 24,
                paddingLeft: 10,
                paddingRight: 8,
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
        <View style={{ ...row, borderBottomWidth: 1, borderColor: c().border }}>
          <Button
            label={uiText("runACommand")}
            size={40}
            tone="ghost"
            selected={command()}
            style={{ flex: 1, borderBottomWidth: command() ? 2 : 0 }}
            onPress={() => mode.set("command")}
          />
          <If when={host.can("machines.install")}>
            <Button
              label={uiText("installOverSsh")}
              size={40}
              tone="ghost"
              selected={!command()}
              style={{ flex: 1, borderBottomWidth: command() ? 0 : 2 }}
              onPress={() => mode.set("ssh")}
            />
          </If>
        </View>
        {content()}
        {footer()}
      </Modal>
    </If>
  );
}
