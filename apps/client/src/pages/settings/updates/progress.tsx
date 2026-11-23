import type {
  UpgradeDownloadProgress,
  UpgradePhase,
  UpgradeStatusView,
} from "@eta/client-contracts";
import type { light } from "../../../components/theme";
import { View } from "nsh";
import { colors, Label, row } from "../../../components";
import { StatusDot } from "../../../components/status-dot";
import { space, weight } from "../../../components/tokens";
import { uiText } from "../../../i18n";

// What Settings › Update and the restart screen say about an upgrade: the steps it goes through,
// how far the download is, and how a finished one ended (Paper: Eta · Settings › Supplement /
// Settings / Update flow).

/** How long a finished upgrade is still told in Settings. */
const RESULT_WINDOW = 24 * 60 * 60_000;

export function megabytes(bytes: number) {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function downloadPercent(download?: UpgradeDownloadProgress) {
  return download?.total && download.total > 0
    ? Math.max(
        0,
        Math.min(100, Math.round((100 * download.received) / download.total)),
      )
    : undefined;
}

/** The strip's five steps, and which one a phase is in. */
const stepNames = [
  "updateStepDownload",
  "updateStepWait",
  "updateStepBackUp",
  "updateStepRestart",
  "updateStepCheck",
] as const;

const stepOf: Record<UpgradePhase, number> = {
  starting: 0,
  downloading: 0,
  waiting: 1,
  stopping: 2,
  "backing-up": 2,
  restarting: 3,
  verifying: 4,
  "rolling-back": 4,
};

/** A finished upgrade that is recent enough to tell, with the words for it. */
export type UpgradeResult = UpgradeStatusView & {
  state: Exclude<UpgradeStatusView["state"], "running">;
};

export function recentResult(
  status: UpgradeStatusView | undefined,
  now = Date.now(),
): UpgradeResult | undefined {
  if (!status || status.state === "running") return undefined;
  const at = status.finishedAt ?? status.startedAt;
  return now - at < RESULT_WINDOW ? (status as UpgradeResult) : undefined;
}

export type ResultTone = "green" | "red" | "warning" | "faint";

export function resultTone(result: UpgradeResult): ResultTone {
  switch (result.state) {
    case "done":
      return "green";
    case "failed":
    case "broken":
      return "red";
    case "cancelled":
      return "faint";
    default:
      return "warning";
  }
}

/** The short words beside the version. */
export function resultLabel(result: UpgradeResult) {
  switch (result.state) {
    case "done":
      return uiText("updateUpToDate");
    case "failed":
      return uiText("updateFailedStatus");
    case "rolled-back":
      return uiText("updateRolledBackStatus", { version: result.from });
    case "cancelled":
      return uiText("updateCancelledStatus");
    case "lost":
      return uiText("updateLostStatus");
    case "broken":
      return uiText("updateBrokenStatus");
  }
}

/** The notice under the row: what happened, then the detail. */
export function resultNotice(result: UpgradeResult): {
  title: string;
  body?: string;
} {
  const to = result.to ?? "";
  switch (result.state) {
    case "done":
      return {
        title: uiText("updateDoneTitle", { version: to }),
        body: uiText("updateDoneBody", { from: result.from }),
      };
    case "failed":
      return {
        title: to
          ? uiText("updateFailedTitle", { version: to })
          : uiText("updateFailedTitlePlain"),
        body: result.error,
      };
    case "rolled-back":
      return {
        title: uiText("updateRolledBackTitle", { to, from: result.from }),
        body: result.error,
      };
    case "cancelled":
      return {
        title: uiText("updateCancelledStatus"),
        body: uiText("updateCancelledBody", { version: result.from }),
      };
    case "lost":
      return {
        title: uiText("updateLostTitle"),
        body: uiText("updateLostBody", { version: result.from }),
      };
    case "broken":
      return {
        title: uiText("updateBrokenTitle"),
        body: [
          uiText("updateBrokenBody", { to, from: result.from }),
          result.error,
        ]
          .filter(Boolean)
          .join(" "),
      };
  }
}

/** The steps as a thin strip under the Host's row, the current one marked. */
export function UpdateSteps(props: { phase: UpgradePhase; percent?: number }) {
  const c = colors();
  const current = () => stepOf[props.phase];
  return (
    <View testID="update-steps" style={{ ...row, gap: space[4] }}>
      <Each of={[...stepNames]} key={(name) => name}>
        {(name, index) => {
          const state = () =>
            index() < current()
              ? "done"
              : index() === current()
                ? "current"
                : "todo";
          const fill = (): `${number}%` =>
            state() === "current" &&
            index() === 0 &&
            props.percent !== undefined
              ? `${Math.max(4, props.percent)}%`
              : state() === "todo"
                ? "0%"
                : "100%";
          return (
            <View style={{ flex: 1, minWidth: 0, gap: space[4] }}>
              <View
                style={{
                  height: space[4],
                  backgroundColor: c().border,
                  flexDirection: "row",
                }}
              >
                <View
                  style={{
                    height: space[4],
                    width: fill(),
                    backgroundColor: state() === "done" ? c().green : c().blue,
                  }}
                />
              </View>
              <Label
                variant="small"
                lines={1}
                tone={
                  state() === "current"
                    ? "ink"
                    : state() === "done"
                      ? "muted"
                      : "faint"
                }
              >
                {uiText(name())}
              </Label>
            </View>
          );
        }}
      </Each>
    </View>
  );
}

/** A finished upgrade's notice: a bordered box with a mark, its title and detail. */
export function UpdateNotice(props: {
  tone: ResultTone;
  title: string;
  body?: string;
  testID?: string;
}) {
  const c = colors();
  return (
    <View
      testID={props.testID}
      style={{
        ...row,
        alignItems: "flex-start",
        gap: space[8],
        paddingVertical: space[8],
        paddingHorizontal: space[12],
        borderWidth: 1,
        borderColor: c().border,
      }}
    >
      <View style={{ paddingTop: space[4] }}>
        <StatusDot color={c()[props.tone as keyof typeof light]} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: space[2] }}>
        <Label variant="small" weight={weight.regular}>
          {props.title}
        </Label>
        <If when={props.body}>
          {(body) => (
            <Label variant="small" tone="mutedInk">
              {body()}
            </Label>
          )}
        </If>
      </View>
    </View>
  );
}
