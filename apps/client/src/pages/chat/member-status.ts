import { formatLocale, uiText } from "../../i18n";

export const activeReply = (status: string) =>
  ["queued", "working", "stopping", "waiting_for_input"].includes(status);

const memberStates: Record<string, Parameters<typeof uiText>[0]> = {
  working: "memberWorking",
  running: "running",
  waiting_for_input: "waitingForInput",
  queued: "queued",
  stopping: "stopping",
};

export function memberStatus(status: string) {
  if (status === "idle") return uiText("idle");
  if (formatLocale() === "zh-CN" && Object.hasOwn(memberStates, status))
    return uiText(memberStates[status]!);
  return status.replaceAll("_", " ");
}
