import type { Icon } from "@phosphor-icons/react";
import type { SettingsSection } from "./workspace-store";
import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { PaletteIcon } from "@phosphor-icons/react/Palette";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { capabilities } from "@/lib/capabilities";
import { translate } from "@/lib/i18n";
import { useNeedsAttention } from "@/queries/llm";

// Settings' sections, listed by the dialog and by the phone's 更多 page.

const everySection: {
  value: SettingsSection;
  label: string;
  icon: Icon;
}[] = [
  {
    value: "agents",
    get label() {
      return translate("common:entities.agents");
    },
    icon: RobotIcon,
  },
  {
    value: "bundles",
    get label() {
      return translate("bundles:title");
    },
    icon: PackageIcon,
  },
  {
    value: "providers",
    get label() {
      return translate("providers:title");
    },
    icon: PlugsConnectedIcon,
  },
  {
    value: "connections",
    get label() {
      return translate("connections:title");
    },
    icon: LinkIcon,
  },
  {
    value: "computers",
    get label() {
      return translate("computers:title");
    },
    icon: DesktopIcon,
  },
  {
    value: "archived",
    get label() {
      return translate("chat:groups.archived.title");
    },
    icon: ArchiveIcon,
  },
  {
    value: "appearance",
    get label() {
      return translate("settings:sections.appearance");
    },
    icon: PaletteIcon,
  },
];

/**
 * What this host offers, minus the surfaces whose API is not on it yet (capabilities.ts names the
 * phase for each). Hidden here rather than broken there: a section that cannot load is a bug the
 * user found, not a setting.
 */
export const settingsSections = everySection.filter(
  ({ value }) =>
    !(
      (value === "bundles" && !capabilities.bundles) ||
      (value === "connections" && !capabilities.connections) ||
      (value === "computers" && !capabilities.computers)
    ),
);

/** The sections with accounts the user has to act on. */
export function useSettingsAttention(): Partial<
  Record<SettingsSection, boolean>
> {
  // 模型服务 lists every account; 连接 only Grok's, for the grok plugin. Both hooks always run
  // (hooks cannot be conditional); a surface this host does not serve never needs attention.
  const grok = useNeedsAttention(true);
  return {
    providers: useNeedsAttention(),
    connections: capabilities.connections ? grok : false,
  };
}
