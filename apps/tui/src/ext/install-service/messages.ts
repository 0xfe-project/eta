import { defineMessages } from "../../i18n/messages";

export const installServiceMessages = defineMessages({
  en: {
    alreadyResident:
      "Already connected to a resident host; nothing to install.",
    title: "Install a resident host",
    willInterrupt:
      "Moving to the service stops the temporary host and interrupts:",
    mayInterrupt:
      "The host cannot tell what is running; work in progress may be interrupted.",
    reply: "Replies: {count}",
    task: "Tasks: {count}",
    routine: "Routines: {count}",
    confirm: "Enter to install · Esc to cancel",
  },
  zh: {
    alreadyResident: "已经连着常驻 host，不用安装。",
    title: "安装常驻 host",
    willInterrupt: "改用服务会停掉临时 host，中断这些进行中的工作：",
    mayInterrupt: "host 说不清有什么在跑，进行中的工作可能会被中断。",
    reply: "回复：{count}",
    task: "任务：{count}",
    routine: "定时任务：{count}",
    confirm: "回车安装 · Esc 取消",
  },
});
