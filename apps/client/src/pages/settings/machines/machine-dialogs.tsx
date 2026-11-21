import type { MachineView } from "@eta/client-contracts";
import type { JSX } from "nsh";
import { signal, View } from "nsh";
import { Button, colors, Field, Label, Modal, row } from "../../../components";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";

/**
 * The machine row's small dialogs: one field and Cancel / Save. Off phones it is the design's
 * 480pt dialog (14pt padding, a 14/500 title); on a phone it is a bottom sheet with full-width
 * Save and Cancel.
 */
function MachineFieldDialog(props: {
  title: string;
  label: string;
  value: string;
  phone: boolean;
  busy: boolean;
  valid: boolean;
  saveLabel?: string;
  description?: JSX.Element;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const c = colors();
  const field = () => (
    <Field
      label={props.label}
      value={props.value}
      onChange={props.onChange}
      onSubmit={props.onSave}
      inputRef={(node) => setTimeout(() => node.focus(), 50)}
      style={{
        height: props.phone ? 36 : 30,
        fontSize: props.phone ? 14 : 12,
        lineHeight: props.phone ? 20 : 16,
        paddingHorizontal: 10,
        borderColor: c().strong,
      }}
    />
  );
  return (
    <Modal
      title={props.title}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      compact={!props.phone}
      titleWeight={500}
      overPhoneNavigation
      dismissible={!props.busy}
      onClose={props.onClose}
    >
      <If
        when={props.phone}
        else={
          <>
            <View style={{ paddingTop: 12, gap: 8 }}>
              {props.description}
              {field()}
            </View>
            <View
              style={{
                ...row,
                justifyContent: "flex-end",
                gap: 8,
                paddingTop: 20,
              }}
            >
              <Button
                label={uiText("cancel")}
                size={28}
                style={{ paddingHorizontal: 8 }}
                disabled={props.busy}
                onPress={props.onClose}
              />
              <Button
                label={props.saveLabel ?? uiText("save")}
                tone="primary"
                size={28}
                style={{ paddingHorizontal: 8 }}
                disabled={props.busy || !props.valid}
                onPress={props.onSave}
              />
            </View>
          </>
        }
      >
        <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 8 }}>
          {props.description}
          {field()}
        </View>
        <View style={{ padding: 16, gap: 8 }}>
          <Button
            label={props.saveLabel ?? uiText("save")}
            tone="primary"
            size={40}
            disabled={props.busy || !props.valid}
            onPress={props.onSave}
          />
          <Button
            label={uiText("cancel")}
            size={40}
            disabled={props.busy}
            onPress={props.onClose}
          />
        </View>
      </If>
    </Modal>
  );
}

export function RenameMachine(props: {
  item: MachineView;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const name = signal(props.item.name);
  const busy = signal(false);
  const valid = () => !!name().trim() && name().trim() !== props.item.name;
  async function save() {
    if (busy() || !valid()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("machines", "rename", {
        machineId: props.item.id,
        name: name().trim(),
      }),
    );
    busy.set(false);
    if (result !== undefined) props.onClose();
  }
  return (
    <MachineFieldDialog
      title={uiText("machineRenameTitle", { name: props.item.name })}
      label={uiText("machineName")}
      value={name()}
      phone={props.phone}
      busy={busy()}
      valid={valid()}
      onChange={name.set}
      onSave={() => void save()}
      onClose={props.onClose}
    />
  );
}

export function MachineRunsLimit(props: {
  item: MachineView;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const limit = signal(String(props.item.maxActiveRuns));
  const busy = signal(false);
  const valid = () =>
    /^(?:[1-9]|1\d|20)$/.test(limit().trim()) &&
    Number(limit().trim()) !== props.item.maxActiveRuns;
  async function save() {
    if (busy() || !valid()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("machines", "setMaxActiveRuns", {
        machineId: props.item.id,
        maxActiveRuns: Number(limit().trim()),
      }),
    );
    busy.set(false);
    if (result !== undefined) props.onClose();
  }
  return (
    <MachineFieldDialog
      title={uiText("machineRunsTitle", { name: props.item.name })}
      label={uiText("maximumTaskRuns")}
      value={limit()}
      phone={props.phone}
      busy={busy()}
      valid={valid()}
      description={
        <If when={props.phone}>
          <Label size={12} line={16} tone="muted">
            {uiText("machineRunsField")}
          </Label>
        </If>
      }
      onChange={limit.set}
      onSave={() => void save()}
      onClose={props.onClose}
    />
  );
}

/** Revoking asks first: the machine's agents stop reaching it. */
export function RevokeMachine(props: {
  item: MachineView;
  phone: boolean;
  onClose: () => void;
  onRevoked?: () => void;
}) {
  const host = useHost();
  const busy = signal(false);
  async function revoke() {
    if (busy()) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("machines", "revoke", { machineId: props.item.id }),
    );
    busy.set(false);
    if (result !== undefined) {
      props.onClose();
      props.onRevoked?.();
    }
  }
  return (
    <Modal
      title={uiText("removeMachine2")}
      phone={props.phone}
      sheet={props.phone}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 8 }}>
        <Label>
          {uiText("willNoLongerBeAbleTo", { name: props.item.name })}
        </Label>
        <Button
          label={uiText("removeMachine")}
          disabled={busy()}
          onPress={() => void revoke()}
        />
      </View>
    </Modal>
  );
}
