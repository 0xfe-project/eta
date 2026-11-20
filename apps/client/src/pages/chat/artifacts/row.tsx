import type { ArtifactView } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, fill, grow, Icon, Label, row } from "../../../components";
import { uiText } from "../../../i18n";
import { clock, useHost } from "../../../services/host";
import { messageTime } from "../message-time";

export function ArtifactRow(props: {
  artifact: ArtifactView;
  version?: number;
  placement?: "context" | "list";
  phone?: boolean;
  onPress: () => void;
  onTask?: (id: string) => void;
}) {
  const host = useHost();
  const c = colors();
  const list = () => props.placement === "list";
  const version = () => props.version ?? props.artifact.versions[0]?.number;
  const title = () =>
    uiText("version", {
      title: props.artifact.title,
      value2: version() ?? "",
    });
  const publisher = () =>
    host.agent(props.artifact.publisherAgentId)?.name ??
    uiText("artifactPublisherUnavailable");
  const timestamp = () =>
    list()
      ? clock(props.artifact.updatedAt)
      : messageTime(props.artifact.updatedAt, false);
  const metadata = () =>
    [publisher(), version() ? `v${version()}` : undefined, timestamp()]
      .filter(Boolean)
      .join(" · ");
  const linkedTask = () =>
    props.onTask && props.artifact.taskId
      ? host.tasks().find((task) => task.id === props.artifact.taskId)
      : undefined;
  return (
    <View
      style={{
        position: "relative",
        borderBottomWidth: list() ? 1 : 0,
        borderColor: c().border,
      }}
      hoverStyle={{ backgroundColor: c().selected }}
    >
      <View
        role="button"
        accessibilityLabel={title()}
        accessibilityHint={props.placement ? metadata() : undefined}
        onPress={props.onPress}
        focusVisibleStyle={{
          outlineWidth: 1,
          outlineColor: c().blue,
          outlineOffset: -1,
        }}
        style={{ ...fill, cursor: "pointer" }}
      />
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          gap: list() ? 10 : 8,
          minHeight: props.phone ? 44 : undefined,
          paddingHorizontal: list() ? 10 : props.placement ? 12 : 0,
          paddingTop: list() ? 10 : props.placement ? 2 : 5,
          paddingBottom: props.placement ? 10 : 5,
          pointerEvents: "box-none",
        }}
      >
        <View
          style={{
            marginTop: list() ? 3 : 2,
            flexShrink: 0,
            pointerEvents: "none",
          }}
        >
          <Icon name="artifact" size={12} tone="mutedInk" />
        </View>
        <View
          style={{ ...grow, gap: list() ? 2 : 0, pointerEvents: "box-none" }}
        >
          <Label
            size={12}
            line={list() ? 18 : 16}
            lines={list() ? 2 : 1}
            style={{ pointerEvents: "none" }}
          >
            {props.placement ? props.artifact.title : title()}
          </Label>
          <If when={props.placement}>
            <View style={{ ...row, gap: 6, pointerEvents: "box-none" }}>
              <Label
                size={10}
                line={14}
                tone="muted"
                lines={1}
                style={{ minWidth: 0, flexShrink: 1, pointerEvents: "none" }}
              >
                {metadata()}
              </Label>
              <If when={linkedTask()}>
                {(task) => (
                  <View
                    role="button"
                    accessibilityLabel={uiText("artifactOpenTask", {
                      number: task().number,
                    })}
                    accessibilityHint={task().title}
                    hitSlop={
                      props.phone
                        ? { top: 15, bottom: 15, left: 8, right: 8 }
                        : undefined
                    }
                    style={{
                      ...row,
                      flexShrink: 0,
                      paddingHorizontal: 4,
                      borderWidth: 1,
                      borderColor: c().border,
                      cursor: "pointer",
                      pointerEvents: "auto",
                    }}
                    hoverStyle={{ backgroundColor: c().canvas }}
                    focusVisibleStyle={{
                      outlineWidth: 1,
                      outlineColor: c().blue,
                    }}
                    onPress={() => props.onTask?.(task().id)}
                  >
                    <Label
                      size={10}
                      line={14}
                      tone="muted"
                    >{`#${task().number}`}</Label>
                  </View>
                )}
              </If>
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}
