import { defineMessages } from "../../i18n/messages";

/** The conversation view's own lines and what its commands say in the status area. */
export const conversationMessages = defineMessages({
  en: {
    loading: "Loading…",
    missing: "This conversation was not found",
    hostTooOld: "This host is too old to send messages from here",
    replyingOne: "{names} is replying",
    replyingMany: "{names} are replying",
    stopKey: "{key} to stop",
    steerKey: "{key} to steer",
    nameSeparator: ", ",
    nobody:
      "Nobody took this message: this conversation has no steward, so name a member with @",
    openFirst: "Open a conversation first",
    noSuchConversation: "No conversation called {name}",
    severalConversations:
      "Several conversations match {name}: {names}. Say more of the name.",
    usage: "Usage: {usage}",
  },
  zh: {
    loading: "载入中…",
    missing: "找不到这个对话",
    hostTooOld: "host 版本太旧，不能在这里发消息",
    replyingOne: "{names} 正在回复",
    replyingMany: "{names} 正在回复",
    stopKey: "{key} 停止",
    steerKey: "{key} 插话",
    nameSeparator: "、",
    nobody: "没有人接这条消息：这个对话没有主理人，用 @ 指定成员",
    openFirst: "先打开一个对话",
    noSuchConversation: "没有叫 {name} 的对话",
    severalConversations: "有几个对话都匹配 {name}：{names}。名字写全一些。",
    usage: "用法：{usage}",
  },
});
