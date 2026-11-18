import type { Icon } from "@phosphor-icons/react";
import type { SettingsSection } from "./workspace-store";
import { ArchiveIcon } from "@phosphor-icons/react/Archive";
import { ArrowCircleUpIcon } from "@phosphor-icons/react/ArrowCircleUp";
import { DesktopIcon } from "@phosphor-icons/react/Desktop";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react/EnvelopeSimple";
import { GlobeSimpleIcon } from "@phosphor-icons/react/GlobeSimple";
import { PaletteIcon } from "@phosphor-icons/react/Palette";
import { PlugIcon } from "@phosphor-icons/react/Plug";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { ShieldCheckIcon } from "@phosphor-icons/react/ShieldCheck";
import { TerminalWindowIcon } from "@phosphor-icons/react/TerminalWindow";
import { translate } from "@/lib/i18n";

// Settings' sections, listed by the wide window's dialog and by the phone's settings page.

export const settingsSections: {
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
    value: "machines",
    get label() {
      return translate("machines:title");
    },
    icon: DesktopIcon,
  },
  {
    value: "mcp",
    get label() {
      return translate("mcp:title");
    },
    icon: PlugIcon,
  },
  {
    value: "acp",
    get label() {
      return translate("acp:title");
    },
    icon: TerminalWindowIcon,
  },
  {
    value: "email",
    get label() {
      return translate("email:title");
    },
    icon: EnvelopeSimpleIcon,
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
  {
    value: "host",
    get label() {
      return translate("settings:sections.host");
    },
    icon: GlobeSimpleIcon,
  },
  {
    value: "update",
    get label() {
      return translate("settings:sections.update");
    },
    icon: ArrowCircleUpIcon,
  },
];
