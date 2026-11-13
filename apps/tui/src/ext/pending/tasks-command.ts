import type { SlashCommand } from "../../extensions/types";
import { openTaskList } from "./open";

export const tasksCommand: SlashCommand = {
  name: "tasks",
  args: [],
  summary: {
    en: "List the open tasks, and handle or comment on one",
    zh: "列出没关的任务，处理或留言",
  },
  examples: [
    {
      input: "/tasks",
      summary: { en: "List the open tasks", zh: "列出没关的任务" },
    },
  ],
  requiredOps: ["tasks.update", "tasks.comment"],
  run: openTaskList,
};
