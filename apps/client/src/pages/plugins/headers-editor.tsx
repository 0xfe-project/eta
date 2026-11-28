import type { PluginHeaderView, PluginView } from "@eta/client-contracts";
import { effect, signal, untracked, View } from "nsh";
import { Button, colors, Field, Label, row, textFaces } from "../../components";
import { ToggleSwitch } from "../../components/toggle-switch";
import { opacity, space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import {
  customHeaderRow,
  defaultHeaderRow,
  hasHeader,
  headerValue,
  incomplete,
  looksSecret,
} from "./headers-model";

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
  const type = textFaces();
  const mine = () =>
    (props.item.headers ?? []).filter(
      (header) => header.server === props.server,
    );
  const snapshot = () =>
    JSON.stringify(
      mine().map((header) => [
        header.name,
        header.secret,
        header.value,
        header.plainOk,
      ]),
    );
  const identity = () => `${props.item.name}\n${props.server}`;
  const drafts = signal<Draft[]>(mine().map(draftOf));
  const dirty = signal(false);
  const problem = signal("");
  const off = () => !props.item.enabled;
  let seenIdentity = identity();
  let seenSnapshot = snapshot();
  effect(() => {
    const nextIdentity = identity();
    const nextSnapshot = snapshot();
    if (nextIdentity !== seenIdentity) {
      seenIdentity = nextIdentity;
      seenSnapshot = nextSnapshot;
      untracked(() => {
        drafts.set(mine().map(draftOf));
        dirty.set(false);
        problem.set("");
      });
      return;
    }
    if (nextSnapshot !== seenSnapshot) {
      seenSnapshot = nextSnapshot;
      if (!untracked(dirty)) {
        untracked(() => {
          drafts.set(mine().map(draftOf));
        });
      }
    }
  });
  const patch = (id: number, change: Partial<Draft>) => {
    dirty.set(true);
    drafts.update((all) =>
      all.map((draft) => (draft.id === id ? { ...draft, ...change } : draft)),
    );
  };
  const add = (row: { name: string; secret: boolean; bearer: boolean }) => {
    dirty.set(true);
    drafts.update((all) => [
      ...all,
      { ...row, id: next++, value: "", saved: false, plainOk: false },
    ]);
  };
  // The plugin file may already carry an auth header; then no second Authorization row is offered.
  const declared = () =>
    props.item.servers.find((one) => one.name === props.server)?.headers ?? [];
  const hasAuthorization = () =>
    hasHeader(declared(), "Authorization") ||
    hasHeader(
      drafts().map((draft) => draft.name.trim()),
      "Authorization",
    );
  function save() {
    const rows = drafts();
    for (const draft of rows)
      if (incomplete(draft)) {
        problem.set(uiText("headerIncomplete"));
        return;
      }
    problem.set("");
    const headers = rows.map((draft) => ({
      name: draft.name.trim(),
      value: headerValue(draft.value, draft.bearer),
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
      // Preserve the "Bearer " prefix on non-secret Bearer rows so subsequent saves keep it.
      dirty.set(false);
      drafts.update((all) =>
        all.map((draft) => ({
          ...draft,
          name: draft.name.trim(),
          value: draft.secret
            ? ""
            : (headerValue(draft.value, draft.bearer) ?? draft.value),
          saved: true,
          bearer: false,
        })),
      );
    });
  }
  return (
    <View style={{ gap: space[12], opacity: off() ? opacity.disabled : 1 }}>
      <View style={{ gap: space[8] }}>
        <Label variant="small" weight={weight.strong}>
          {uiText("headersTitle")}
        </Label>
        <Label
          variant="small"
          tone="muted"
          style={{ lineHeight: type("small").prose }}
        >
          {off() ? uiText("headersOff") : uiText("headersHint")}
        </Label>
      </View>
      <Each of={drafts()} key={(draft) => draft.id}>
        {(draft) => (
          <View style={{ ...row, gap: space[12], alignItems: "center" }}>
            <View style={{ flex: 2, minWidth: 0 }}>
              <Field
                label={uiText("headerName")}
                value={draft().name}
                placeholder={uiText("headerName")}
                onChange={(name) => {
                  const current = draft();
                  const renamed = current.saved && name !== current.name;
                  patch(current.id, {
                    name,
                    ...(renamed ? { saved: false } : {}),
                    ...(!current.saved || renamed
                      ? { secret: looksSecret(name) }
                      : {}),
                  });
                }}
              />
            </View>
            <View style={{ flex: 3, minWidth: 0 }}>
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
            <ToggleSwitch
              label={uiText("headerSecret")}
              checked={draft().secret}
              onChange={(secret) => patch(draft().id, { secret })}
            />
            <If when={props.plainHttp}>
              <ToggleSwitch
                label={uiText("headerPlainOk")}
                checked={draft().plainOk}
                onChange={(plainOk) => patch(draft().id, { plainOk })}
              />
            </If>
            <Button
              label={uiText("headerRemove")}
              tone="ghost"
              labelVariant="small"
              disabled={off()}
              onPress={() => {
                dirty.set(true);
                drafts.update((all) =>
                  all.filter((other) => other.id !== draft().id),
                );
              }}
            />
          </View>
        )}
      </Each>
      <If when={drafts().length}>
        <Label variant="small" tone="muted">
          {uiText("headerSecret") +
            (props.plainHttp ? ` · ${uiText("headerPlainOk")}` : "")}
        </Label>
      </If>
      <If when={problem()}>
        <Label variant="small" style={{ color: c().red }}>
          {problem()}
        </Label>
      </If>
      <View style={{ ...row, gap: space[8], flexWrap: "wrap" }}>
        <If when={!hasAuthorization()}>
          <Button
            label={uiText("headerAddBearer")}
            tone="plain"
            labelVariant="small"
            disabled={off()}
            onPress={() => add(defaultHeaderRow())}
          />
        </If>
        <Button
          label={uiText("headerAddCustom")}
          tone="plain"
          labelVariant="small"
          disabled={off()}
          onPress={() => add(customHeaderRow())}
        />
      </View>
      <View
        style={{ ...row, justifyContent: "flex-end", paddingTop: space[4] }}
      >
        <Button
          label={uiText("headerSave")}
          tone="primary"
          labelVariant="small"
          disabled={off()}
          onPress={save}
        />
      </View>
    </View>
  );
}
