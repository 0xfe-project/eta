import type { StoredTask, TaskStatus } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, colors, Field, Label, Modal, row } from "../../components";
import { uiText } from "../../i18n";
import { follow, useHost } from "../../services/host";

const statuses: Record<
  TaskStatus,
  { mark: string; label: Parameters<typeof uiText>[0]; next: TaskStatus }
> = {
  pending: { mark: "·", label: "pending", next: "in_progress" },
  in_progress: { mark: "▸", label: "taskInProgress", next: "completed" },
  completed: { mark: "✓", label: "taskCompleted", next: "cancelled" },
  cancelled: { mark: "×", label: "taskCancelled", next: "pending" },
};

export function MemberStepsToggle(props: {
  session: string;
  open: boolean;
  onToggle: () => void;
}) {
  const host = useHost();
  const target = () => `sessions.${props.session}`;
  follow(target);
  const steps = () => host.list<StoredTask>(target(), "tasks");
  const count = () =>
    steps().filter((step) => step.status === "completed").length;
  const c = colors();
  return (
    <View
      role="button"
      accessibilityState={{ expanded: props.open }}
      onPress={props.onToggle}
      focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
      hoverStyle={{ backgroundColor: c().selected }}
      style={{
        ...row,
        height: 24,
        paddingHorizontal: 8,
        flexShrink: 0,
        borderWidth: 1,
        borderColor: props.open ? c().ink : c().border,
        backgroundColor: c().canvas,
        cursor: "pointer",
      }}
    >
      <Label variant="caption" tone={props.open ? "ink" : "muted"}>
        {uiText("stepCount", { completed: count(), total: steps().length })}
      </Label>
    </View>
  );
}

export function MemberStepsLedger(props: { session: string; phone: boolean }) {
  const host = useHost();
  const c = colors();
  const target = () => `sessions.${props.session}`;
  const steps = () => host.section<StoredTask[]>(target(), "tasks");
  const online = () => host.state().status === "open";
  const busy = signal("");
  const error = signal("");
  const editing = signal<StoredTask>();
  const removing = signal<StoredTask>();
  const content = signal("");
  const status = signal<TaskStatus>("pending");

  async function apply(
    id: string,
    action: "taskUpdate" | "taskRemove",
    patch = {},
  ) {
    if (busy() || !online()) return false;
    busy.set(id);
    error.set("");
    try {
      await host.call("sessions", action, {
        session: props.session,
        id,
        ...patch,
      });
      return true;
    } catch (problem) {
      error.set(problem instanceof Error ? problem.message : String(problem));
      return false;
    } finally {
      busy.set("");
    }
  }

  function edit(step: StoredTask) {
    content.set(step.content);
    status.set(step.status);
    editing.set(step);
  }

  const disabled = () => !online() || !!busy();
  return (
    <View
      style={{
        paddingHorizontal: 12,
        paddingVertical: 4,
        backgroundColor: c().surface,
      }}
    >
      <If when={!online()}>
        <View style={{ ...row, gap: 8 }}>
          <Label variant="caption" tone="muted" style={{ flex: 1 }}>
            {uiText("runReconnectStatus")}
          </Label>
          <Button
            label={uiText("retry")}
            tone="ghost"
            onPress={host.reconnect}
          />
        </View>
      </If>
      <If
        when={!!steps()?.length}
        else={
          <Label variant="small" tone="muted" style={{ paddingVertical: 3 }}>
            {host.state().missing[target()]
              ? uiText("sessionUnavailable")
              : !steps()
                ? online()
                  ? uiText("stepLoading")
                  : uiText("offlineRunSteps")
                : uiText("noRunSteps")}
          </Label>
        }
      >
        <Each of={steps() ?? []} key={(step) => step.id}>
          {(step) => (
            <View style={{ ...row, height: 24, gap: 6 }}>
              <View
                role="button"
                accessibilityLabel={`${uiText(statuses[step().status].label)} · ${step().content}`}
                disabled={disabled()}
                onPress={() =>
                  void apply(step().id, "taskUpdate", {
                    status: statuses[step().status].next,
                  })
                }
                hoverStyle={{ backgroundColor: c().selected }}
                focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
                style={{
                  ...row,
                  justifyContent: "center",
                  width: 15,
                  height: 15,
                  borderWidth: 1,
                  borderColor: c().border,
                  backgroundColor: c().canvas,
                  cursor: "pointer",
                }}
              >
                <Label variant="caption">{statuses[step().status].mark}</Label>
              </View>
              <View
                role="button"
                accessibilityLabel={uiText("stepEditContent", {
                  content: step().content,
                })}
                disabled={disabled()}
                onPress={() => edit(step())}
                hoverStyle={{ backgroundColor: c().selected }}
                focusVisibleStyle={{ outlineWidth: 1, outlineColor: c().blue }}
                style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
              >
                <Label variant="small" lines={1}>
                  {step().content}
                </Label>
              </View>
              <Button
                label={uiText("stepRemoveContent", { content: step().content })}
                icon="close"
                iconOnly
                size={18}
                tone="ghost"
                disabled={disabled()}
                onPress={() => removing.set(step())}
              />
            </View>
          )}
        </Each>
      </If>
      <If when={error() && !editing() && !removing()}>
        <Label variant="caption" tone="red">
          {error()}
        </Label>
      </If>
      <If when={editing()}>
        {(step) => (
          <Modal
            title={uiText("editStep")}
            width={420}
            phone={props.phone}
            overPhoneNavigation
            onClose={() => {
              if (!busy()) editing.set(undefined);
            }}
          >
            <View style={{ padding: 14, gap: 10 }}>
              <Field
                label={uiText("stepField")}
                value={content()}
                onChange={content.set}
              />
              <View style={{ ...row, flexWrap: "wrap", gap: 4 }}>
                <Each
                  of={Object.keys(statuses) as TaskStatus[]}
                  key={(value) => value}
                >
                  {(value) => (
                    <Button
                      label={uiText(statuses[value()].label)}
                      selected={status() === value()}
                      onPress={() => status.set(value())}
                    />
                  )}
                </Each>
              </View>
              <If when={error() || !online()}>
                <Label variant="caption" tone="red">
                  {error() || uiText("stepConnectToSave")}
                </Label>
              </If>
              <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
                <Button
                  label={uiText("cancel")}
                  disabled={!!busy()}
                  onPress={() => {
                    editing.set(undefined);
                    error.set("");
                  }}
                />
                <Button
                  label={uiText("save")}
                  tone="primary"
                  disabled={disabled() || !content().trim()}
                  onPress={() =>
                    void apply(step().id, "taskUpdate", {
                      content: content().trim(),
                      status: status(),
                    }).then((saved) => {
                      if (saved) editing.set(undefined);
                    })
                  }
                />
              </View>
            </View>
          </Modal>
        )}
      </If>
      <If when={removing()}>
        {(step) => (
          <Modal
            title={uiText("removeStep")}
            width={380}
            phone={props.phone}
            overPhoneNavigation
            onClose={() => {
              if (!busy()) removing.set(undefined);
            }}
          >
            <View style={{ padding: 14, gap: 10 }}>
              <Label>{step().content}</Label>
              <If when={error() || !online()}>
                <Label variant="caption" tone="red">
                  {error() || uiText("stepConnectToRemove")}
                </Label>
              </If>
              <View style={{ ...row, justifyContent: "flex-end", gap: 8 }}>
                <Button
                  label={uiText("cancel")}
                  disabled={!!busy()}
                  onPress={() => {
                    removing.set(undefined);
                    error.set("");
                  }}
                />
                <Button
                  label={uiText("remove2")}
                  tone="danger"
                  disabled={disabled()}
                  onPress={() =>
                    void apply(step().id, "taskRemove").then((removed) => {
                      if (removed) removing.set(undefined);
                    })
                  }
                />
              </View>
            </View>
          </Modal>
        )}
      </If>
    </View>
  );
}
