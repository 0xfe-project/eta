import type { HostUpdate } from "./host-update";
import { View } from "nsh";
import { Button, dialogWidth, Label, Modal, row } from "../../../components";
import { space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { BusyList } from "./busy-list";

export function ConfirmHostUpdate(props: {
  update: HostUpdate;
  phone: boolean;
}) {
  const { confirm, check, pending, error, canUpdate, request } = props.update;

  return (
    <If when={confirm()}>
      <Modal
        title={uiText("updateTheHostTo", { value1: check()?.latest ?? "" })}
        phone={props.phone}
        width={dialogWidth.md}
        blurBackdrop={false}
        overPhoneNavigation
        dismissible={!pending()}
        onClose={() => {
          confirm.set(false);
          error.set("");
        }}
      >
        <View style={{ padding: space[16], gap: space[8] }}>
          <Label variant="small" tone="mutedInk">
            {uiText("etaDownloadsTheReleaseBacksUp")}
          </Label>
          <BusyList
            work={check()?.busy ?? []}
            label={uiText("theRestartWouldStop")}
          />
          <If when={error()}>
            <Label variant="small" tone="red">
              {error()}
            </Label>
          </If>
          <View
            style={{
              ...row,
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: space[8],
            }}
          >
            <Button
              label={uiText("cancel")}
              disabled={!!pending()}
              onPress={() => {
                confirm.set(false);
                error.set("");
              }}
            />
            <Button
              label={
                check()?.busy.length ? uiText("waitForWork") : uiText("update")
              }
              tone="primary"
              disabled={!canUpdate()}
              onPress={() => void request("start", { force: false })}
            />
            <If when={check()?.busy.length}>
              <Button
                label={uiText("updateNow")}
                disabled={!canUpdate()}
                onPress={() => void request("start", { force: true })}
              />
            </If>
          </View>
        </View>
      </Modal>
    </If>
  );
}
