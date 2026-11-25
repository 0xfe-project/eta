/**
 * Deleting a routine asks first. The host deletes its brief versions, runs, reports and feedback
 * with it (`routine` cascades), and refuses while a run is going, so the dialog says both.
 */
import type { RoutineInfo } from "@eta/client-contracts";
import { signal } from "nsh";
import { Label } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { ConfirmDialog } from "../../ui";

export function DeleteRoutine(props: {
  routine: RoutineInfo;
  running: boolean;
  phone: boolean;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const host = useHost();
  const busy = signal(false);
  // Deleting ends the dialog's routine: hold on to which one it was.
  const id = props.routine.id;
  async function remove() {
    if (busy() || props.running) return;
    busy.set(true);
    const result = await host.action(() =>
      host.call("routines", "delete", { routineId: id }),
    );
    busy.set(false);
    if (result !== undefined) props.onDeleted(id);
  }
  return (
    <ConfirmDialog
      title={uiText("deleteRoutineTitle", { name: props.routine.name })}
      description={uiText("deleteRoutineBody")}
      confirmLabel={uiText("delete")}
      tone="danger"
      phone={props.phone}
      busy={busy()}
      disabled={props.running}
      onConfirm={() => void remove()}
      onClose={props.onClose}
    >
      <If when={props.running}>
        <Label variant="small" tone="warning">
          {uiText("deleteRoutineRunning")}
        </Label>
      </If>
    </ConfirmDialog>
  );
}
