import type { Layout } from "../../components";
import { View } from "nsh";
import { colors, Header, Label } from "../../components";
import { DownloadProgressBar } from "../../components/download-progress";
import { uiText } from "../../i18n";
import { localProgress } from "./local-host";

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
        maxWidth: 480,
        borderWidth: 1,
        borderColor: c().strong,
        backgroundColor: c().canvas,
      }}
    >
      <Header
        title={uiText("downloadingTheHost")}
        layout={props.layout}
        inset={16}
        dialog
      />
      <View style={{ padding: 16, gap: 12 }}>
        <Label size={14} line={20} tone="mutedInk">
          {stats()?.version
            ? `eta-host ${stats()!.version}`
            : uiText("findingARelease")}
        </Label>
        <DownloadProgressBar value={percent()} monochrome />
        <If when={stats()?.total}>
          <Label size={12} line={16} tone="muted">
            {`${mb(stats()!.received ?? 0)} / ${mb(stats()!.total!)} MB`}
          </Label>
        </If>
        <Label size={12} line={16} tone="muted">
          {uiText("onlyTheFirstTimeAfterThis")}
        </Label>
      </View>
    </View>
  );
}
