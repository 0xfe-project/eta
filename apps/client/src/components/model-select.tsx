import type { LlmModel, ProvidersView } from "@eta/client-contracts";
import { etaModelThinking } from "@eta/client-contracts";
import { View } from "nsh";
import { Select } from "nsh/base";
import { uiText } from "../i18n";
import { useHost } from "../services/host";
import { Icon, Label } from "./text";
import { colors, row, textFaces, textStyle } from "./theme";
import { control, icon, space } from "./tokens";

/**
 * The models an eta agent can run on, each with the thinking levels it declares
 * (`etaModelThinking`), so a level picker offers what the model takes.
 */
export function useModels() {
  const host = useHost();
  return () => {
    const configured =
      host.section<ProvidersView>("providers", "config")?.providers ?? [];
    return [
      ...host
        .list<LlmModel>("llm", "models")
        .filter((model) => model.available)
        .map((model) => ({
          id: `llm:${model.id}`,
          name: model.name,
          provider: "Gateway",
          thinking: etaModelThinking(model),
        })),
      ...configured
        .filter((provider) => provider.id !== "llm")
        .flatMap((provider) =>
          provider.models.map((model) => ({
            id: `${provider.id}:${model.id}`,
            name: model.name ?? model.id,
            provider: provider.name,
            thinking: etaModelThinking(model),
          })),
        ),
    ];
  };
}

export function ModelSelect(props: {
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const c = colors();
  const type = textFaces();
  const models = useModels();
  const items = () => {
    const all = models().map((model) => ({
      value: model.id,
      title: model.name,
      group: model.provider,
    }));
    if (props.value && !all.some((item) => item.value === props.value))
      all.unshift({
        value: props.value,
        title: props.value,
        group: "Current model",
      });
    return all;
  };
  return (
    <Select
      accessibilityLabel={uiText("model")}
      items={items()}
      value={props.value || null}
      placeholder={props.placeholder ?? uiText("selectModel")}
      searchable
      searchPlaceholder={uiText("searchModels")}
      searchAccessibilityLabel={uiText("searchModels")}
      cover={false}
      offset={2}
      popupStyle={{
        minWidth: 336,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        maxHeight: 312,
      }}
      searchStyle={{
        color: c().ink,
        placeholderColor: c().muted,
        ...textStyle(type("small")),
        paddingHorizontal: 10,
        height: 34,
        backgroundColor: "transparent",
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
      groupStyle={{
        paddingHorizontal: 10,
        paddingTop: space[8],
        paddingBottom: space[4],
      }}
      itemStyle={{
        minHeight: control.md,
        paddingHorizontal: 0,
        color: c().ink,
        fontSize: type("small").size,
      }}
      empty={
        <View
          style={{
            alignItems: "center",
            paddingVertical: space[24],
            paddingHorizontal: 10,
          }}
        >
          <Label variant="small" tone="muted">
            {uiText("noModelsMatch")}
          </Label>
        </View>
      }
      renderItem={(item) => (
        <View
          style={{
            ...row,
            flex: 1,
            height: control.md,
            gap: space[8],
            paddingHorizontal: 10,
            backgroundColor:
              item.value === props.value ? c().selected : "transparent",
          }}
        >
          <Label
            variant="small"
            lines={1}
            tone={item.disabled ? "faint" : "ink"}
            style={{ flex: 1 }}
          >
            {item.title}
          </Label>
          <View style={{ width: space[12], height: space[12], flexShrink: 0 }}>
            <If when={item.value === props.value}>
              <Icon name="check" size={icon.sm} />
            </If>
          </View>
        </View>
      )}
      trigger={
        <View
          style={{
            ...row,
            height: control.md,
            gap: space[8],
            paddingHorizontal: space[8],
            borderWidth: 1,
            borderColor: c().border,
            backgroundColor: c().canvas,
            cursor: "pointer",
          }}
        >
          <Label variant="small" lines={1} style={{ flex: 1 }}>
            {items().find((item) => item.value === props.value)?.title ??
              props.placeholder ??
              uiText("selectModel")}
          </Label>
          <Icon name="down" size={10} tone="muted" />
        </View>
      }
      onChange={({ value }) => props.onChange(value ?? "")}
    />
  );
}
