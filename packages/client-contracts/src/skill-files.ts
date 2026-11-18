/** File management only; these views do not describe session skill discovery. */
export const SKILL_FILE_LIMITS = {
  textBytes: 1_048_576,
  imageBytes: 3_145_728,
  imagePixels: 20_000_000,
  batch: 200,
  entries: 2_000,
  depth: 8,
} as const;

export interface SkillTarget {
  machineId: string;
  home: string;
  scope: "personal" | "project";
  projectId?: string;
  /** Returned by list; required on later calls to prevent retargeting after reconnect. */
  epoch?: number;
  projectPath?: string;
}

/** Sent only by the primary, after checking its project/machine records. */
export interface SkillFileLocation {
  home: string;
  scope: "personal" | "project";
  projectPath?: string;
}
export interface SkillFileEntry {
  path: string;
  kind: "file" | "directory" | "blocked";
  size: number;
  reason?: string;
}
export interface SkillSummary extends SkillFileEntry {
  name: string;
  description: string;
  writable: boolean;
  diagnostics: string[];
}
export interface SkillDirectory {
  entries: SkillFileEntry[];
  next: number | null;
}
export interface SkillList {
  root: string;
  exists: boolean;
  entries: SkillSummary[];
  next: number | null;
}
export type SkillFileContent =
  | {
      kind: "text";
      text: string;
      version: string;
      size: number;
      diagnostics: string[];
      preview?: { body: string; metadata: string };
    }
  | {
      kind: "image";
      base64: string;
      mime: string;
      width: number;
      height: number;
      size: number;
    }
  | { kind: "unsupported"; size: number; reason: string };
export interface SkillDeletePlan {
  root: string;
  path: string;
  name: string;
  shared: boolean;
  irreversible: true;
  entries: SkillFileEntry[];
  count: number;
  version: string;
}
export interface SkillFileArgs {
  list: { offset?: number };
  open: { skill: string };
  directory: { detail: string; path: string; offset?: number };
  read: { detail: string; path: string };
  close: { detail: string };
  create: { skill: string; text: string };
  save: { skill: string; text: string; version: string };
  planDelete: { skill: string };
  delete: { skill: string; version: string };
}
export interface SkillFileResults {
  list: SkillList;
  open: {
    detail: string;
    path: string;
    writable: boolean;
    diagnostics: string[];
  };
  directory: SkillDirectory;
  read: SkillFileContent;
  close: Record<string, never>;
  create: { path: string; version: string; diagnostics: string[] };
  save: { path: string; version: string; diagnostics: string[] };
  planDelete: SkillDeletePlan;
  delete: Record<string, never>;
}
export type SkillFileRequest = {
  [A in keyof SkillFileArgs]: {
    action: A;
    location: SkillFileLocation;
    args: SkillFileArgs[A];
  };
}[keyof SkillFileArgs];
export type SkillFileResult = SkillFileResults[keyof SkillFileResults];
