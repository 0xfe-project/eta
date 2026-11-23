import type { IconName } from "../components/icons";
import type { Message } from "../i18n";

export type Page =
  | "chat"
  | "tasks"
  | "routines"
  | "plugins"
  | "settings"
  | "captain"
  | "pending"
  | "more"
  | "onboard";

export type Destination = readonly [Page, Message, IconName];

export const sections: Destination[] = [
  ["chat", "chat", "chat"],
  ["tasks", "tasks", "tasks"],
  ["routines", "routines", "routines"],
  ["plugins", "plugins", "plugins"],
];

export interface Navigation {
  page: Page;
  onNavigate: (page: Page) => void;
}
