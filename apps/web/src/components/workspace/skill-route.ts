// Directory filters are addressable. The detail adds the directory entry path and
// the last known roots, so a moved project/home never silently becomes another target.
export interface SkillSearch {
  device?: string | undefined;
  scope?: "project" | undefined;
  project?: string | undefined;
  q?: string | undefined;
}

export interface SkillDetailSearch extends SkillSearch {
  skill?: string | undefined;
  home?: string | undefined;
  projectPath?: string | undefined;
}

export function validateSkillSearch(
  input: Record<string, unknown>,
): SkillSearch {
  const string = (key: string) => {
    const value = input[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const project = input.scope === "project";
  return {
    device: string("device"),
    scope: project ? "project" : undefined,
    project: project ? string("project") : undefined,
    q: string("q"),
  };
}

export function validateSkillDetailSearch(
  input: Record<string, unknown>,
): SkillDetailSearch {
  return {
    ...validateSkillSearch(input),
    skill: typeof input.skill === "string" ? input.skill : undefined,
    home: typeof input.home === "string" ? input.home : undefined,
    projectPath:
      input.scope === "project" && typeof input.projectPath === "string"
        ? input.projectPath
        : undefined,
  };
}
