import type { Layout } from "../../components";
import { View } from "nsh";
import { colors, Header, Label } from "../../components";
import { DownloadProgressBar } from "../../components/download-progress";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { localProgress } from "./local-host";
import { cardWidth } from "./visuals";

export function DownloadStatus(props: { layout: Layout }) {
  const c = colors();
  const stats = () => localProgress();
  const mb = (size: number) => Math.round(size / (1024 * 1024));
  const percent = () =>
    stats()?.total
      ? Math.max(
          0,
          Math.min(100, ((stats()!.received ?? 0) / stats()!.total!) * 100),
        )
      : 0;
  return (
    <View
      style={{
        width: "100%",
        maxWidth: cardWidth,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
    >
      <Header
        title={uiText("downloadingTheHost")}
        layout={props.layout}
        inset={space[16]}
        dialog
      />
      <View style={{ padding: space[16], gap: space[12] }}>
        <Label tone="mutedInk">
          {stats()?.version
            ? `eta-host ${stats()!.version}`
            : uiText("findingARelease")}
        </Label>
        <DownloadProgressBar value={percent()} monochrome />
        <If when={stats()?.total}>
          <Label variant="small" tone="muted">
            {`${mb(stats()!.received ?? 0)} / ${mb(stats()!.total!)} MB`}
          </Label>
        </If>
        <Label variant="small" tone="muted">
          {uiText("onlyTheFirstTimeAfterThis")}
        </Label>
      </View>
    </View>
  );
}
