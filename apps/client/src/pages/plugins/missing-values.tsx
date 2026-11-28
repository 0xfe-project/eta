import type { PluginView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Field, Label, row } from "../../components";
import { space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";
import { fieldIssueText } from "./config-fields";
import { looksSecret } from "./headers-model";

/** The required fields nobody has filled in yet: what keeps the plugin from running. */
const missingFields = (item: PluginView) =>
  item.fields.filter(
    (field) =>
      field.issue?.code === "required" ||
      (field.required &&
        !field.set &&
        field.value === null &&
        field.default == null),
  );

/** Saved fields whose values no longer satisfy the plugin's constraints. */
const invalidFields = (item: PluginView) =>
  item.fields.filter(
    (field) => field.issue !== null && field.issue.code !== "required",
  );

interface MissingEnvEntry {
  server: string;
  name: string;
  key: string;
}

/** Empty stdio env vars declared by the manifest that still have no user-supplied value. */
const missingEnvs = (item: PluginView): MissingEnvEntry[] =>
  item.servers.flatMap((server) =>
    (server.missingEnv ?? []).map((name) => ({
      server: server.name,
      name,
      key: `${server.name}\n${name}`,
    })),
  );

/**
 * Says which required value or stdio environment variable is missing (or invalid) and gives the
 * place to type it, in the same dialog as the servers. Values saved here are checked by the host
 * like ones saved in the configuration form; secrets are saved encrypted and never shown again.
 */
export function MissingValues(props: { item: PluginView }) {
  const host = useHost();
  const typed = signal<Record<string, string>>({});
  const typedEnv = signal<Record<string, string>>({});
  const problem = signal("");
  const busy = signal(false);
  const missing = () => missingFields(props.item);
  const invalid = () => invalidFields(props.item);
  const envMissing = () => missingEnvs(props.item);
  const text = () => {
    const seen = new Set<string>();
    return [...missing(), ...invalid()].filter(
      (field) =>
        field.type === "string" &&
        !seen.has(field.name) &&
        seen.add(field.name),
    );
  };
  const other = () => {
    const seen = new Set<string>();
    return [...missing(), ...invalid()].filter(
      (field) =>
        field.type !== "string" &&
        !seen.has(field.name) &&
        seen.add(field.name),
    );
  };
  const missingNames = () => [
    ...missing().map((field) => field.title || field.name),
    ...envMissing().map((entry) =>
      props.item.servers.length > 1
        ? `${entry.server}: ${entry.name}`
        : entry.name,
    ),
  ];
  const hasAny = () =>
    missing().length > 0 || invalid().length > 0 || envMissing().length > 0;
  function save() {
    if (busy()) return;
    const allowedFields = new Set(text().map((field) => field.name));
    const values = Object.fromEntries(
      Object.entries(typed()).filter(
        ([name, value]) => allowedFields.has(name) && value.trim() !== "",
      ),
    );
    const envByServer = new Map<string, [string, string][]>();
    for (const entry of envMissing()) {
      const value = typedEnv()[entry.key] ?? "";
      if (value.trim() === "") continue;
      const list = envByServer.get(entry.server) ?? [];
      list.push([entry.name, value]);
      envByServer.set(entry.server, list);
    }
    if (Object.keys(values).length === 0 && envByServer.size === 0) {
      problem.set(uiText("missingEnter"));
      return;
    }
    problem.set("");
    busy.set(true);
    void host.action(async () => {
      try {
        if (Object.keys(values).length > 0) {
          await host.call("plugins", "configure", {
            name: props.item.name,
            values,
          });
          typed.update((all) => {
            const next = { ...all };
            for (const key of Object.keys(values)) delete next[key];
            return next;
          });
        }
        for (const [serverName, entries] of envByServer) {
          const existing = (props.item.env ?? []).filter(
            (one) => one.server === serverName,
          );
          const merged = new Map<
            string,
            { name: string; value: string | null; secret: boolean }
          >();
          for (const one of existing) {
            merged.set(one.name, {
              name: one.name,
              value: one.secret ? null : (one.value ?? null),
              secret: one.secret,
            });
          }
          for (const [envName, val] of entries) {
            merged.set(envName, {
              name: envName,
              value: val,
              secret: looksSecret(envName),
            });
          }
          await host.call("plugins", "setEnv", {
            name: props.item.name,
            server: serverName,
            env: [...merged.values()],
          });
          typedEnv.update((all) => {
            const next = { ...all };
            for (const [envName] of entries)
              delete next[`${serverName}\n${envName}`];
            return next;
          });
        }
      } finally {
        busy.set(false);
      }
    });
  }
  return (
    <If when={hasAny()}>
      <View testID="missing-values" style={{ gap: space[8] }}>
        <If when={missingNames().length}>
          <Label variant="small" weight={weight.strong}>
            {uiText("missingTitle", {
              names: missingNames().join(", "),
            })}
          </Label>
        </If>
        <Each of={invalid()} key={(field) => field.name}>
          {(field) => (
            <Label variant="small" tone="red">
              {uiText("pluginFieldWarning", {
                title: field().title || field().name,
                reason: fieldIssueText(field(), field().issue!),
              })}
            </Label>
          )}
        </Each>
        <If when={other().length}>
          <Label variant="small" tone="muted">
            {uiText("missingElsewhere")}
          </Label>
        </If>
        <Each of={text()} key={(field) => field.name}>
          {(field) => (
            <Field
              label={field().title || field().name}
              value={typed()[field().name] ?? ""}
              masked={field().secret === true}
              placeholder={field().title || field().name}
              onChange={(value) =>
                typed.update((all) => ({ ...all, [field().name]: value }))
              }
            />
          )}
        </Each>
        <Each of={envMissing()} key={(entry) => entry.key}>
          {(entry) => (
            <Field
              label={
                props.item.servers.length > 1
                  ? `${entry().server} · ${entry().name}`
                  : entry().name
              }
              value={typedEnv()[entry().key] ?? ""}
              masked={looksSecret(entry().name)}
              placeholder={entry().name}
              onChange={(value) =>
                typedEnv.update((all) => ({ ...all, [entry().key]: value }))
              }
            />
          )}
        </Each>
        <If when={problem()}>
          <Label variant="small" tone="red">
            {problem()}
          </Label>
        </If>
        <If when={text().length > 0 || envMissing().length > 0}>
          <View style={{ ...row, justifyContent: "flex-end" }}>
            <Button
              label={uiText("missingSave")}
              tone="primary"
              labelVariant="small"
              busy={busy()}
              onPress={save}
            />
          </View>
        </If>
      </View>
    </If>
  );
}
