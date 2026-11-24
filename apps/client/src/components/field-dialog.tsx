import type { JSX } from "nsh";
import { View } from "nsh";
import { uiText } from "../i18n";
import { Button, Field } from "./controls";
import { Modal } from "./modal";
import { Label } from "./text";
import { colors, row, textFaces, textStyle } from "./theme";
import { control, space, weight } from "./tokens";

/**
 * A small dialog with one field and Cancel / Save, such as renaming a machine or a group. Off
 * phones it is the design's 480pt dialog (14pt padding, a 14/400 title); on a phone it is a bottom
 * sheet with full-width Save and Cancel. Return saves, Escape cancels.
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
        height: props.phone ? 36 : 30,
        ...textStyle(type("small")),
        paddingHorizontal: 10,
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
                disabled={props.busy || !props.valid}
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
