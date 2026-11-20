import type { LlmModel, ProvidersView } from "@eta/client-contracts";
import { View } from "nsh";
import { Select } from "nsh/base";
import { uiText } from "../i18n";
import { useHost } from "../services/host";
import { Icon, Label } from "./text";
import { colors, row } from "./theme";

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
        })),
      ...configured
        .filter((provider) => provider.id !== "llm")
        .flatMap((provider) =>
          provider.models.map((model) => ({
            id: `${provider.id}:${model.id}`,
            name: model.name ?? model.id,
            provider: provider.name,
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
      searchPlaceholder="Search models"
      searchAccessibilityLabel="Search models"
      cover={false}
      offset={2}
      popupStyle={{
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
        maxHeight: 312,
      }}
      searchStyle={{
        color: c().ink,
        placeholderColor: c().muted,
        paddingHorizontal: 8,
        height: 32,
        backgroundColor: c().surface,
      }}
      groupStyle={{ paddingHorizontal: 9, paddingTop: 6, paddingBottom: 3 }}
      itemStyle={{
        minHeight: 28,
        paddingHorizontal: 9,
        color: c().ink,
        fontSize: 12,
      }}
      trigger={
        <View
          style={{
            ...row,
            minHeight: 32,
            gap: 8,
            paddingHorizontal: 9,
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            cursor: "pointer",
          }}
        >
          <Label size={12} lines={1} style={{ flex: 1 }}>
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
