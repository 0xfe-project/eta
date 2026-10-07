export type WorkspaceView = "overview" | "tasks" | "memory" | "capabilities";
export interface Task {
  id: string;
  title: string;
  done: boolean;
}
