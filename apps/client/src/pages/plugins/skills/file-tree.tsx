import type { SkillFileEntry } from "@eta/client-contracts";
import type { Layout } from "../../../components";
import { View } from "nsh";
import {
  Button,
  colors,
  grow,
  Icon,
  Label,
  row,
  SmoothScroll,
} from "../../../components";
import { icon, opacity, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";

/** The column of a skill's files beside the file. */
const treeWidth = { tablet: 120, desktop: 160 } as const;

export function SkillFileTree(props: {
  layout: Layout;
  directory: string;
  files: SkillFileEntry[];
  selected: string;
  onDirectory: (path: string) => void;
  onRead: (path: string) => void;
}) {
  const c = colors();
  const phone = () => props.layout === "phone";
  return (
    <SmoothScroll
      style={
        props.layout === "phone"
          ? grow
          : {
              width:
                props.layout === "tablet"
                  ? treeWidth.tablet
                  : treeWidth.desktop,
              flexShrink: 0,
              borderRightWidth: 1,
              borderColor: c().border,
            }
      }
      scrollbar={false}
    >
      <View style={{ padding: space[4], gap: phone() ? space[2] : 0 }}>
        <If when={props.directory}>
          <Button
            label={uiText("parentDirectory")}
            icon="back"
            tone="ghost"
            style={{ justifyContent: "flex-start" }}
            onPress={() =>
              props.onDirectory(
                props.directory.split("/").slice(0, -1).join("/"),
              )
            }
          />
        </If>
        <Each of={props.files} key={(item) => item.path}>
          {(item) => {
            const path = () =>
              [props.directory, item().path].filter(Boolean).join("/");
            return (
              <View
                role="button"
                accessibilityLabel={item().path}
                accessibilityState={{
                  selected: props.selected === path(),
                  disabled: item().kind === "blocked",
                }}
                disabled={item().kind === "blocked"}
                onPress={() => {
                  if (item().kind === "directory") props.onDirectory(path());
                  else if (item().kind === "file") {
                    props.onRead(path());
                  }
                }}
                hoverStyle={{ backgroundColor: c().selected }}
                style={{
                  ...row,
                  height: phone() ? space[32] : space[24],
                  paddingHorizontal: phone() ? space[12] : space[8],
                  gap: space[4],
                  opacity: item().kind === "blocked" ? opacity.disabled : 1,
                  backgroundColor:
                    props.selected === path() ? c().selected : c().canvas,
                  cursor: item().kind === "blocked" ? "default" : "pointer",
                }}
              >
                <If when={item().kind === "directory"}>
                  <Icon name="folder" size={icon.sm} />
                </If>
                <Label variant="small" lines={1}>
                  {item().path}
                </Label>
              </View>
            );
          }}
        </Each>
      </View>
    </SmoothScroll>
  );
}
