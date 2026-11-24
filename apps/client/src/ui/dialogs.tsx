import type { JSX } from "nsh";
import { View } from "nsh";
import { colors, row, textFaces, textStyle } from "../components/theme";
import { control, space, weight } from "../components/tokens";
import { uiText } from "../i18n";
import { Button } from "./button";
import { Modal } from "./dialog";
import { Field } from "./input";
import { Label } from "./text";

/**
 * Unified confirmation dialog: compact right-aligned footer on desktop/tablet, bottom sheet with
 * full-width stacked actions on phone. Supports `danger` or `primary` confirm tones, `busy`
 * non-dismissible state, inline error text, and extra body content.
 */
export function ConfirmDialog(props: {
  title: string;
  description?: string;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger" | "plain";
  phone: boolean;
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  modalFocus?: boolean;
  children?: JSX.Element;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const body = () => (
    <>
      <If when={props.description}>
        <Label variant="small" tone="muted">
          {props.description}
        </Label>
      </If>
      {props.children}
      <If when={props.error}>
        <Label variant="small" tone="red">
          {props.error}
        </Label>
      </If>
    </>
  );
  return (
    <Modal
      title={props.title}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      overPhoneNavigation
      hideHeader={props.phone}
      compact={!props.phone}
      titleWeight={weight.regular}
      modalFocus={props.modalFocus}
      dismissible={!props.busy}
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
                label={props.cancelLabel ?? uiText("cancel")}
                size={control.md}
                disabled={props.busy}
                onPress={props.onClose}
              />
              <Button
                label={props.confirmLabel}
                tone={props.tone ?? "primary"}
                size={control.md}
                disabled={props.disabled}
                busy={props.busy}
                onPress={props.onConfirm}
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
            {props.title}
          </Label>
        </View>
        <View style={{ paddingHorizontal: space[16], gap: space[8] }}>
          {body()}
        </View>
        <View style={{ padding: space[16], gap: space[8] }}>
          <Button
            label={props.confirmLabel}
            tone={props.tone ?? "primary"}
            size={control.touch}
            disabled={props.disabled}
            busy={props.busy}
            onPress={props.onConfirm}
          />
          <Button
            label={props.cancelLabel ?? uiText("cancel")}
            size={control.touch}
            disabled={props.busy}
            onPress={props.onClose}
          />
        </View>
      </If>
    </Modal>
  );
}

/**
 * A small dialog with one field and Cancel / Save, such as renaming a machine or a group. Off
 * phones it is a compact dialog; on a phone it is a bottom sheet with full-width Save and Cancel.
 */
export function FieldDialog(props: {
  title: string;
  label: string;
  value: string;
  phone: boolean;
  busy: boolean;
  valid: boolean;
  saveLabel?: string;
  description?: JSX.Element;
  /** Why the last save was refused, under the field. */
  error?: string;
  /** The field opens with its value selected, to be typed over. */
  selectAll?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const c = colors();
  const type = textFaces();
  const field = () => (
    <Field
      label={props.label}
      value={props.value}
      onChange={props.onChange}
      onSubmit={props.onSave}
      inputRef={(node) =>
        setTimeout(() => {
          node.focus();
          if (props.selectAll) node.setSelection(0, props.value.length);
        }, 50)
      }
      style={{
        height: props.phone ? control.touch : control.lg,
        ...textStyle(type("small")),
        paddingHorizontal: space[12],
        borderColor: props.error ? c().red : c().strong,
      }}
    />
  );
  const error = () => (
    <If when={props.error}>
      <Label variant="small" tone="red">
        {props.error}
      </Label>
    </If>
  );
  return (
    <Modal
      title={props.title}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      compact={!props.phone}
      titleWeight={weight.regular}
      overPhoneNavigation
      dismissible={!props.busy}
      onClose={props.onClose}
    >
      <If
        when={props.phone}
        else={
          <>
            <View style={{ paddingTop: space[12], gap: space[8] }}>
              {props.description}
              {field()}
              {error()}
            </View>
            <View
              style={{
                ...row,
                justifyContent: "flex-end",
                gap: space[8],
                paddingTop: space[20],
              }}
            >
              <Button
                label={uiText("cancel")}
                size={control.md}
                style={{ paddingHorizontal: space[8] }}
                disabled={props.busy}
                onPress={props.onClose}
              />
              <Button
                label={props.saveLabel ?? uiText("save")}
                tone="primary"
                size={control.md}
                style={{ paddingHorizontal: space[8] }}
                disabled={!props.valid}
                busy={props.busy}
                onPress={props.onSave}
              />
            </View>
          </>
        }
      >
        <View
          style={{
            paddingHorizontal: space[16],
            paddingTop: space[12],
            gap: space[8],
          }}
        >
          {props.description}
          {field()}
          {error()}
        </View>
        <View style={{ padding: space[16], gap: space[8] }}>
          <Button
            label={props.saveLabel ?? uiText("save")}
            tone="primary"
            size={control.touch}
            disabled={!props.valid}
            busy={props.busy}
            onPress={props.onSave}
          />
          <Button
            label={uiText("cancel")}
            size={control.touch}
            disabled={props.busy}
            onPress={props.onClose}
          />
        </View>
      </If>
    </Modal>
  );
}
