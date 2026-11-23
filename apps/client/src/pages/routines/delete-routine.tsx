/**
 * Deleting a routine asks first. The host deletes its brief versions, runs, reports and feedback
 * with it (`routine` cascades), and refuses while a run is going, so the dialog says both.
 */
import type { RoutineInfo } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Label, Modal, row } from "../../components";
import { control, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

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
  const title = () =>
    uiText("deleteRoutineTitle", { name: props.routine.name });
  const blocked = () => busy() || props.running;
  const body = () => (
    <>
      <Label variant="small" tone="muted">
        {uiText("deleteRoutineBody")}
      </Label>
      <If when={props.running}>
        <Label variant="small" tone="warning">
          {uiText("deleteRoutineRunning")}
        </Label>
      </If>
    </>
  );
  return (
    <Modal
      title={title()}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      overPhoneNavigation
      hideHeader={props.phone}
      compact={!props.phone}
      titleWeight={weight.regular}
      dismissible={!busy()}
      onClose={props.onClose}
    >
      <If
        when={props.phone}
        else={
          <View style={{ paddingTop: space[8], gap: space[8] }}>
            {body()}
            <View
              style={{
                ...row,
                gap: space[8],
                justifyContent: "flex-end",
                paddingTop: space[12],
              }}
            >
              <Button
                label={uiText("cancel")}
                size={control.md}
                disabled={busy()}
                onPress={props.onClose}
              />
              <Button
                label={uiText("delete")}
                tone="danger"
                size={control.md}
                disabled={blocked()}
                onPress={() => void remove()}
              />
            </View>
          </View>
        }
      >
        <View
          style={{
            ...row,
            height: control.touch,
            paddingLeft: space[16],
            paddingRight: space[8],
          }}
        >
          <Label weight={weight.strong} style={{ flex: 1 }}>
            {title()}
          </Label>
        </View>
        <View style={{ paddingHorizontal: space[16], gap: space[8] }}>
          {body()}
        </View>
        <View style={{ padding: space[16], gap: space[8] }}>
          <Button
            label={uiText("delete")}
            tone="danger"
            size={40}
            disabled={blocked()}
            onPress={() => void remove()}
          />
          <Button
            label={uiText("cancel")}
            size={40}
            disabled={busy()}
            onPress={props.onClose}
          />
        </View>
      </If>
    </Modal>
  );
}
