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
import { control, icon, space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";

/** The version picker's least width, the phone buttons' least widths, the bar off phones. */
const pickerWidth = { phone: 132, desktop: 116 } as const;
const phoneButtonWidth = { share: 100, export: 84 } as const;
const barHeight = { desktop: 40, tablet: 36 } as const;

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
          height: phone() ? control.md : space[24],
          minWidth: phone() ? pickerWidth.phone : pickerWidth.desktop,
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
        icon={phone() ? undefined : "globe"}
        iconSize={icon.sm}
        tone={phone() ? "plain" : "ghost"}
        size={phone() ? control.md : control.sm}
        labelVariant="caption"
        style={{ minWidth: phone() ? phoneButtonWidth.share : undefined }}
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
          icon={phone() ? undefined : "printer"}
          iconSize={icon.sm}
          tone={phone() ? "plain" : "ghost"}
          size={phone() ? control.md : control.sm}
          labelVariant="caption"
          style={{ minWidth: phone() ? phoneButtonWidth.export : undefined }}
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
            paddingLeft: space[12],
            paddingRight: space[16],
            gap: space[8],
            flexShrink: 0,
            height:
              props.layout === "desktop" ? barHeight.desktop : barHeight.tablet,
            borderBottomWidth: 1,
            borderColor: c().border,
          }}
        >
          <Icon name="appWindow" size={icon.md} tone="muted" />
          <Label
            variant="small"
            weight={weight.regular}
            lines={1}
            style={{ flex: 1, minWidth: 0 }}
          >
            {props.title}
          </Label>
          <View style={{ ...row, gap: space[4] }}>
            {versionPicker()}
            {shareButton()}
            {exportButton()}
            <If when={props.hasViewer}>
              <Button
                label={uiText("openInNewWindow")}
                icon="external"
                iconSize={icon.sm}
                tone="ghost"
                size={control.sm}
                labelVariant="caption"
                disabled={!props.previewReady}
                onPress={props.onPreview}
              />
            </If>
            <Button
              label={uiText(props.downloading ? "downloading" : "download")}
              icon="download"
              iconSize={icon.sm}
              tone="ghost"
              size={control.sm}
              labelVariant="caption"
              disabled={props.downloadDisabled}
              onPress={props.onDownload}
            />
          </View>
          {/* The actions end 48pt from the edge, the bare close glyph 14pt. */}
          <CloseButton
            iconSize={icon.md}
            onPress={props.onClose}
            style={{ marginLeft: space[8], marginRight: -space[4] }}
          />
        </View>
      }
    >
      <View
        style={{
          ...row,
          justifyContent: "space-between",
          flexWrap: "wrap",
          flexShrink: 0,
          paddingHorizontal: space[16],
          paddingVertical: space[8],
          minHeight: control.touch,
          borderBottomWidth: 1,
          borderColor: c().border,
          gap: space[4],
        }}
      >
        {versionPicker()}
        <View style={{ ...row, gap: space[8] }}>
          {exportButton()}
          {shareButton()}
        </View>
      </View>
    </If>
  );
}
