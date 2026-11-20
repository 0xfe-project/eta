import type {
  PluginAgentLevel,
  PluginFieldView,
  PluginResults,
  PluginValue,
  PluginView,
} from "@eta/client-contracts";
import { Scroll, signal, View } from "nsh";
import { Dialog } from "nsh/base";
import {
  Button,
  colors,
  Field,
  fill,
  grow,
  Label,
  Modal,
  row,
} from "../../components";
import { CloseButton } from "../../components/navigation-buttons";
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { pluginConfigText, PluginSelect } from "./config-fields";

export function AddPlugin(props: { phone: boolean; onClose: () => void }) {
  const host = useHost();
  const repo = signal("");
  const rev = signal("");
  const path = signal("");
  const busy = signal(false);
  return (
    <Modal
      title={uiText("addFromGit")}
      phone={props.phone}
      onClose={props.onClose}
    >
      <View style={{ padding: 16, gap: 8 }}>
        <Field
          label={uiText("repository")}
          placeholder={uiText("gitRepositoryUrl")}
          value={repo()}
          onChange={repo.set}
        />
        <Field
          label={uiText("revision")}
          placeholder={uiText("branchTagOrCommit")}
          value={rev()}
          onChange={rev.set}
        />
        <Field
          label={uiText("pluginPath")}
          placeholder={uiText("directoryInTheRepositoryOptional")}
          value={path()}
          onChange={path.set}
        />
        <Button
          label={busy() ? uiText("adding") : uiText("addPlugin")}
          tone="primary"
          disabled={!repo().trim() || busy()}
          onPress={() =>
            void (async () => {
              if (busy()) return;
              busy.set(true);
              const result = await host.action(() =>
                host.call("plugins", "add", {
                  repo: repo().trim(),
                  rev: rev().trim() || undefined,
                  path: path().trim() || undefined,
                }),
              );
              busy.set(false);
              if (result) props.onClose();
            })()
          }
        />
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
    height: 28,
    fontSize: 12,
    lineHeight: 16,
    borderColor: c().strong,
    placeholderColor: c().faint,
  });
  const phoneField = () => ({
    height: 40,
    fontSize: 13,
    lineHeight: 18,
    paddingHorizontal: 10,
    borderColor: c().strong,
  });
  const form = () => (
    <>
      <Scroll
        // The tablet dialog fits its fields and scrolls only once it reaches its height cap.
        style={props.tablet ? { flexShrink: 1, minHeight: 0 } : grow}
      >
        <View
          style={
            props.tablet
              ? {
                  paddingHorizontal: 16,
                  paddingTop: 4,
                  paddingBottom: 16,
                  gap: 16,
                }
              : { padding: 16, gap: props.phone ? 18 : 16 }
          }
        >
          <If when={!props.tablet}>
            <Label size={12} line={props.phone ? 16 : 18} tone="muted">
              {pluginConfigText("fields")}
            </Label>
          </If>
          <Each of={props.item.fields} key={(field) => field.name}>
            {(field) => {
              const item = () => field();
              const value = () => valueOf(item());
              return (
                <View style={{ gap: 6 }}>
                  <If when={item().type !== "boolean"}>
                    <View
                      style={{
                        ...row,
                        alignItems: "baseline",
                        gap: props.phone ? 8 : 6,
                      }}
                    >
                      <Label
                        size={props.phone ? 13 : 12}
                        line={props.phone ? 18 : 16}
                      >
                        {item().title}
                      </Label>
                      <Label
                        size={props.phone ? 11 : 10}
                        line={14}
                        tone="muted"
                      >
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
                    <Label size={11} tone="muted">
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
                        <View style={{ ...row, gap: props.phone ? 12 : 10 }}>
                          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                            <Label
                              size={props.phone ? 13 : 12}
                              line={props.phone ? 18 : 16}
                            >
                              {item().title}
                            </Label>
                            <If when={item().description}>
                              <Label
                                size={props.phone ? 11 : 10}
                                line={14}
                                tone="muted"
                              >
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
                          <View style={{ ...row, gap: 6, flexWrap: "wrap" }}>
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
                    <View style={{ ...row, gap: 8 }}>
                      <Label
                        size={11}
                        line={props.phone ? 14 : 16}
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
                          <Label size={11} tone="muted">
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
                    <Label size={11} tone="red">
                      {numericIssue(item()) ||
                        uiText("checkThisValueAgainstThePlugins")}
                    </Label>
                  </If>
                </View>
              );
            }}
          </Each>
          <Label
            size={props.phone ? 11 : 10}
            line={props.phone ? 15 : 14}
            tone="muted"
          >
            {pluginConfigText("encrypted")}
          </Label>
        </View>
      </Scroll>
      <View
        style={{
          ...row,
          justifyContent: "flex-end",
          paddingVertical: 12,
          paddingHorizontal: 16,
          gap: props.phone ? 12 : 10,
          borderTopWidth: 1,
          borderColor: c().border,
        }}
      >
        <If when={props.item.state === "needs_config"}>
          <Label
            size={11}
            line={props.phone ? 14 : 16}
            tone="muted"
            style={{ flex: 1 }}
          >
            {pluginConfigText("missing")}
          </Label>
        </If>
        <Button
          label={uiText("save")}
          tone="primary"
          size={props.phone ? 36 : undefined}
          labelSize={props.phone ? 13 : 11}
          style={{ paddingHorizontal: props.phone ? 20 : 10 }}
          disabled={
            busy() ||
            accessBusy() ||
            props.item.fields.some(numericIssue) ||
            !(Object.keys(values()).length || Object.keys(numberInput()).length)
          }
          onPress={() => void submit()}
        />
      </View>
    </>
  );
  return (
    <If
      when={props.tablet}
      else={
        <Modal
          title={title()}
          phone={props.phone}
          phonePage={props.phone}
          height={props.phone ? "100%" : 480}
          onClose={props.onClose}
        >
          {form()}
        </Modal>
      }
    >
      <Dialog
        accessibilityLabel={title()}
        animation="none"
        style={{ ...fill, paddingTop: 56, alignItems: "center" }}
        backdropStyle={{ backgroundColor: c().sheetShade }}
        onOpenChange={({ open }) => {
          if (!open) props.onClose();
        }}
      >
        <View
          role="dialog"
          accessibilityLabel={title()}
          style={{
            width: 580,
            maxWidth: "90%",
            maxHeight: "92%",
            backgroundColor: c().canvas,
            borderWidth: 1,
            borderColor: c().strong,
            boxShadow: [{ x: 0, y: 8, blur: 24, color: "#0000001f" }],
          }}
        >
          <View
            style={{
              ...row,
              alignItems: "flex-start",
              gap: 12,
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 12,
            }}
          >
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Label size={14} line={20} weight={600}>
                {title()}
              </Label>
              <Label size={12} line={16} tone="muted">
                {pluginConfigText("fields")}
              </Label>
            </View>
            <CloseButton onPress={props.onClose} iconSize={14} />
          </View>
          {form()}
        </View>
      </Dialog>
    </If>
  );
}
