import type {
  PluginAgentLevel,
  PluginFieldView,
  PluginResults,
  PluginValue,
  PluginView,
} from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  colors,
  dialogWidth,
  Field,
  fill,
  grow,
  Label,
  Modal,
  NativeDialog,
  row,
  SmoothScroll,
  textFaces,
  textStyle,
} from "../../components";
import { CloseButton } from "../../components/navigation-buttons";
import { startProgress } from "../../components/progress-notification";
import { ToggleSwitch } from "../../components/toggle-switch";
import {
  control,
  icon,
  opacity,
  shadow,
  sizes,
  space,
  weight,
} from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { pluginConfigText, PluginSelect } from "./config-fields";

/** How much of the window the configure dialog may take. */
const dialogMaxWidth = "90%";
const dialogMaxHeight = "92%";

/** A phone bottom sheet's edge: one strong rule along its top only. */
export const sheetEdge = {
  borderWidth: 0,
  borderLeftWidth: 0,
  borderTopWidth: 1,
};

export function AddPlugin(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const repo = signal("");
  const rev = signal("");
  const path = signal("");
  const busy = signal(false);
  const submit = async () => {
    const repoValue = repo().trim();
    if (busy() || !repoValue) return;
    busy.set(true);
    const progress = startProgress({
      id: `plugin-add-${repoValue}`,
      icon: "plugins",
      title: uiText("addPluginTitle"),
      detail: repoValue,
    });
    try {
      await host.call("plugins", "add", {
        repo: repoValue,
        rev: rev().trim() || undefined,
        path: path().trim() || undefined,
      });
      progress.complete({
        title: uiText("addPluginTitle"),
        detail: repoValue,
      });
      props.onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      host.error.set(message);
      progress.fail({
        title: uiText("addPluginTitle"),
        detail: message,
      });
    } finally {
      busy.set(false);
    }
  };
  // Placeholder-only fields, the first one focused, as the design draws them.
  const field = (
    label: string,
    value: () => string,
    onChange: (value: string) => void,
    first = false,
  ) => (
    <Field
      label={label}
      placeholder={label}
      value={value()}
      autoFocus={first && !props.phone}
      compact
      onSubmit={() => void submit()}
      onChange={onChange}
      style={
        props.phone
          ? { height: space[40], paddingHorizontal: space[12] }
          : undefined
      }
    />
  );
  return (
    <Modal
      title={uiText("addPluginTitle")}
      phone={props.phone}
      sheet={props.phone}
      plainSheetHeader={props.phone}
      panelStyle={props.phone ? sheetEdge : undefined}
      overPhoneNavigation={props.phone}
      compact={!props.phone}
      titleWeight={weight.regular}
      width={dialogWidth.lg}
      onClose={props.onClose}
    >
      {/* Phone: a bottom sheet with 14/20 copy, 40pt fields 10pt apart and a
          full-width 44pt Add. */}
      <View
        style={
          props.phone
            ? { paddingHorizontal: space[16], paddingBottom: space[24] }
            : undefined
        }
      >
        <Label
          variant="small"
          tone="muted"
          style={props.phone ? undefined : { paddingTop: space[8] }}
        >
          {uiText("addPluginDescription")}
        </Label>
        <View
          style={{
            gap: props.phone ? space[8] : space[12],
            paddingTop: space[16],
          }}
        >
          {field(uiText("repository"), repo, repo.set, true)}
          {field(uiText("branchTagOrCommit"), rev, rev.set)}
          {field(uiText("directoryInTheRepositoryOptional"), path, path.set)}
        </View>
        <View
          style={{
            ...row,
            justifyContent: "flex-end",
            paddingTop: props.phone ? space[16] : space[20],
          }}
        >
          <Button
            label={uiText("addPluginSubmit")}
            tone="primary"
            size={props.phone ? control.touch : control.md}
            labelWeight={props.phone ? weight.regular : undefined}
            dimDisabled={false}
            style={{
              opacity: !repo().trim() ? opacity.disabled : 1,
              ...(props.phone ? { flex: 1 } : {}),
            }}
            disabled={!repo().trim()}
            busy={busy()}
            onPress={() => void submit()}
          />
        </View>
      </View>
    </Modal>
  );
}

export function ConfigurePlugin(props: {
  item: PluginView;
  phone: boolean;
  tablet: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const values = signal<Record<string, PluginValue | null>>({});
  const numberInput = signal<Record<string, string>>({});
  const issues = signal<PluginResults["configure"]["issues"]>([]);
  const busy = signal(false);
  const accessBusy = signal(false);
  async function setLevel(field: PluginFieldView, level: PluginAgentLevel) {
    if (busy() || accessBusy() || !field.levels.includes(level)) return;
    accessBusy.set(true);
    try {
      await host.action(() =>
        host.call("plugins", "setLevel", {
          name: props.item.name,
          field: field.name,
          level,
        }),
      );
    } finally {
      accessBusy.set(false);
    }
  }
  const valueOf = (field: PluginFieldView) =>
    Object.hasOwn(values(), field.name)
      ? values()[field.name]
      : (field.value ?? field.default ?? null);
  const set = (key: string, value: PluginValue | null) => {
    values.update((previous) => ({ ...previous, [key]: value }));
    issues.update((previous) =>
      previous.filter((issue) => issue.field !== key),
    );
  };
  function numericIssue(field: PluginFieldView) {
    if (field.type !== "number" || !Object.hasOwn(numberInput(), field.name))
      return "";
    const text = numberInput()[field.name]?.trim();
    if (!text) return field.required ? "Enter a value." : "";
    const value = Number(text);
    if (!Number.isFinite(value)) return uiText("pluginNumberRequired");
    if (field.int && !Number.isInteger(value))
      return uiText("pluginWholeNumberRequired");
    if (field.min !== undefined && value < field.min)
      return uiText("pluginBelowMinimum", { value: field.min });
    if (field.max !== undefined && value > field.max)
      return uiText("pluginAboveMaximum", { value: field.max });
    return "";
  }
  async function submit() {
    if (busy() || accessBusy() || props.item.fields.some(numericIssue)) return;
    busy.set(true);
    const payload = { ...values() };
    for (const [key, text] of Object.entries(numberInput()))
      payload[key] = text.trim() ? Number(text) : null;
    const result = await host.action(() =>
      host.call<PluginResults["configure"]>("plugins", "configure", {
        name: props.item.name,
        values: payload,
      }),
    );
    busy.set(false);
    if (!result) return;
    issues.set(result.issues);
    if (result.state === "ready") props.onClose();
  }
  const title = () => uiText("configureWithCount", { name: props.item.name });
  const compactField = () => ({
    height: control.md,
    ...textStyle(type("small")),
    borderColor: c().strong,
    placeholderColor: c().faint,
  });
  const phoneField = () => ({
    height: space[40],
    ...textStyle(type("small")),
    paddingHorizontal: space[12],
    borderColor: c().strong,
  });
  const form = () => (
    <>
      <SmoothScroll
        // The dialog fits its fields and scrolls only once it reaches its height cap.
        style={props.phone ? grow : { flexShrink: 1, minHeight: 0 }}
      >
        <View
          style={
            props.phone
              ? { padding: space[16], gap: space[16] }
              : {
                  paddingHorizontal: space[16],
                  paddingTop: space[4],
                  paddingBottom: space[16],
                  gap: space[16],
                }
          }
        >
          <If when={props.phone}>
            <Label variant="small" tone="muted">
              {pluginConfigText("fields")}
            </Label>
          </If>
          <Each of={props.item.fields} key={(field) => field.name}>
            {(field) => {
              const item = () => field();
              const value = () => valueOf(item());
              return (
                <View style={{ gap: space[4] }}>
                  <If when={item().type !== "boolean"}>
                    <View
                      style={{
                        ...row,
                        alignItems: "baseline",
                        gap: props.phone ? space[8] : space[4],
                      }}
                    >
                      <Label variant="small">{item().title}</Label>
                      <Label variant="caption" tone="muted">
                        {pluginConfigText(
                          item().required
                            ? "required"
                            : props.phone
                              ? "optionalTag"
                              : "optional",
                        )}
                      </Label>
                    </View>
                  </If>
                  <If when={item().description && item().type !== "boolean"}>
                    <Label variant="caption" tone="muted">
                      {item().description}
                    </Label>
                  </If>
                  <If
                    when={item().type === "select"}
                    else={
                      <If
                        when={item().type === "boolean"}
                        else={
                          <Field
                            label={item().title}
                            style={props.phone ? phoneField() : compactField()}
                            masked={item().secret}
                            placeholder={
                              item().secret &&
                              item().set &&
                              !Object.hasOwn(values(), item().name)
                                ? uiText("valueSaved")
                                : ""
                            }
                            value={
                              item().type === "number" &&
                              Object.hasOwn(numberInput(), item().name)
                                ? (numberInput()[item().name] ?? "")
                                : String(value() ?? "")
                            }
                            onChange={(text) => {
                              if (item().type === "number") {
                                numberInput.update((previous) => ({
                                  ...previous,
                                  [item().name]: text,
                                }));
                                issues.update((previous) =>
                                  previous.filter(
                                    (issue) => issue.field !== item().name,
                                  ),
                                );
                              } else
                                set(item().name, text === "" ? null : text);
                            }}
                          />
                        }
                      >
                        <View
                          style={{
                            ...row,
                            gap: props.phone ? space[12] : space[8],
                          }}
                        >
                          <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
                            <Label variant="small">{item().title}</Label>
                            <If when={item().description}>
                              <Label variant="caption" tone="muted">
                                {item().description}
                              </Label>
                            </If>
                          </View>
                          <ToggleSwitch
                            label={item().title}
                            checked={value() === true}
                            compact
                            disabled={busy()}
                            onChange={(checked) => set(item().name, checked)}
                          />
                        </View>
                      </If>
                    }
                  >
                    <If
                      when={
                        item().type === "select"
                          ? (item() as Extract<
                              PluginFieldView,
                              { type: "select" }
                            >)
                          : undefined
                      }
                    >
                      {(spec) => (
                        <If
                          when={spec().multiple}
                          else={
                            <PluginSelect
                              label={spec().title}
                              items={spec().options.map((option) => ({
                                value: option.value,
                                title: option.label,
                              }))}
                              value={
                                typeof value() === "string"
                                  ? String(value())
                                  : null
                              }
                              disabled={busy()}
                              phone={props.phone}
                              onChange={(next) => set(spec().name, next)}
                            />
                          }
                        >
                          <View
                            style={{ ...row, gap: space[4], flexWrap: "wrap" }}
                          >
                            <Each
                              of={spec().options}
                              key={(choice) => choice.value}
                            >
                              {(choice) => (
                                <Button
                                  label={choice().label}
                                  selected={
                                    Array.isArray(value()) &&
                                    (value() as string[]).includes(
                                      choice().value,
                                    )
                                  }
                                  onPress={() => {
                                    const current = value();
                                    const picked = Array.isArray(current)
                                      ? current
                                      : [];
                                    set(
                                      spec().name,
                                      picked.includes(choice().value)
                                        ? picked.filter(
                                            (option) =>
                                              option !== choice().value,
                                          )
                                        : [...picked, choice().value],
                                    );
                                  }}
                                />
                              )}
                            </Each>
                          </View>
                        </If>
                      )}
                    </If>
                    <If
                      when={
                        !item().required &&
                        Boolean(value()) &&
                        Object.hasOwn(values(), item().name)
                      }
                    >
                      <Button
                        label={uiText("clear")}
                        tone="ghost"
                        style={{ alignSelf: "flex-start" }}
                        onPress={() => set(item().name, null)}
                      />
                    </If>
                  </If>
                  <If when={item().secret}>
                    <View style={{ ...row, gap: space[8] }}>
                      <Label
                        variant="small"
                        tone={props.phone ? "muted" : "mutedInk"}
                      >
                        {pluginConfigText("access")}
                      </Label>
                      <If
                        when={
                          item().levels.length > 1 &&
                          host.can("plugins.setLevel")
                        }
                        else={
                          <Label variant="caption" tone="muted">
                            {pluginConfigText(item().level)}
                          </Label>
                        }
                      >
                        <PluginSelect
                          label={pluginConfigText("access")}
                          items={item().levels.map((level) => ({
                            value: level,
                            title: pluginConfigText(level),
                          }))}
                          value={item().level}
                          compact
                          phone={props.phone}
                          disabled={accessBusy() || busy()}
                          onChange={(next) =>
                            void setLevel(item(), next as PluginAgentLevel)
                          }
                        />
                      </If>
                    </View>
                  </If>
                  <If
                    when={
                      item().secret &&
                      !item().required &&
                      item().set &&
                      !Object.hasOwn(values(), item().name)
                    }
                  >
                    <Button
                      label={uiText("clearSaved", { title: item().title })}
                      tone="ghost"
                      style={{ alignSelf: "flex-start" }}
                      onPress={() => set(item().name, null)}
                    />
                  </If>
                  <If
                    when={
                      numericIssue(item()) ||
                      issues().some((issue) => issue.field === item().name)
                    }
                  >
                    <Label variant="caption" tone="red">
                      {numericIssue(item()) ||
                        uiText("checkThisValueAgainstThePlugins")}
                    </Label>
                  </If>
                </View>
              );
            }}
          </Each>
          <Label variant="caption" tone="muted">
            {pluginConfigText("encrypted")}
          </Label>
        </View>
      </SmoothScroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingVertical: space[12],
          paddingHorizontal: space[16],
          gap: props.phone ? space[12] : space[8],
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={props.item.state === "needs_config"}>
          <Label variant="small" tone="muted" style={{ flex: 1 }}>
            {pluginConfigText("missing")}
          </Label>
        </If>
        <Button
          label={uiText("save")}
          tone="primary"
          size={props.phone ? control.touch : undefined}
          labelVariant="caption"
          style={{ paddingHorizontal: props.phone ? space[20] : space[12] }}
          disabled={
            accessBusy() ||
            props.item.fields.some(numericIssue) ||
            !(Object.keys(values()).length || Object.keys(numberInput()).length)
          }
          busy={busy()}
          onPress={() => void submit()}
        />
      </View>
    </>
  );
  return (
    <If
      when={!props.phone}
      else={
        <Modal
          title={title()}
          phone
          phonePage
          height="100%"
          onClose={props.onClose}
        >
          {form()}
        </Modal>
      }
    >
      <NativeDialog
        accessibilityLabel={title()}
        animation="none"
        // The same dialog on both: below the tablet header, centred on desktop.
        style={{
          ...fill,
          alignItems: "center",
          ...(props.tablet
            ? { paddingTop: sizes.header + space[16] }
            : { justifyContent: "center", paddingVertical: space[24] }),
        }}
        backdropStyle={{
          backgroundColor: props.tablet ? c().sheetScrim : c().scrim,
        }}
        onOpenChange={({ open }) => {
          if (!open) props.onClose();
        }}
      >
        <View
          role="dialog"
          accessibilityLabel={title()}
          style={{
            width: dialogWidth.lg,
            maxWidth: dialogMaxWidth,
            maxHeight: dialogMaxHeight,
            backgroundColor: c().canvas,
            borderWidth: 1,
            borderColor: c().strong,
            boxShadow: [shadow.popover],
          }}
        >
          <View
            style={{
              ...row,
              alignItems: "flex-start",
              gap: space[12],
              paddingHorizontal: space[16],
              paddingTop: space[16],
              paddingBottom: space[12],
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
              <Label weight={weight.strong}>{title()}</Label>
              <Label variant="small" tone="muted">
                {pluginConfigText("fields")}
              </Label>
            </View>
            <CloseButton onPress={props.onClose} iconSize={icon.md} />
          </View>
          {form()}
        </View>
      </NativeDialog>
    </If>
  );
}
