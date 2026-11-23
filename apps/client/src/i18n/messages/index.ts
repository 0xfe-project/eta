import { artifactsMessages } from "./artifacts";
import { chatMessages } from "./chat";
import { commonMessages } from "./common";
import { connectionMessages } from "./connection";
import { conversationsMessages } from "./conversations";
import { machinesMessages } from "./machines";
import { modelSourcesMessages } from "./model-sources";
import { onboardingMessages } from "./onboarding";
import { pluginsMessages } from "./plugins";
import { routinesMessages } from "./routines";
import { settingsMessages } from "./settings";
import { skillsMessages } from "./skills";
import { tasksMessages } from "./tasks";
import { updatesMessages } from "./updates";
import { usageMessages } from "./usage";

export const clientMessages = {
  ...artifactsMessages,
  ...chatMessages,
  ...commonMessages,
  ...connectionMessages,
  ...conversationsMessages,
  ...machinesMessages,
  ...modelSourcesMessages,
  ...onboardingMessages,
  ...pluginsMessages,
  ...routinesMessages,
  ...settingsMessages,
  ...skillsMessages,
  ...tasksMessages,
  ...updatesMessages,
  ...usageMessages,
};
