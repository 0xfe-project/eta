import type { SkillFileEntry } from "@eta/client-contracts";
import type { Layout } from "../../../components";
import { Scroll, View } from "nsh";
import { Button, colors, grow, Icon, Label, row } from "../../../components";
import { uiText } from "../../../i18n";

export function SkillFileTree(props: {
  layout: Layout;
  directory: string;
  files: SkillFileEntry[];
  selected: string;
  onDirectory: (path: string) => void;
  onRead: (path: string) => void;
}) {
  const c = colors();
  return (
    <Scroll
      style={
        props.layout === "phone"
          ? grow
          : {
              width: props.layout === "tablet" ? 120 : 160,
              flexShrink: 0,
              borderRightWidth: 1,
              borderColor: c().border,
            }
      }
      scrollbar={false}
    >
      <View style={{ padding: 4 }}>
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
                  height: 24,
                  paddingHorizontal: 8,
                  gap: 5,
                  opacity: item().kind === "blocked" ? 0.45 : 1,
                  backgroundColor:
                    props.selected === path() ? c().selected : c().canvas,
                  cursor: item().kind === "blocked" ? "default" : "pointer",
                }}
              >
                <If when={item().kind === "directory"}>
                  <Icon name="folder" size={12} />
                </If>
                <Label size={12} lines={1}>
                  {item().path}
                </Label>
              </View>
            );
          }}
        </Each>
      </View>
    </Scroll>
  );
}
