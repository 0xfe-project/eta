import enAgents from "./en/agents.json";
import enArtifacts from "./en/artifacts.json";
import enChat from "./en/chat.json";
import enCommon from "./en/common.json";
import enConnections from "./en/connections.json";
import enEmail from "./en/email.json";
import enLlm from "./en/llm.json";
import enMachines from "./en/machines.json";
import enMcp from "./en/mcp.json";
import enNavigation from "./en/navigation.json";
import enOnboard from "./en/onboard.json";
import enOverview from "./en/overview.json";
import enProviders from "./en/providers.json";
import enRoutines from "./en/routines.json";
import enSettings from "./en/settings.json";
import enTasks from "./en/tasks.json";
import enValidation from "./en/validation.json";
import zhAgents from "./zh/agents.json";
import zhArtifacts from "./zh/artifacts.json";
import zhChat from "./zh/chat.json";
import zhCommon from "./zh/common.json";
import zhConnections from "./zh/connections.json";
import zhEmail from "./zh/email.json";
import zhLlm from "./zh/llm.json";
import zhMachines from "./zh/machines.json";
import zhMcp from "./zh/mcp.json";
import zhNavigation from "./zh/navigation.json";
import zhOnboard from "./zh/onboard.json";
import zhOverview from "./zh/overview.json";
import zhProviders from "./zh/providers.json";
import zhRoutines from "./zh/routines.json";
import zhSettings from "./zh/settings.json";
import zhTasks from "./zh/tasks.json";
import zhValidation from "./zh/validation.json";

// English is the source of truth for compile-time translation key checking.
export const en = {
  common: enCommon,
  agents: enAgents,
  artifacts: enArtifacts,
  chat: enChat,
  llm: enLlm,
  machines: enMachines,
  mcp: enMcp,
  connections: enConnections,
  email: enEmail,
  navigation: enNavigation,
  onboard: enOnboard,
  overview: enOverview,
  providers: enProviders,
  routines: enRoutines,
  settings: enSettings,
  tasks: enTasks,
  validation: enValidation,
} as const;

export const zh = {
  common: zhCommon,
  agents: zhAgents,
  artifacts: zhArtifacts,
  chat: zhChat,
  llm: zhLlm,
  machines: zhMachines,
  mcp: zhMcp,
  connections: zhConnections,
  email: zhEmail,
  navigation: zhNavigation,
  onboard: zhOnboard,
  overview: zhOverview,
  providers: zhProviders,
  routines: zhRoutines,
  settings: zhSettings,
  tasks: zhTasks,
  validation: zhValidation,
} as const;

export const resources = { en, zh } as const;

export const namespaces = [
  "common",
  "agents",
  "artifacts",
  "chat",
  "machines",
  "mcp",
  "connections",
  "email",
  "llm",
  "navigation",
  "onboard",
  "overview",
  "providers",
  "routines",
  "settings",
  "tasks",
  "validation",
] as const;
