import { View } from "nsh";
import { uiText } from "../i18n";
import { colors } from "./theme";
import { space } from "./tokens";

export function DownloadProgressBar(props: {
  value?: number;
  monochrome?: boolean;
}) {
  const c = colors();
  return (
    <If when={props.value !== undefined}>
      <View
        role="progressbar"
        accessibilityLabel={uiText("downloadProgress")}
        accessibilityValue={{ min: 0, max: 100, now: props.value }}
        style={{
          height: space[4],
          backgroundColor: c().selected,
        }}
      >
        <View
          style={{
            height: space[4],
            width: `${props.value ?? 0}%`,
            backgroundColor: props.monochrome ? c().button : c().blue,
          }}
        />
      </View>
    </If>
  );
}
