import type { HostUpdate } from "./host-update";
import { View } from "nsh";
import { Button, Label, Modal, row } from "../../../components";
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
        width={448}
        blurBackdrop={false}
        overPhoneNavigation
        dismissible={!pending()}
        onClose={() => {
          confirm.set(false);
          error.set("");
        }}
      >
        <View style={{ padding: 16, gap: 10 }}>
          <Label size={12} tone="mutedInk">
            {uiText("etaDownloadsTheReleaseBacksUp")}
          </Label>
          <BusyList
            work={check()?.busy ?? []}
            label={uiText("theRestartWouldStop")}
          />
          <If when={error()}>
            <Label size={12} tone="red">
              {error()}
            </Label>
          </If>
          <View
            style={{
              ...row,
              flexWrap: "wrap",
              justifyContent: "flex-end",
              gap: 8,
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
