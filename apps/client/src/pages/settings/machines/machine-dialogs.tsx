import type { MachineView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Label, Modal } from "../../../components";
import { FieldDialog } from "../../../components/field-dialog";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";

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
    <FieldDialog
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
    <FieldDialog
      title={uiText("machineRunsTitle", { name: props.item.name })}
      label={uiText("maximumTaskRuns")}
      value={limit()}
      phone={props.phone}
      busy={busy()}
      valid={valid()}
      description={
        <If when={props.phone}>
          <Label variant="small" tone="muted">
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
