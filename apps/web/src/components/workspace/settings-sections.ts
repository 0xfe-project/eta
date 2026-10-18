import type { Icon } from "@phosphor-icons/react";
import type { SettingsSection } from "./workspace-store";
import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { LinkIcon } from "@phosphor-icons/react/Link";
import { PackageIcon } from "@phosphor-icons/react/Package";
import { PaletteIcon } from "@phosphor-icons/react/Palette";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { capabilities } from "@/lib/capabilities";
import { translate } from "@/lib/i18n";
import { useNeedsAttention } from "@/queries/providers";

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
    value: "approvals",
    get label() {
      return translate("settings:sections.approvals");
    },
    icon: ShieldCheckIcon,
  },
  {
    value: "connections",
    get label() {
      return translate("connections:title");
    },
    icon: LinkIcon,
  },
  {
    value: "machines",
    get label() {
      return translate("machines:title");
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
      (value === "connections" && !capabilities.connections)
    ),
);

/** The sections with something the user has to act on. */
export function useSettingsAttention(): Partial<
  Record<SettingsSection, boolean>
> {
  return { providers: useNeedsAttention() };
}
