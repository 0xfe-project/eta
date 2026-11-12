import { defineMessages } from "../../../i18n/messages";

/** The lines the transcript says about the conversation rather than in it. */
export const feedMessages = defineMessages({
  en: {
    joined: "Joined {names}'s reply",
    replying: "Replying…",
    unreadable: "Replying, but its session cannot be read",
    queued: "Queued",
    waiting: "Waiting for your answer: {question}",
    waitingBare: "Waiting for your answer",
    stewardChanged: "{to} is now the steward, taking over from {from}.",
    stewardSet: "{to} is now the steward.",
    stewardCleared: "{from} is no longer the steward.",
    wakeBudget:
      "This message has used its {budget} wake-ups; later @mentions stay in the conversation and wake nobody until you write again.",
    taskDraft: "Task draft: {title}",
    taskCard: "Task #{number}: {title}",
    nameSeparator: ", ",
  },
  zh: {
    joined: "插进了 {names} 的回复",
    replying: "正在回复…",
    unreadable: "正在回复，但读不到它的会话",
    queued: "排队中",
    waiting: "等你回答：{question}",
    waitingBare: "等你回答",
    stewardChanged: "{to} 成为主理人，接替 {from}。",
    stewardSet: "{to} 成为主理人。",
    stewardCleared: "{from} 不再是主理人。",
    wakeBudget:
      "这条消息已经用完 {budget} 次唤醒；之后的 @ 只记入对话，等你再发言才会唤醒。",
    taskDraft: "任务草稿：{title}",
    taskCard: "任务 #{number}：{title}",
    nameSeparator: "、",
  },
});
