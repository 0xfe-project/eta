export const conversationsMessages = {
  archiveGroupBody: [
    "It leaves the sidebar. Its conversation and tasks are kept, and you can restore it in Settings › Archived.",
    "归档后它从侧边栏移走，对话和任务都保留，可以在 设置 › 已归档 里恢复。",
  ],
  archiveGroupMenu: ["Archive…", "归档…"],
  archiveGroupOneRunning: [
    "1 reply is still running. Archiving does not stop it.",
    "还有 1 个回复在进行，归档不会停掉它。",
  ],
  archiveGroupRunning: [
    "{{count}} replies are still running. Archiving does not stop them.",
    "还有 {{count}} 个回复在进行，归档不会停掉它们。",
  ],
  archiveGroupTitle: ["Archive “{{name}}”?", "归档「{{name}}」？"],
  groupName: ["Group name", "群组名称"],
  groupNameTaken: ["A group with this name already exists.", "已有同名群组。"],
  groupsReadOnly: [
    "This connection cannot change groups.",
    "这个连接不能修改群组。",
  ],
  renameGroupMenu: ["Rename…", "重命名…"],
  resetContextMenu: ["Clear context…", "清理上下文…"],
  resetContextTitle: [
    "Clear the context of “{{name}}”?",
    "清理「{{name}}」的上下文？",
  ],
  resetContextBody: [
    "Every member starts over with an empty context and only sees what is said from now on. The messages stay in the conversation. Use it when the context has decayed after many compactions.",
    "所有成员会以空上下文重新开始，只能看到之后的发言。对话里的消息都保留。适合多次压缩后上下文变差的时候使用。",
  ],
  resetContextRunning: [
    "A reply is still running. Stop it first.",
    "还有回复在进行，请先停止。",
  ],
  resetContextConfirm: ["Clear context", "清理上下文"],
  renameGroupTitle: ["Rename group", "重命名群组"],
  browseDirectories: ["Browse directories", "浏览目录"],
  createAnAgentFirstInSettings: [
    "No agents yet. Make one in Settings first.",
    "还没有智能体。先在设置里建一个。",
  ],
  searchDirectories: ["Search directories", "搜索目录"],
  useThisDirectory: ["Use this directory", "使用此目录"],
  groupArchivedToast: ["Group archived", "群组已归档"],
  groupArchiveFailed: ["Could not archive the group", "没能归档这个群组"],
} as const;
