// The eager lists every screen joins against. `hello` carries them, and the session subscribes to
// each, so pushes keep them current.

import type {
  AgentsSections,
  AgentView,
  BoardTaskView,
  ConversationsSections,
  ConversationSummary,
  InboxSections,
  InteractionView,
  MachinesSections,
  MachineView,
  ProjectsSections,
  ProjectView,
} from "@eta/client-contracts";
import { eager } from "../wire/target";

export const agents = (): AgentView[] =>
  eager<AgentsSections["list"]>("agents", "list") ?? [];
export const machines = (): MachineView[] =>
  eager<MachinesSections["list"]>("machines", "list") ?? [];
export const projects = (): ProjectView[] =>
  eager<ProjectsSections["list"]>("projects", "list") ?? [];
export const conversations = (): ConversationSummary[] =>
  eager<ConversationsSections["list"]>("conversations", "list") ?? [];
export const interactions = (): InteractionView[] =>
  eager<InboxSections["list"]>("inbox", "list") ?? [];
export const boardTasks = (): BoardTaskView[] =>
  eager<BoardTaskView[]>("tasks", "list") ?? [];

export const agentById = (id: string | null | undefined): AgentView | undefined =>
  id === null || id === undefined ? undefined : agents().find((agent) => agent.id === id);
export const projectById = (id: string | null | undefined): ProjectView | undefined =>
  id === null || id === undefined ? undefined : projects().find((project) => project.id === id);
export const machineById = (id: string | null | undefined): MachineView | undefined =>
  id === null || id === undefined ? undefined : machines().find((machine) => machine.id === id);

/** The questions waiting for the user, newest first. */
export const pendingInteractions = (): InteractionView[] =>
  interactions().filter((interaction) => interaction.status === "pending");
