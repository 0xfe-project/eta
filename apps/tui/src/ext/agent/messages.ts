import { defineMessages } from "../../i18n/messages";

export const agentMessages = defineMessages({
  en: {
    pickTitle: "Edit which agent?",
    notFound: "No agent matches {text}",
    gone: "Agent {id} is no longer on the host",
    noState: "The host did not send {target}",
    updated: "Updated {name}",
    noChange: "No changes to {name}",
    fileProblemsTitle: "{name} was not changed: the file has problems",
    hostRefusedTitle: "{name} was not changed: the host refused",
    uncheckedTitle:
      "{name} was not changed: the host could not be asked for its current settings",
    shellGone:
      "Nothing was sent: the connection ended while you edited {name}. What you wrote is kept; the files are listed when eta connects again",
    shellGoneBefore:
      "Nothing was opened: the connection to the host changed before {name} was ready to edit",
    keptTitle:
      "What you wrote in an edit cut off by the connection is kept here",
    keptFooter: "Any key closes",
    listFailed: "could not list them: {reason}",
    conflictTitle:
      "{name} was not changed: it was changed on the host while you edited",
    conflictLine:
      "Enter opens the file again with the host's values; your version is kept at {path}",
    guideSavedEdit:
      "Changed on the host while you edited. Your version is kept at {path}; copy from it what you still want.",
    problemsFooter: "Enter to edit the file again · Esc to discard the changes",
    syntax: "line {line}, column {column}: {message}",
    duplicateKey:
      "line {line}, column {column}: {key} is written more than once",
    notMapping: "The file must be a list of keys and values, such as name: Ada",
    unknownKey: "{key}: not a key of an agent",
    missingName: "name: missing; an agent needs a name",
    blankName: "name: empty; an agent needs a name",
    wrongTypeText: "{key}: must be text",
    wrongTypeTextOrNull: "{key}: must be text or null",
    wrongTypeList: "{key}: must be a list of names, such as [a, b]",
    unknownRuntime: "runtime: {value} is not one of {choices}",
    unknownThinkingLevel:
      "thinkingLevel: {value} is not one of {choices}, or null",
    modelFormat: "model: {value} is not provider:modelId",
    modelRuntime:
      "model: a {runtime} agent runs {runtime}:<model> or null, not {value}",
    hostWords: "The host says: {message}",
    guideApply:
      "Agent {name}. Save and close the editor to apply; close it without saving to leave the agent as it is.",
    guideName: "name: the agent's name; it cannot be empty.",
    guidePersona:
      'persona: a persona card, or "" for the default card. Cards: {list}',
    guideRuntime: "runtime: one of {list}.",
    guideModel:
      "model: provider:modelId; an agent on eta needs one. On an external runtime it is runtime:modelId, and null is that runtime's default.",
    guideEtaModels: "  eta models: {list}",
    guideRuntimeModels: "  {runtime} models: {list}",
    guideRuntimesFailed:
      "  The external runtimes' models could not be listed: {reason}",
    guideThinking: "thinkingLevel: one of {list}, or null for the default.",
    guideMachine:
      "machineId: a machine's id, or null to run on the project's machine. Machines: {list}",
    guidePlugins:
      "plugins: a list of plugin names, such as [a, b]. Plugins: {list}",
    guideInstructions:
      "instructions: standing instructions. For several lines keep the | and indent each line by two spaces.",
    listNone: "none",
    listMore: "{list}, and {count} more",
    needsConfig: "{name} (needs configuring)",
    named: "{id} ({name})",
  },
  zh: {
    pickTitle: "编辑哪个智能体？",
    notFound: "没有和 {text} 对得上的智能体",
    gone: "host 上已经没有智能体 {id}",
    noState: "host 没有送来 {target}",
    updated: "已更新 {name}",
    noChange: "{name} 没有改动",
    fileProblemsTitle: "{name} 没有改动：文件有问题",
    hostRefusedTitle: "{name} 没有改动：host 拒绝了",
    uncheckedTitle: "{name} 没有改动：没能向 host 查到它现在的设定",
    shellGone:
      "什么也没发送：编辑 {name} 期间连接结束了。你写的内容已保存，下次连上时会列出文件",
    shellGoneBefore:
      "没有打开编辑器：{name} 准备好编辑之前，和 host 的连接换了",
    keptTitle: "连接中断的编辑里你写的内容保存在这些文件",
    keptFooter: "按任意键关闭",
    listFailed: "没能列出：{reason}",
    conflictTitle: "{name} 没有改动：编辑期间它在 host 上被改过",
    conflictLine:
      "按 Enter 重新打开文件，内容换成 host 现在的值；你这次写的版本保存在 {path}",
    guideSavedEdit:
      "编辑期间它在 host 上被改过。你这次写的版本保存在 {path}，需要的内容从那里抄回来。",
    problemsFooter: "Enter 重新编辑文件 · Esc 放弃改动",
    syntax: "第 {line} 行第 {column} 列：{message}",
    duplicateKey: "第 {line} 行第 {column} 列：{key} 写了不止一次",
    notMapping: "文件要写成键和值，例如 name: Ada",
    unknownKey: "{key}：智能体没有这个键",
    missingName: "name：缺了；智能体要有名字",
    blankName: "name：是空的；智能体要有名字",
    wrongTypeText: "{key}：要写文字",
    wrongTypeTextOrNull: "{key}：要写文字或 null",
    wrongTypeList: "{key}：要写名字的列表，例如 [a, b]",
    unknownRuntime: "runtime：{value} 不在 {choices} 之中",
    unknownThinkingLevel:
      "thinkingLevel：{value} 不在 {choices} 之中，也不是 null",
    modelFormat: "model：{value} 不是 provider:modelId 的写法",
    modelRuntime:
      "model：{runtime} 运行时的智能体要写 {runtime}:<模型> 或 null，不能写 {value}",
    hostWords: "host 的回答：{message}",
    guideApply:
      "智能体 {name}。保存并关掉编辑器就应用；不保存直接关掉则不改动。",
    guideName: "name：智能体的名字，不能为空。",
    guidePersona: 'persona：persona 卡片，"" 表示默认卡片。可选：{list}',
    guideRuntime: "runtime：{list} 之一。",
    guideModel:
      "model：provider:modelId；eta 运行时的智能体必须写一个。外部运行时写 runtime:modelId，null 表示该运行时的默认模型。",
    guideEtaModels: "  eta 的模型：{list}",
    guideRuntimeModels: "  {runtime} 的模型：{list}",
    guideRuntimesFailed: "  没能列出外部运行时的模型：{reason}",
    guideThinking: "thinkingLevel：{list} 之一，null 表示用默认档。",
    guideMachine:
      "machineId：机器的 id，null 表示在项目所在的机器上运行。可选：{list}",
    guidePlugins: "plugins：插件名的列表，例如 [a, b]。可选：{list}",
    guideInstructions:
      "instructions：常驻指示。写多行时保留 |，每行缩进两个空格。",
    listNone: "没有",
    listMore: "{list}，另有 {count} 项",
    needsConfig: "{name}（需要先配置）",
    named: "{id}（{name}）",
  },
});
