import type { ProviderSummary } from "@eta/client-contracts";
import { modelSource } from "@eta/client-contracts";
import { signal, View } from "nsh";
import {
  Button,
  Caption,
  dialogWidth,
  Field,
  Modal,
  row,
} from "../../../components";
import { space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { useHost } from "../../../services/host";

export function ProviderEditor(props: {
  item?: ProviderSummary;
  revision: string;
  phone: boolean;
  onClose: () => void;
}) {
  const host = useHost();
  const item = props.item;
  const kind = () => item?.kind ?? "openai-compatible";
  const preset = () => modelSource(kind());
  const name = signal(item?.name ?? item?.id ?? preset()?.name ?? "");
  const url = signal(item?.baseUrl ?? preset()?.baseUrl ?? "");
  const key = signal("");
  const models = signal(item?.models.map((model) => model.id).join(", ") ?? "");
  const discovered = signal<ProviderSummary["models"]>(item?.models ?? []);
  const busy = signal<"" | "discover" | "save">("");
  const valid = () =>
    name().trim() &&
    /^https?:\/\//i.test(url().trim()) &&
    models().trim() &&
    (preset()?.auth !== "key" || item?.hasApiKey || key().trim());
  async function discover() {
    if (busy()) return;
    busy.set("discover");
    const result = await host.action(() =>
      host.call<{ models: ProviderSummary["models"] }>(
        "providers",
        "discover",
        {
          kind: kind(),
          baseUrl: url().trim(),
          apiKey: key() || undefined,
          id: item?.id,
          revision: props.revision,
        },
      ),
    );
    busy.set("");
    if (result) {
      discovered.set(result.models);
      models.set(result.models.map((model) => model.id).join(", "));
    }
  }
  async function save() {
    if (!valid() || busy()) return;
    busy.set("save");
    const id =
      item?.id ??
      name()
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    const values = [
      ...new Set(
        models()
          .split(",")
          .map((model) => model.trim())
          .filter(Boolean),
      ),
    ];
    const result = await host.action(() =>
      host.call("providers", "save", {
        revision: props.revision,
        provider: {
          id,
          name: name().trim(),
          kind: kind(),
          baseUrl: url().trim(),
          apiKey: key() || undefined,
          models: values.map(
            (id) =>
              discovered().find((model) => model.id === id) ?? {
                id,
                name: id,
                contextWindow: 128000,
              },
          ),
        },
      }),
    );
    busy.set("");
    if (result) props.onClose();
  }
  return (
    <Modal
      title={item ? (item.name ?? item.id) : uiText("addModelSource")}
      phone={props.phone}
      width={dialogWidth.lg}
      onClose={props.onClose}
    >
      <View style={{ padding: space[16], gap: space[8] }}>
        <Caption text={preset()?.name ?? uiText("openaiCompatibleSource")} />
        <Field
          label={uiText("sourceName")}
          placeholder={uiText("name")}
          value={name()}
          onChange={name.set}
        />
        <Field
          label={uiText("endpoint")}
          placeholder="https://example.com/v1"
          value={url()}
          onChange={url.set}
        />
        <Field
          label="API key"
          placeholder={item?.hasApiKey ? uiText("apiKeySaved") : "API key"}
          value={key()}
          masked
          onChange={key.set}
        />
        <Field
          label={uiText("models2")}
          placeholder={uiText("modelIdsSeparatedByCommas")}
          value={models()}
          onChange={models.set}
        />
        <View style={{ ...row, gap: space[8], justifyContent: "flex-end" }}>
          <Button
            label={uiText("discoverModels")}
            disabled={!url().trim() || busy() === "save"}
            busy={busy() === "discover"}
            onPress={() => void discover()}
          />
          <Button
            label={uiText("saveSource")}
            tone="primary"
            disabled={!valid() || busy() === "discover"}
            busy={busy() === "save"}
            onPress={() => void save()}
          />
        </View>
      </View>
    </Modal>
  );
}
