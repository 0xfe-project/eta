import { defineMessages } from "../../i18n/messages";

export const setupMessages = defineMessages({
  en: {
    title: "Setup · Esc to leave; come back later with /setup",
    loading: "Reading the host…",
    providersProblem:
      "The setup cannot read the host's models: {problem}. Press Esc to leave.",
    stepAccounts: "Step 1 of 2: connect model accounts",
    stepAgents: "Step 2 of 2: create agents",
    next: "Next: create agents",
    noUsableModel:
      "No usable model yet. Connect an account first, then choose “Next” and press Enter.",
    agentsIntro:
      "One agent per persona card, on the model {model}. Cards that already have an agent are skipped.",
    agentsIntroNoModel:
      "No usable model, and an agent needs one: press ← to go back and connect an account.",
    noCards: "This host has no persona cards. Press Enter to finish.",
    built: "already created",
    creating: "Creating {name}…",
    agentsUnread:
      "Cannot read the host's agents right now. Press Enter to try again.",
    agentsFooter:
      "Space to tick · Enter to create · ← back to accounts · Esc to leave",
    done: "Agents created: {count}. Type /new to start your first conversation.",
    left: "Setup left. Type /setup to come back.",
  },
  zh: {
    title: "首次设置 · 按 Esc 离开，之后用 /setup 回来",
    loading: "正在读取 host…",
    providersProblem: "首次设置读不到 host 的模型：{problem}。按 Esc 离开。",
    stepAccounts: "第 1 步，共 2 步：绑模型账号",
    stepAgents: "第 2 步，共 2 步：建智能体",
    next: "下一步：建智能体",
    noUsableModel: "还没有可用模型。先连接一个账号，再选「下一步」按 Enter。",
    agentsIntro:
      "每张 persona 卡建一个智能体，用模型 {model}。已有智能体的卡会跳过。",
    agentsIntroNoModel:
      "还没有可用的模型，而智能体必须选一个：按 ← 回去连接一个账户。",
    noCards: "这台 host 没有 persona 卡。按 Enter 完成。",
    built: "已建",
    creating: "正在建 {name}…",
    agentsUnread: "现在读不到 host 的智能体列表。按 Enter 再试。",
    agentsFooter: "Space 勾选 · Enter 建立 · ← 回到账号 · Esc 离开",
    done: "建了 {count} 个智能体。输入 /new 开始第一个对话。",
    left: "已离开首次设置。输入 /setup 回来。",
  },
});
