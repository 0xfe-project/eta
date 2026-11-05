// Every way from one feature into another. Inside a feature, push with `open` from `stack.ts`.

import { AgentInfoScreen, ArtifactScreen, GroupInfoScreen } from "../features/group";
import { ChatScreen } from "../features/chat";
import { ArchivedScreen } from "../features/conversations";
import { NewAgentScreen, NewConversationScreen, NewGroupScreen } from "../features/create";
import { MachineScreen, SettingsScreen } from "../features/settings";
import { TaskScreen } from "../features/tasks";
import { open } from "./stack";

export type SettingsTab = "appearance" | "machines" | "connection";

export const go = {
  settings: (tab: SettingsTab = "appearance") =>
    open(`settings:${tab}`, () => <SettingsScreen tab={tab} />),
  machine: (id: string) => open(`machine:${id}`, () => <MachineScreen id={id} />),
  chat: (id: string) => open(`chat:${id}`, () => <ChatScreen id={id} />),
  archived: () => open("archived", () => <ArchivedScreen />),
  groupInfo: (id: string) => open(`group:${id}`, () => <GroupInfoScreen id={id} />),
  agentInfo: (id: string) => open(`agent:${id}`, () => <AgentInfoScreen id={id} />),
  artifact: (id: string, version?: number) =>
    open(`artifact:${id}:${version ?? ""}`, () => <ArtifactScreen id={id} version={version} />),
  task: (id: string) => open(`task:${id}`, () => <TaskScreen id={id} />),
  newConversation: () => open("new:conversation", () => <NewConversationScreen />),
  newGroup: () => open("new:group", () => <NewGroupScreen />),
  newAgent: () => open("new:agent", () => <NewAgentScreen />),
};
