import type { JSX } from "nsh";
import { Text, View } from "nsh";
import { Dialog } from "nsh/base";
import { Button } from "./Button";
import { INSET_BOTTOM } from "./Page";
import { t } from "../i18n";

/** A sheet from the bottom over the scrim, as 03p, 05c, 06c–06g. */
export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  children?: JSX.Element;
  testID?: string;
}) {
  return (
    <Dialog
      testID={props.testID}
      open={props.open}
      animation="slide"
      onOpenChange={({ open }) => {
        if (!open) props.onClose();
      }}
      backdropClass="bg-scrim"
      class={`mt-auto w-full bg-background ${INSET_BOTTOM}`}
    >
      {props.children}
    </Dialog>
  );
}

/** A question with two answers: 06g 删除确认 and its kin. */
export function ConfirmSheet(props: {
  open: boolean;
  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={props.open} onClose={props.onClose}>
      <View class="gap-[6px] px-4 pt-[20px] pb-4">
        <Text class="text-title leading-[30px] tracking-[-0.01em] text-foreground">{props.title}</Text>
        <If when={props.body !== undefined}>
          <Text class="text-base leading-[23px] text-muted-foreground">{props.body}</Text>
        </If>
      </View>
      <View class="flex-row gap-2 px-4 pb-2">
        <Button title={t("common.cancel")} height={44} onPress={props.onClose} />
        <Button
          title={props.confirm}
          height={44}
          variant={props.danger ? "danger" : "primary"}
          onPress={props.onConfirm}
        />
      </View>
    </Sheet>
  );
}
