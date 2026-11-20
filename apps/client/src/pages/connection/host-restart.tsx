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
      <View style={{ width: 344, maxWidth: "100%", gap: 8 }}>
        <Label size={18} weight={600}>
          {update()?.to
            ? uiText("updatingTo", { to: update()?.to })
            : uiText("updatingTheHost")}
        </Label>
        <Label size={13} tone="muted">
          {description()}
        </Label>
        <View
          style={{
            height: 3,
            backgroundColor: c().border,
            flexDirection: "row",
            alignItems: "stretch",
          }}
        >
          <View style={{ width: "20%" }} />
          <View style={{ width: "38%", backgroundColor: c().ink }} />
          <View style={{ width: "16%" }} />
          <View style={{ width: "12%", backgroundColor: c().muted }} />
        </View>
      </View>
    </View>
  );
}
