import type { PluginView } from "@eta/client-contracts";
import { signal, View } from "nsh";
import { Button, Field, Label, row } from "../../components";
import { space, weight } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** The required text fields nobody has filled in yet: what keeps the plugin from running. */
const missingFields = (item: PluginView) =>
  item.fields.filter(
    (field) =>
      field.required &&
      !field.set &&
      field.value === null &&
      field.default == null,
  );

/**
 * Says which required value is missing and gives the place to type it, in the same dialog as the
 * servers. A value saved here is checked by the host like one saved in the configuration form; a
 * secret is saved encrypted and never shown again.
 */
export function MissingValues(props: { item: PluginView }) {
  const host = useHost();
  const typed = signal<Record<string, string>>({});
  const problem = signal("");
  const busy = signal(false);
  const text = missingFields(props.item).filter(
    (field) => field.type === "string",
  );
  const other = () =>
    missingFields(props.item).filter((field) => field.type !== "string");
  function save() {
    if (busy()) return;
    const values = Object.fromEntries(
      Object.entries(typed()).filter(([, value]) => value.trim() !== ""),
    );
    if (Object.keys(values).length === 0) {
      problem.set(uiText("missingEnter"));
      return;
    }
    problem.set("");
    busy.set(true);
    void host.action(async () => {
      try {
        await host.call("plugins", "configure", {
          name: props.item.name,
          values,
        });
        typed.set({});
      } finally {
        busy.set(false);
      }
    });
  }
  return (
    <If when={missingFields(props.item).length}>
      <View testID="missing-values" style={{ gap: space[8] }}>
        <Label variant="small" weight={weight.strong}>
          {uiText("missingTitle", {
            names: missingFields(props.item)
              .map((field) => field.title || field.name)
              .join(", "),
          })}
        </Label>
        <If when={other().length}>
          <Label variant="small" tone="muted">
            {uiText("missingElsewhere")}
          </Label>
        </If>
        <Each
          of={missingFields(props.item).filter(
            (field) => field.type === "string",
          )}
          key={(field) => field.name}
        >
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
        <If when={problem()}>
          <Label variant="small" tone="red">
            {problem()}
          </Label>
        </If>
        <If when={text.length}>
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
