import type { ArtifactView } from "@eta/client-contracts";
import type { DayGroup } from "./filter";
import { Text, View } from "nsh";
import {
  colors,
  fill,
  focusRing,
  grow,
  Icon,
  Label,
  row,
} from "../../../components";
import { control, icon, space } from "../../../components/tokens";
import { uiText } from "../../../i18n";
import { clock, useHost } from "../../../services/host";
import { messageTime } from "../message-time";
import { highlightParts } from "./filter";

/**
 * When, as short as the row's place lets it be: under a Today or Yesterday heading the clock is
 * enough, under Earlier the date; with no heading above (sorted by title), both.
 */
function listTime(at: number, group: DayGroup | null) {
  if (group === "today" || group === "yesterday") return clock(at);
  if (group === "earlier") {
    const date = new Date(at);
    return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return messageTime(at, false);
}

export function ArtifactRow(props: {
  artifact: ArtifactView;
  version?: number;
  placement?: "context" | "list";
  phone?: boolean;
  onPress: () => void;
  onTask?: (id: string) => void;
  /** In the Artifacts tab: what the search matched in the title, marked. */
  query?: string;
  /** The day heading the row sits under, which decides how much of the time to say. */
  group?: DayGroup | null;
  /** The time it is listed by (created or updated). */
  at?: number;
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
      ? listTime(props.at ?? props.artifact.updatedAt, props.group ?? null)
      : messageTime(props.artifact.updatedAt, false);
  const metadata = () =>
    [publisher(), version() ? `v${version()}` : undefined, timestamp()]
      .filter(Boolean)
      .join(" · ");
  const linkedTask = () =>
    props.onTask && props.artifact.taskId
      ? host.tasks().find((task) => task.id === props.artifact.taskId)
      : undefined;
  if (!props.placement)
    return (
      <View
        role="button"
        accessibilityLabel={title()}
        onPress={props.onPress}
        hoverStyle={{ backgroundColor: c().selected }}
        focusVisibleStyle={focusRing(c(), "inset")}
        style={{
          ...row,
          gap: space[8],
          minHeight: space[32],
          paddingVertical: space[4],
          paddingHorizontal: space[12],
          borderWidth: 1,
          borderColor: c().border,
          cursor: "pointer",
        }}
      >
        <Icon name="artifact" size={icon.md} tone="muted" />
        <View style={{ ...row, ...grow }}>
          <Label lines={1} style={{ flexShrink: 1 }}>
            {props.artifact.title}
          </Label>
          <Label lines={1} tone="muted" style={{ flexShrink: 0 }}>
            {title().slice(props.artifact.title.length)}
          </Label>
        </View>
        <Icon name="right" size={icon.sm} tone="muted" />
      </View>
    );
  return (
    <View
      style={{
        position: "relative",
        borderBottomWidth: 1,
        borderColor: c().border,
      }}
      hoverStyle={{ backgroundColor: c().selected }}
    >
      <View
        role="button"
        accessibilityLabel={title()}
        accessibilityHint={metadata()}
        onPress={props.onPress}
        focusVisibleStyle={focusRing(c(), "inset")}
        style={{ ...fill, cursor: "pointer" }}
      />
      <View
        style={{
          ...row,
          alignItems: "flex-start",
          gap: space[8],
          minHeight: props.phone ? control.touch : undefined,
          paddingHorizontal: space[12],
          paddingVertical: space[8],
          pointerEvents: "box-none",
        }}
      >
        <View
          style={{
            marginTop: list() ? space[4] : space[2],
            flexShrink: 0,
            pointerEvents: "none",
          }}
        >
          <Icon name="artifact" size={icon.sm} tone="mutedInk" />
        </View>
        <View
          style={{
            ...grow,
            gap: list() ? space[2] : 0,
            pointerEvents: "box-none",
          }}
        >
          <Label
            variant="small"
            lines={list() ? 2 : 1}
            style={{ pointerEvents: "none" }}
          >
            <Each of={highlightParts(props.artifact.title, props.query ?? "")}>
              {(part) => (
                <If when={part().match} else={part().text}>
                  <Text style={{ backgroundColor: c().highlight }}>
                    {part().text}
                  </Text>
                </If>
              )}
            </Each>
          </Label>
          <View style={{ ...row, gap: space[4], pointerEvents: "box-none" }}>
            <Label
              variant="caption"
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
                    paddingHorizontal: space[4],
                    borderWidth: 1,
                    borderColor: c().border,
                    cursor: "pointer",
                    pointerEvents: "auto",
                  }}
                  hoverStyle={{ backgroundColor: c().canvas }}
                  focusVisibleStyle={focusRing(c(), "inset")}
                  onPress={() => props.onTask?.(task().id)}
                >
                  <Label
                    variant="caption"
                    tone="muted"
                  >{`#${task().number}`}</Label>
                </View>
              )}
            </If>
          </View>
        </View>
      </View>
    </View>
  );
}
