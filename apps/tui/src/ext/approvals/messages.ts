import { defineMessages } from "../../i18n/messages";

export const approvalsMessages = defineMessages({
  en: {
    title: "Tools that ask first",
    explain:
      "Applies to every conversation: a listed tool asks in the inbox to allow or deny before each call.",
    empty: "None: every tool runs without asking.",
    loading: "Loading…",
    listFooter: "↑↓ move · a add · d delete · Esc close",
    addLabel: "Tool name",
    addFooter: "Enter to add · Esc to go back",
    duplicate: "{name} is already in the list",
    tooLong: "A tool name is at most {max} characters",
    saving: "Saving…",
  },
  zh: {
    title: "先问再运行的工具",
    explain:
      "对所有会话生效：名单里的工具每次调用前，都会在待处理里问「允许或拒绝」。",
    empty: "没有，所有工具直接运行。",
    loading: "正在读取…",
    listFooter: "↑↓ 移动 · a 添加 · d 删除 · Esc 关闭",
    addLabel: "工具名",
    addFooter: "回车添加 · Esc 返回",
    duplicate: "{name} 已经在名单里了",
    tooLong: "工具名最长 {max} 个字",
    saving: "正在保存…",
  },
});
