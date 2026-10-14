import type { Icon } from "@phosphor-icons/react";
import type { SettingsSection } from "./workspace-store";
import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { ChartLineIcon } from "@phosphor-icons/react/ChartLine";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { PaletteIcon } from "@phosphor-icons/react/Palette";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { useNeedsAttention } from "@/queries/llm";

// Settings' sections, listed by the dialog and by the phone's 更多 page.

export const settingsSections: {
  value: SettingsSection;
  label: string;
  icon: Icon;
}[] = [
  { value: "agents", label: "智能体", icon: RobotIcon },
  { value: "bundles", label: "环境包", icon: PackageIcon },
  { value: "providers", label: "模型服务", icon: PlugsConnectedIcon },
  { value: "connections", label: "连接", icon: LinkIcon },
  { value: "computers", label: "远程电脑", icon: DesktopIcon },
  { value: "archived", label: "已归档", icon: ArchiveIcon },
  { value: "appearance", label: "外观", icon: PaletteIcon },
  { value: "logs", label: "日志", icon: ChartLineIcon },
];

/** The sections with accounts the user has to act on. */
export function useSettingsAttention(): Partial<
  Record<SettingsSection, boolean>
> {
  // 模型服务 lists every account; 连接 only Grok's, for the grok plugin.
  return {
    providers: useNeedsAttention(),
    connections: useNeedsAttention(true),
  };
}
