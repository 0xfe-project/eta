import type { ArtifactView } from "@eta/client-contracts";
import type { Layout } from "../../../components";
import { View } from "nsh";
import {
  ActionItem,
  ActionMenu,
  Button,
  colors,
  Icon,
  Label,
  row,
} from "../../../components";
import { CloseButton } from "../../../components/navigation-buttons";
import { uiText } from "../../../i18n";

export function ArtifactToolbar(props: {
  title: string;
  layout: Layout;
  version?: number;
  versions: ArtifactView["versions"];
  item: boolean;
  hasViewer: boolean;
  previewReady: boolean;
  shared: boolean;
  sharing: boolean;
  exportDisabled: boolean;
  downloading: boolean;
  downloadDisabled: boolean;
  onVersion: (version: number) => void;
  onShare: () => void;
  onExport: () => void;
  onDownload: () => void;
  onPreview: () => void;
  onClose: () => void;
}) {
  const c = colors();
  const phone = () => props.layout === "phone";
  function versionLabel(number: number) {
    return uiText("artifactVersionOption", {
      number,
      latest:
        number === props.versions[0]?.number
          ? uiText("latestArtifactVersion")
          : "",
    });
  }
  function versionPicker() {
    return (
      <ActionMenu
        label={uiText("artifactVersion")}
        value={versionLabel(props.version ?? 1)}
        triggerStyle={{
          height: phone() ? 28 : 24,
          minWidth: phone() ? 132 : 114,
        }}
      >
        <Each of={props.versions} key={(entry) => entry.number}>
          {(entry) => (
            <ActionItem
              label={versionLabel(entry().number)}
              checked={props.version === entry().number}
              onSelect={() => props.onVersion(entry().number)}
            />
          )}
        </Each>
      </ActionMenu>
    );
  }

  function shareButton() {
    return (
      <Button
        label={props.shared ? uiText("unshare") : uiText("sharePublicly")}
        tone={phone() ? "plain" : "ghost"}
        size={phone() ? 28 : 24}
        labelSize={phone() ? 12 : 10}
        style={{ minWidth: phone() ? 99 : undefined }}
        disabled={props.sharing || !props.item}
        onPress={props.onShare}
      />
    );
  }

  function exportButton() {
    return (
      <If when={props.hasViewer}>
        <Button
          label={uiText("exportPdf")}
          tone={phone() ? "plain" : "ghost"}
          size={phone() ? 28 : 24}
          labelSize={phone() ? 12 : 10}
          style={{ minWidth: phone() ? 82 : undefined }}
          disabled={props.exportDisabled}
          onPress={props.onExport}
        />
      </If>
    );
  }

  return (
    <If
      when={phone()}
      else={
        <View
          style={{
            ...row,
            paddingHorizontal: 12,
            gap: 4,
            flexShrink: 0,
            height: props.layout === "desktop" ? 40 : 36,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Icon name="artifact" size={12} tone="muted" />
          <Label
            size={12}
            weight={500}
            lines={1}
            style={{ flex: 1, minWidth: 0, marginLeft: 4 }}
          >
            {props.title}
          </Label>
          {versionPicker()}
          {shareButton()}
          {exportButton()}
          <If when={props.hasViewer}>
            <Button
              label={uiText("openInNewWindow")}
              tone="ghost"
              labelSize={10}
              disabled={!props.previewReady}
              onPress={props.onPreview}
            />
          </If>
          <Button
            label={uiText(props.downloading ? "downloading" : "download")}
            tone="ghost"
            labelSize={10}
            disabled={props.downloadDisabled}
            onPress={props.onDownload}
          />
          <CloseButton onPress={props.onClose} />
        </View>
      }
    >
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          flexWrap: "wrap",
          flexShrink: 0,
          paddingHorizontal: 16,
          paddingVertical: 6,
          minHeight: 44,
          borderBottomWidth: 1,
          borderColor: c().border,
          gap: 4,
        }}
      >
        {versionPicker()}
        <View style={{ ...row, gap: 8 }}>
          {exportButton()}
          {shareButton()}
        </View>
      </View>
    </If>
  );
}
