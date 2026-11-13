import { defineMessages } from "../../../i18n/messages";

/**
 * What the transcript says about itself: the way back to the bottom (its key, or with no key the
 * lines below), the search, the selection keys, copying.
 */
export const transcriptMessages = defineMessages({
  en: {
    bottomKey: "↓ {key} to go to the bottom",
    below: "↓ {count} lines below",
    noMatches: "No matches",
    selectKeys:
      "↑↓ move  v mark range  y copy lines  c copy item  space fold  Esc done",
    copiedOne: "Copied 1 line",
    copiedLines: "Copied {count} lines",
    copied: "Copied",
    nothingCopied: "Nothing to copy",
  },
  zh: {
    bottomKey: "↓ {key} 回到最下面",
    below: "↓ {count} 行在下面",
    noMatches: "没有匹配",
    selectKeys:
      "↑↓ 移动  v 标记区间  y 复制行  c 复制条目  空格 折叠  Esc 退出",
    copiedOne: "已复制 1 行",
    copiedLines: "已复制 {count} 行",
    copied: "已复制",
    nothingCopied: "没有可复制的内容",
  },
});
