import { defineMessages } from "../../i18n/messages";

/** The texts a completion menu draws, worded as the lists in layers word them. */
export const completionMessages = defineMessages({
  en: {
    moreAbove: "↑ {count} more",
    moreBelow: "↓ {count} more",
  },
  zh: {
    moreAbove: "↑ 还有 {count} 项",
    moreBelow: "↓ 还有 {count} 项",
  },
});
