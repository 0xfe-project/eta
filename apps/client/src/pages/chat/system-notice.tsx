import type { MessageView } from "@eta/client-contracts";
import { captainProposalOf, systemNoticeOf } from "@eta/client-contracts";
import { View } from "nsh";
import { colors, Label, row } from "../../components";
import { space } from "../../components/tokens";
import { uiText } from "../../i18n";
import { useHost } from "../../services/host";

/** A row drawn as a notice: a system row, except Captain's proposals, which stay cards. */
/** How wide a notice's text runs between its rules. */
const noticeWidth = 560;

export function isSystemNotice(message: MessageView): boolean {
  return message.kind === "system" && captainProposalOf(message) === undefined;
}

/**
 * A system row: something that happened to the conversation, not something said in it. One
 * centred line between two hairlines, in the reader's language; no face, no bubble, no time.
 * Agents are named by what they are called now, so a renamed agent's rows follow the rename.
 */
export function SystemNotice(props: { item: MessageView; phone: boolean }) {
  const host = useHost();
  const c = colors();
  const name = (id: string) =>
    host.agent(id)?.name ?? uiText("taskDeletedAgent");
  const text = () => {
    const notice = systemNoticeOf(props.item);
    switch (notice.kind) {
      case "stewardChanged":
        return uiText("systemStewardChanged", {
          to: name(notice.to),
          from: name(notice.from),
        });
      case "stewardSet":
        return uiText("systemStewardSet", { to: name(notice.to) });
      case "stewardCleared":
        return uiText("systemStewardCleared", { from: name(notice.from) });
      case "stewardLeft":
        return uiText("systemStewardLeft", { from: name(notice.from) });
      case "wakeBudget":
        return uiText("systemWakeBudget", { budget: notice.budget });
      case "createdByCaptain":
        return uiText("systemCreatedByCaptain");
      case "routineReport":
        return notice.title === null
          ? uiText("systemRoutineReportUntitled", { name: notice.name })
          : uiText("systemRoutineReport", {
              name: notice.name,
              title: notice.title,
            });
      case "text":
        return notice.text;
    }
  };
  const rule = () => (
    <View
      style={{
        flex: 1,
        minWidth: space[16],
        height: 1,
        backgroundColor: c().border,
      }}
    />
  );
  return (
    <View
      testID="system-notice"
      style={{
        ...row,
        alignSelf: "stretch",
        gap: space[12],
        paddingVertical: space[8],
        paddingHorizontal: props.phone ? 0 : space[16],
      }}
    >
      {rule()}
      <View selectable style={{ flexShrink: 1, maxWidth: noticeWidth }}>
        <Label variant="caption" tone="muted" style={{ textAlign: "center" }}>
          {text()}
        </Label>
      </View>
      {rule()}
    </View>
  );
}
