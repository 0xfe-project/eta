import { View } from "nsh";
import { colors, fill, Label } from "../../components";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

export function HostRestartScreen() {
  const update = useHost().upgrade;
  const c = colors();
  const description = () => {
    switch (update()?.phase) {
      case "starting":
        return uiText("updatePreparing");
      case "downloading":
        return uiText("updateDownloading");
      case "waiting":
        return uiText("updateWaiting");
      case "rolling-back":
        return uiText("restoringThePreviousVersion");
      default:
        return uiText("startingTheNewVersion");
    }
  };
  return (
    <View
      role="alert"
      testID="host-updating"
      accessibilityLabel={uiText("hostUpdateInProgress")}
      style={{
        ...fill,
        zIndex: 500,
        backgroundColor: c().canvas,
        justifyContent: "center",
        alignItems: "center",
        paddingHorizontal: 24,
      }}
    >
      <View style={{ width: 448, maxWidth: "100%", gap: 12 }}>
        <Label size={16} weight={500} line={24}>
          {update()?.to
            ? uiText("updatingTo", { to: update()?.to })
            : uiText("updatingTheHost")}
        </Label>
        <Label size={14} line={20} tone="muted">
          {description()}
        </Label>
        <View
          style={{
            height: 4,
            backgroundColor: c().border,
            flexDirection: "row",
            alignItems: "stretch",
            overflow: "hidden",
          }}
        >
          <View style={{ width: "21%" }} />
          <View style={{ width: "37.5%", backgroundColor: c().button }} />
          <View style={{ width: "17.5%" }} />
          <View style={{ width: "12.5%", backgroundColor: c().button }} />
        </View>
      </View>
    </View>
  );
}
