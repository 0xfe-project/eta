import { formatLocale } from "../../i18n";

const copy = {
  source: ["Source", "来源"],
  runs: ["Runs", "运行"],
  env: ["Environment", "环境变量"],
  envShort: ["Env", "环境变量"],
  headers: ["Headers", "标头"],
  audit: ["Reads by agents", "智能体读取记录"],
  deletedAgent: ["Deleted agent", "已删除的智能体"],
  copySource: ["Copy source", "复制来源"],
  sourceCopied: ["Source copied", "已复制来源"],
  updateDetail: ["Pull the latest from the source", "从来源拉取最新版本"],
  removeDetail: ["Asks to confirm first", "先确认是否移除"],
  ok: ["OK", "确定"],
  select: ["Select a plugin", "选择插件"],
} as const;

export function pluginText(key: keyof typeof copy) {
  return copy[key][formatLocale().startsWith("zh") ? 1 : 0];
}
