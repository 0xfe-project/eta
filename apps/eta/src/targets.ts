import type { WireService } from "@eta/server";

export type TargetName =
  | "agents"
  | "machines"
  | "projects"
  | "conversations"
  | "plugins"
  | "mcp"
  | "places"
  | "captain"
  | "routines"
  | "tasks"
  | "artifacts"
  | "usage"
  | "inbox"
  | "acp"
  | "llm"
  | "email"
  | `tasks.${string}`
  | `conversations.${string}`
  | `routines.${string}`
  | `email.${string}`;

export const taskTarget = (id: string): TargetName => `tasks.${id}`;
export const conversationTarget = (id: string): TargetName =>
  `conversations.${id}`;
export const routineTarget = (id: string): TargetName => `routines.${id}`;
export const emailTarget = (id: string): TargetName => `email.${id}`;

/** The targets a product-wide change moves, in the order `changed` used to list them. */
export const PRODUCT_TARGETS = [
  "agents",
  "machines",
  "projects",
  "conversations",
  "plugins",
  "mcp",
  "places",
  "captain",
  "routines",
] as const satisfies readonly TargetName[];

/** Say that a target moved. The only way the product announces state. */
export const announce = (wire: WireService, target: TargetName): void =>
  wire.pushNow(target);
