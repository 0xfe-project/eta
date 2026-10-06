export type WorkspaceView = "overview" | "tasks" | "memory" | "capabilities";
export type Message = { id: string; content: string };
export type Task = { id: string; title: string; done: boolean };
