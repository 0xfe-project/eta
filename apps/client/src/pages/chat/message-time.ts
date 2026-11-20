import { formatLocale, uiText } from "../../i18n";
import { clock } from "../../services/host";

function messageDate(at: number) {
  const day = new Date(at);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const date = day.toDateString();
  if (date === today.toDateString()) return uiText("todayDate");
  if (date === yesterday.toDateString()) return uiText("yesterdayDate");
  return day.toLocaleDateString(formatLocale(), {
    month: "short",
    day: "numeric",
  });
}

export function messageTime(at: number, phone: boolean) {
  return phone ? clock(at) : `${messageDate(at)} ${clock(at)}`;
}
