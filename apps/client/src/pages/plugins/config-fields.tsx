import { View } from "nsh";
import {
  colors,
  fontFamily,
  Fonts,
  Icon,
  Label,
  row,
  textFaces,
} from "../../components";
import { LayoutSelect } from "../../components/select";
import { control, icon, space } from "../../components/tokens";
import { formatLocale } from "../../i18n";

const pluginConfigCopy = {
  fields: [
    "Fill in the fields this plugin declares. These values go to its MCP servers.",
    "填写插件声明的字段。这些值会提供给插件的 MCP 服务器。",
  ],
  required: ["Required", "必填"],
  optional: ["(optional)", "（选填）"],
  optionalTag: ["optional", "选填"],
  access: ["Agent access", "智能体访问权限"],
  none: ["None (plugin process only)", "无（仅插件进程）"],
  read: ["Read", "读取"],
  file: ["File", "文件"],
  value: ["Value", "值"],
  encrypted: [
    "The configuration is stored encrypted on the host, and secrets are not shown again.",
    "配置在主机上加密保存，密钥不会再次显示。",
  ],
  missing: [
    "Something required is missing: it will still need configuring.",
    "仍有必填项缺失，插件还需要配置。",
  ],
  blank: ["Select a value", "请选择"],
} as const;

export function pluginConfigText(key: keyof typeof pluginConfigCopy) {
  return pluginConfigCopy[key][formatLocale().startsWith("zh") ? 1 : 0];
}

export function PluginSelect(props: {
  label: string;
  items: { value: string; title: string }[];
  value: string | null;
  disabled?: boolean;
  compact?: boolean;
  /** Phone fields are taller, with larger text. */
  phone?: boolean;
  onChange: (value: string) => void;
}) {
  const c = colors();
  const type = textFaces();
  const fonts = Fonts();
  return (
    <LayoutSelect
      accessibilityLabel={props.label}
      items={props.items}
      value={props.value}
      cover={false}
      offset={2}
      disabled={props.disabled}
      popupStyle={{
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
      itemStyle={{
        fontFamily: fontFamily(fonts().interface),
        minHeight: control.md,
        paddingHorizontal: space[8],
        color: c().ink,
        fontSize: type("small").size,
      }}
      trigger={
        <View
          style={{
            ...row,
            gap: props.compact ? space[4] : space[8],
            minHeight: props.phone
              ? props.compact
                ? control.md
                : space[40]
              : props.compact
                ? space[24]
                : control.md,
            paddingHorizontal:
              props.phone && !props.compact ? space[12] : space[8],
            borderWidth: 1,
            borderColor: c().strong,
            backgroundColor: c().canvas,
            cursor: "pointer",
          }}
        >
          <Label
            variant={props.compact ? "caption" : "small"}
            lines={1}
            style={props.compact && props.phone ? undefined : { flex: 1 }}
          >
            {props.items.find((item) => item.value === props.value)?.title ??
              pluginConfigText("blank")}
          </Label>
          <Icon
            name="down"
            size={props.phone && !props.compact ? icon.md : icon.sm}
            tone={props.phone ? "ink" : "muted"}
          />
        </View>
      }
      onChange={({ value }) => {
        if (value !== null && value !== props.value) props.onChange(value);
      }}
    />
  );
}
