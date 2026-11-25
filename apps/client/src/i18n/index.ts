import { context, locale, localeSettings, signal, Storage } from "nsh";
import { setLocale } from "nsh/i18n";
import { clientMessages } from "./messages";

export const languageChoices = ["system", "zh", "en"] as const;
export type LanguagePreference = (typeof languageChoices)[number];
type Language = Exclude<LanguagePreference, "system">;

const messages = {
  settings: ["Settings", "设置"],
  appearance: ["Appearance", "外观"],
  agents: ["Agents", "智能体"],
  modelServices: ["Model services", "模型服务"],
  machines: ["Machines", "机器"],
  mcpServers: ["MCP servers", "MCP 服务器"],
  externalAgents: ["External agents", "外部智能体"],
  runtimes: ["Runtimes", "运行方式"],
  archived: ["Archived", "已归档"],
  update: ["Update", "更新"],
  network: ["Network", "网络"],
  more: ["More", "更多"],
  chat: ["Chat", "聊天"],
  tasks: ["Tasks", "任务"],
  routines: ["Routines", "定时任务"],
  plugins: ["Plugins", "插件"],
  pending: ["Pending", "待处理"],
  captain: ["Captain", "Captain"],
  captainNoConversation: [
    "No conversation with Captain yet",
    "还没有和 Captain 对话",
  ],
  working: ["Working", "工作中"],
  idle: ["Idle", "空闲"],
  groups: ["Groups", "群组"],
  searchConversations: ["Search conversations", "搜索对话"],
  newConversation: ["New conversation", "新建对话"],
  newGroup: ["New group", "新建群组"],
  noConversations: ["No groups yet", "还没有群组"],
  expandSidebar: ["Expand sidebar", "展开侧栏"],
  collapseSidebar: ["Collapse sidebar", "收起侧栏"],
  resizeSidebar: ["Resize sidebar", "调整侧栏宽度"],
  resizePanel: ["Resize panel", "调整面板宽度"],
  resizeTaskRail: ["Resize task properties", "调整任务属性栏宽度"],
  back: ["Back", "返回"],
  close: ["Close", "关闭"],
  colorMode: ["Color mode", "颜色模式"],
  system: ["System", "跟随系统"],
  light: ["Light", "浅色"],
  dark: ["Dark", "深色"],
  palette: ["Palette", "色板"],
  paletteDefault: ["Default", "默认"],
  paletteCatppuccin: ["Catppuccin", "Catppuccin"],
  paletteDracula: ["Dracula", "Dracula"],
  paletteNord: ["Nord", "Nord"],
  paletteGruvbox: ["Gruvbox", "Gruvbox"],
  paletteTokyoNight: ["Tokyo Night", "Tokyo Night"],
  paletteSolarized: ["Solarized", "Solarized"],
  paletteRosePine: ["Rosé Pine", "Rosé Pine"],
  paletteOne: ["One", "One"],
  flavor: ["Dark flavor", "深色风味"],
  flavorHint: [
    "Used in dark mode. Light mode uses Latte.",
    "深色模式下使用；浅色模式固定为 Latte。",
  ],
  language: ["Language", "语言"],
  languageSystem: ["Follow system", "跟随系统"],
  chatWidth: ["Chat content width", "聊天内容宽度"],
  chatWidthHint: [
    "Applies to the transcript and the composer together. In a narrow column, some of them can look the same.",
    "聊天记录和输入框会一起调整。在较窄的窗口中，部分选项看起来可能一样。",
  ],
  picturesInMessages: ["Images in messages", "消息里的图片"],
  picturesInMessagesHint: [
    "Compact shows the image name where it was inserted; hover (tap on touch) to see it. Expanded shows image cards under the text. Saved on this device.",
    "紧凑：图片名留在原位，悬停（触屏上轻点）查看图片。展开：图片以卡片排在正文下方。仅保存在此设备。",
  ],
  picturesCompact: ["Compact", "紧凑"],
  picturesExpanded: ["Expanded", "展开"],
  extraNarrow: ["Extra narrow", "最窄"],
  narrow: ["Narrow", "窄"],
  standard: ["Standard", "标准"],
  full: ["Full", "占满"],
  interfaceFont: ["Interface font", "界面字体"],
  interfaceFontHint: [
    "The name of a font installed on this computer, used for everything in the app. Characters it lacks come from Eta Sans. Leave empty for Eta Sans. Saved in this browser only.",
    "输入本机已安装的字体名称。缺字时使用 Eta Sans。留空则使用 Eta Sans。仅保存在当前浏览器。",
  ],
  monoFont: ["Monospace font", "等宽字体"],
  monoFontHint: [
    "Used where the app lines things up: times, code, tool-call heads, labels. Characters it lacks come from the interface font, then Eta Sans. Leave empty to follow the interface font. Saved in this browser only.",
    "用于时间、代码、工具调用标题及其他需要对齐的标签。缺字时依次使用界面字体和 Eta Sans。留空则跟随界面字体。仅保存在当前浏览器。",
  ],
  sameAsInterface: ["Same as interface", "跟随界面字体"],
  invalidFont: [
    "Enter a single font name with at most 64 characters.",
    "请输入一个字体名称，最多 64 个字符。",
  ],
  conversationRail: ["Conversation rail", "对话索引"],
  conversationRailHint: [
    "When on, the chat's right edge shows a rail of replies (squares) and your messages (circles); click one to jump to it.",
    "打开后，聊天区右侧显示回复（方块）和你的消息（圆点）。点击即可跳转。",
  ],
  elementPicker: ["Element picker", "圈选元素"],
  elementPickerHint: [
    "When on, you can pick an element on the page and copy its component and source location.",
    "打开后，可以圈选页面上的元素并复制组件及源码位置。",
  ],
  pickerCopied: ["Copied source location", "已复制源码位置"],
  pickerCopyFailed: ["Could not copy source location", "无法复制源码位置"],
} as const;

export type Message = keyof typeof messages;

function systemLanguage(): Language {
  const preferred = localeSettings().languages;
  for (const tag of preferred.length ? preferred : [locale()]) {
    const code = tag.toLowerCase().split(/[-_]/)[0];
    if (code === "en" || code === "zh") return code;
  }
  return "en";
}

const languageKey = "eta.language.v1";
const preference = signal<LanguagePreference>("system");
function selectedLanguage(): Language {
  const value = preference();
  return value === "system" ? systemLanguage() : value;
}
export const LanguageSettings = context<
  ReturnType<typeof createLanguagePreference> | undefined
>(undefined);

export function createLanguagePreference() {
  let changed = false;

  function apply(value: LanguagePreference) {
    preference.set(value);
    setLocale(value === "system" ? null : value);
  }

  void Storage.getItem(languageKey)
    .then((saved) => {
      if (!changed && (saved === "en" || saved === "zh")) apply(saved);
    })
    .catch(() => {});

  return {
    preference,
    language: selectedLanguage,
    set(value: LanguagePreference) {
      changed = true;
      apply(value);
      void Storage.setItem(languageKey, value).catch(() => {});
    },
  };
}

export function useText() {
  return (message: Message) =>
    messages[message][selectedLanguage() === "zh" ? 1 : 0];
}

export function formatLocale() {
  return selectedLanguage() === "zh" ? "zh-CN" : "en-US";
}

export function uiText(
  key: keyof typeof clientMessages,
  values?: Record<string, unknown>,
) {
  const chinese = formatLocale() === "zh-CN";
  const text: string = clientMessages[key][chinese ? 1 : 0];
  return values
    ? text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name]))
    : text;
}

export function localizedText(english: string, chinese: string) {
  return selectedLanguage() === "zh" ? chinese : english;
}
