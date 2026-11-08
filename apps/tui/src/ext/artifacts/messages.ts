import { defineMessages } from "../../i18n/messages";

/** What `/artifacts` says. */
export const artifactMessages = defineMessages({
  en: {
    title: "Artifacts",
    empty: "No artifacts yet",
    loading: "Loading…",
    validForAnHour: "Valid for an hour. Open it in a browser",
    publicAddress: "Public: {url}",
    cannotPreview:
      "This kind cannot be previewed. Download it from the web or desktop app",
    copied: "Address copied",
    listFooter: "↑↓ move · Enter open · Esc close",
    previewFooter: "y copy the address · Esc back",
    plainFooter: "Esc back",
    justNow: "just now",
    minutesAgo: "{count}m ago",
    hoursAgo: "{count}h ago",
    daysAgo: "{count}d ago",
  },
  zh: {
    title: "产物",
    empty: "还没有产物",
    loading: "载入中…",
    validForAnHour: "一小时内有效，在浏览器里打开",
    publicAddress: "公开地址：{url}",
    cannotPreview: "这一类产物不能预览，在网页或桌面端下载",
    copied: "已复制地址",
    listFooter: "↑↓ 移动 · Enter 打开 · Esc 关闭",
    previewFooter: "y 复制地址 · Esc 返回",
    plainFooter: "Esc 返回",
    justNow: "刚刚",
    minutesAgo: "{count} 分钟前",
    hoursAgo: "{count} 小时前",
    daysAgo: "{count} 天前",
  },
});
