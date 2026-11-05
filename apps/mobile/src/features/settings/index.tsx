import { Header, Page } from "../../ui/Page";

import type { SettingsTab } from "../../nav/links";

export function SettingsScreen(_props: { tab: SettingsTab }) {
  return <Page><Header title="SettingsScreen" /></Page>;
}

export function MachineScreen(_props: { id: string }) {
  return <Page><Header title="MachineScreen" /></Page>;
}

