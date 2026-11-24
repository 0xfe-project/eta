import type { PluginEnvView, PluginView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, colors, Field, Label, row, textFaces } from "../../components";
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

import { looksSecret } from "./headers-model";
import { opacity, space, weight } from "../../components/tokens";

interface Draft {
  id: number;
  name: string;
  /** What was typed; empty for a secret that is saved and left alone. */
  value: string;
  secret: boolean;
  saved: boolean;
}

let next = 1;
const draftOf = (one: PluginEnvView): Draft => ({
  id: next++,
  name: one.name,
  value: one.secret ? "" : (one.value ?? ""),
  secret: one.secret,
  saved: true,
});

/** The environment variables the user sets on one stdio server; a secret is never shown again. */
export function EnvEditor(props: { item: PluginView; server: string }) {
  const host = useHost();
  const c = colors();
  const type = textFaces();
  const mine = () =>
    (props.item.env ?? []).filter((one) => one.server === props.server);
  const drafts = signal<Draft[]>(mine().map(draftOf));
  const problem = signal("");
  const off = () => !props.item.enabled;
  const locked = () =>
    props.item.servers.find((one) => one.name === props.server)?.lockedEnv ??
    [];
  const patch = (id: number, change: Partial<Draft>) =>
    drafts.update((all) =>
      all.map((d) => (d.id === id ? { ...d, ...change } : d)),
    );
  function save() {
    const rows = drafts();
    for (const d of rows) {
      const name = d.name.trim();
      if (
        name === "" ||
        (d.value === "" && !d.saved) ||
        locked().includes(name)
      ) {
        problem.set(
          uiText(locked().includes(name) ? "envLocked" : "envIncomplete"),
        );
        return;
      }
    }
    problem.set("");
    const env = rows.map((d) => ({
      name: d.name.trim(),
      value: d.value === "" ? null : d.value,
      secret: d.secret,
    }));
    void host.action(async () => {
      await host.call("plugins", "setEnv", {
        name: props.item.name,
        server: props.server,
        env,
      });
      drafts.update((all) =>
        all.map((d) => ({ ...d, value: d.secret ? "" : d.value, saved: true })),
      );
    });
  }
  return (
    <View style={{ gap: space[12], opacity: off() ? opacity.disabled : 1 }}>
      <View style={{ gap: space[8] }}>
        <Label variant="small" weight={weight.strong}>
          {uiText("envTitle")}
        </Label>
        <Label
          variant="small"
          tone="muted"
          style={{ lineHeight: type("small").prose }}
        >
          {off() ? uiText("envOff") : uiText("envHint")}
        </Label>
        <If when={locked().length}>
          <Label variant="small" tone="muted">
            {`${uiText("envFixed")}: ${locked().join(", ")}`}
          </Label>
        </If>
      </View>
      <Each of={drafts()} key={(d) => d.id}>
        {(d) => (
          <View style={{ ...row, gap: space[12], alignItems: "center" }}>
            <View style={{ flex: 2, minWidth: 0 }}>
              <Field
                label={uiText("envName")}
                value={d().name}
                placeholder={uiText("envName")}
                onChange={(name) =>
                  patch(d().id, {
                    name,
                    ...(d().saved ? {} : { secret: looksSecret(name) }),
                  })
                }
              />
            </View>
            <View style={{ flex: 3, minWidth: 0 }}>
              <Field
                label={uiText("headerValue")}
                value={d().value}
                masked={d().secret}
                placeholder={
                  d().secret && d().saved && d().value === ""
                    ? uiText("valueSaved")
                    : uiText("headerValue")
                }
                onChange={(value) => patch(d().id, { value })}
              />
            </View>
            <ToggleSwitch
              label={uiText("headerSecret")}
              checked={d().secret}
              onChange={(secret) => patch(d().id, { secret })}
            />
            <Button
              label={uiText("envRemove")}
              tone="ghost"
              labelVariant="small"
              disabled={off()}
              onPress={() =>
                drafts.update((all) => all.filter((o) => o.id !== d().id))
              }
            />
          </View>
        )}
      </Each>
      <If when={problem()}>
        <Label variant="small" style={{ color: c().red }}>
          {problem()}
        </Label>
      </If>
      <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
        <Button
          label={uiText("envAdd")}
          tone="plain"
          labelVariant="small"
          disabled={off()}
          onPress={() =>
            drafts.update((all) => [
              ...all,
              { id: next++, name: "", value: "", secret: false, saved: false },
            ])
          }
        />
      </View>
      <View
        style={{ ...row, justifyContent: "flex-end", paddingTop: space[4] }}
      >
        <Button
          label={uiText("envSave")}
          tone="primary"
          labelVariant="small"
          disabled={off()}
          onPress={save}
        />
      </View>
    </View>
  );
}
