import type { PluginHeaderView, PluginView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Caption, colors, Field, Label, row } from "../../components";
import { ToggleSwitch } from "../../components/toggle-switch";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** Names whose value is a credential: the "secret" toggle starts on for these. */
const SECRET_NAME = /authorization|key|token|secret|auth|cookie|password/i;
export const looksSecret = (name: string): boolean => SECRET_NAME.test(name);

interface Draft {
  id: number;
  name: string;
  /** What was typed; empty for a secret that is saved and left alone. */
  value: string;
  secret: boolean;
  /** A value is saved under this name already. */
  saved: boolean;
  /** The preset: what is typed is a token, sent as `Bearer <token>`. */
  bearer: boolean;
  plainOk: boolean;
}

let next = 1;
const draftOf = (header: PluginHeaderView): Draft => ({
  id: next++,
  name: header.name,
  value: header.secret ? "" : (header.value ?? ""),
  secret: header.secret,
  saved: true,
  bearer: false,
  plainOk: header.plainOk,
});

/** The request headers the user attaches to one remote server; a secret is never shown again. */
export function HeadersEditor(props: {
  item: PluginView;
  server: string;
  plainHttp: boolean;
  phone?: boolean;
}) {
  const host = useHost();
  const c = colors();
  const mine = () =>
    props.item.headers.filter((header) => header.server === props.server);
  const drafts = signal<Draft[]>(mine().map(draftOf));
  const problem = signal("");
  const off = () => !props.item.enabled;
  const patch = (id: number, change: Partial<Draft>) =>
    drafts.update((all) =>
      all.map((draft) => (draft.id === id ? { ...draft, ...change } : draft)),
    );
  const add = (name: string, bearer: boolean) =>
    drafts.update((all) => [
      ...all,
      {
        id: next++,
        name,
        value: "",
        secret: true,
        saved: false,
        bearer,
        plainOk: false,
      },
    ]);
  function save() {
    const rows = drafts();
    for (const draft of rows)
      if (draft.name.trim() === "" || (draft.value === "" && !draft.saved)) {
        problem.set(uiText("headerIncomplete"));
        return;
      }
    problem.set("");
    const headers = rows.map((draft) => ({
      name: draft.name.trim(),
      value:
        draft.value === ""
          ? null
          : draft.bearer
            ? `Bearer ${draft.value}`
            : draft.value,
      secret: draft.secret,
      plainOk: draft.plainOk,
    }));
    void host.action(async () => {
      await host.call("plugins", "setHeaders", {
        name: props.item.name,
        server: props.server,
        headers,
      });
      // What was typed is not kept: a secret reads as saved, a new value replaces it.
      drafts.update((all) =>
        all.map((draft) => ({
          ...draft,
          value: draft.secret ? "" : draft.value,
          saved: true,
          bearer: false,
        })),
      );
    });
  }
  return (
    <View style={{ gap: 6, paddingTop: 6, opacity: off() ? 0.5 : 1 }}>
      <Caption text={uiText("headersTitle", { name: props.server })} phone={props.phone} />
      <Label variant="caption" tone="muted">
        {off() ? uiText("headersOff") : uiText("headersHint")}
      </Label>
      <Each of={drafts()} key={(draft) => draft.id}>
        {(draft) => (
          <View style={{ gap: 4 }}>
            <View style={{ ...row, gap: 6 }}>
              <View style={{ flex: 1 }}>
                <Field
                  label={uiText("headerName")}
                  value={draft().name}
                  placeholder={uiText("headerName")}
                  onChange={(name) =>
                    patch(draft().id, {
                      name,
                      ...(draft().saved ? {} : { secret: looksSecret(name) }),
                    })
                  }
                />
              </View>
              <View style={{ flex: 2 }}>
                <Field
                  label={uiText("headerValue")}
                  value={draft().value}
                  masked={draft().secret}
                  placeholder={
                    draft().secret && draft().saved && draft().value === ""
                      ? uiText("valueSaved")
                      : draft().bearer
                        ? uiText("headerToken")
                        : uiText("headerValue")
                  }
                  onChange={(value) => patch(draft().id, { value })}
                />
              </View>
              <Button
                label={uiText("headerRemove")}
                tone="ghost"
                labelVariant="caption"
                disabled={off()}
                onPress={() =>
                  drafts.update((all) =>
                    all.filter((other) => other.id !== draft().id),
                  )
                }
              />
            </View>
            <View style={{ ...row, gap: 8 }}>
              <ToggleSwitch
                label={uiText("headerSecret")}
                checked={draft().secret}
                onChange={(secret) => patch(draft().id, { secret })}
              />
              <Label variant="caption" tone="muted">
                {uiText("headerSecret")}
              </Label>
              <If when={props.plainHttp}>
                <ToggleSwitch
                  label={uiText("headerPlainOk")}
                  checked={draft().plainOk}
                  onChange={(plainOk) => patch(draft().id, { plainOk })}
                />
                <Label variant="caption" tone="muted">
                  {uiText("headerPlainOk")}
                </Label>
              </If>
            </View>
          </View>
        )}
      </Each>
      <If when={problem()}>
        <Label variant="caption" style={{ color: c().red }}>
          {problem()}
        </Label>
      </If>
      <View style={{ ...row, gap: 8, flexWrap: "wrap" }}>
        <Button
          label={uiText("headerAddBearer")}
          tone="plain"
          labelVariant="caption"
          disabled={off()}
          onPress={() => add("Authorization", true)}
        />
        <Button
          label={uiText("headerAddCustom")}
          tone="plain"
          labelVariant="caption"
          disabled={off()}
          onPress={() => add("", false)}
        />
        <Button
          label={uiText("headerSave")}
          tone="primary"
          labelVariant="caption"
          disabled={off()}
          onPress={save}
        />
      </View>
    </View>
  );
}
