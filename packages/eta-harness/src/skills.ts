/**
 * Skills — the procedures a session can be taught (port of eta-agent's
 * `harness/skills.ts`).
 *
 * A skill is a directory with a `SKILL.md` in it: frontmatter naming it and
 * saying when it is useful, then the instructions. Loading walks the roots,
 * honours the same ignore files a shell would, and — this is the part worth
 * being careful about — reports what it could not read instead of silently
 * loading less. A skill that fails to parse is a warning with a path, not an
 * absence the user cannot explain.
 *
 * Nothing here injects anything: the catalog block a model sees
 * (`formatSkillsForSystemPrompt`) lists names, descriptions and *locations*, and
 * the model reads the file when a task matches. Progressive disclosure is the
 * `read` tool's job, not a second API.
 *
 * Files are reached through `node:fs` directly; a relative root resolves against
 * the process's working directory, and symlinks are followed.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import ignore from "ignore";
import { parse } from "yaml";

export { formatSkillInvocation } from "./prompt-blocks";

/** A procedure loaded from a `SKILL.md`, or supplied by an application. */
export interface Skill {
  /** Stable name used for lookup and model-visible listings. */
  name: string;
  /** Short model-visible description of when to use the skill. */
  description: string;
  /** Full skill instructions. */
  content: string;
  /** Absolute path to the skill file, for a model-visible location and relative references. */
  filePath: string;
  /** Keep it out of the model-visible list while still allowing explicit invocation. */
  disableModelInvocation?: boolean | undefined;
}

/** Turn an unknown thrown value into an Error. */
function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}

type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

interface FileInfo {
  name: string;
  path: string;
  kind: "file" | "directory" | "other";
}

interface FsError {
  code: string;
  message: string;
}

function fsError(error: unknown): FsError {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "unknown";
  return {
    code: code === "ENOENT" ? "not_found" : code,
    message: toError(error).message,
  };
}

/** What a path is, after following symlinks. */
async function fileInfo(path: string): Promise<Result<FileInfo, FsError>> {
  try {
    const info = await stat(path);
    return {
      ok: true,
      value: {
        name: basename(path),
        path,
        kind: info.isFile()
          ? "file"
          : info.isDirectory()
            ? "directory"
            : "other",
      },
    };
  } catch (error) {
    return { ok: false, error: fsError(error) };
  }
}

async function listDir(dir: string): Promise<Result<FileInfo[], FsError>> {
  try {
    const names = await readdir(dir);
    const entries: FileInfo[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const info = await fileInfo(path);
      // A dangling link is not an entry worth reporting; it is simply nothing.
      if (info.ok) entries.push(info.value);
    }
    return { ok: true, value: entries };
  } catch (error) {
    return { ok: false, error: fsError(error) };
  }
}

async function readTextFile(path: string): Promise<Result<string, FsError>> {
  try {
    return { ok: true, value: await readFile(path, "utf8") };
  } catch (error) {
    return { ok: false, error: fsError(error) };
  }
}

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

export type SkillDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed"
  | "invalid_metadata";

/** Warning produced while loading skills. */
export interface SkillDiagnostic {
  /** Diagnostic severity. Currently only warnings are emitted. */
  type: "warning";
  /** Stable diagnostic code. */
  code: SkillDiagnosticCode;
  /** Human-readable diagnostic message. */
  message: string;
  /** Path associated with the diagnostic. */
  path: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}

/**
 * Load skills from one or more directories.
 *
 * Traverses directories recursively, loads `SKILL.md` files, loads direct root `.md` files with skill
 * frontmatter, honors ignore files, and returns diagnostics for invalid declared skill files. Missing input
 * directories are skipped.
 */
export async function loadSkills(
  dirs: string | string[],
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    const rootInfoResult = await fileInfo(resolve(dir));
    if (!rootInfoResult.ok) {
      if (rootInfoResult.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: rootInfoResult.error.message,
          path: dir,
        });
      }
      continue;
    }
    const rootInfo = rootInfoResult.value;
    if (rootInfo.kind !== "directory") continue;
    const result = await loadSkillsFromDirInternal(
      rootInfo.path,
      true,
      ignore(),
      rootInfo.path,
    );
    skills.push(...result.skills);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}

/**
 * Load skills from source-tagged directories.
 *
 * Source values are preserved exactly and attached to every loaded skill and diagnostic. The agent package does not
 * interpret source values; applications define their own provenance shape.
 */
export async function loadSourcedSkills<TSource, TSkill extends Skill = Skill>(
  inputs: Array<{ path: string; source: TSource }>,
  mapSkill: ((skill: Skill, source: TSource) => TSkill) | undefined,
): Promise<{
  skills: Array<{ skill: TSkill; source: TSource }>;
  diagnostics: Array<SkillDiagnostic & { source: TSource }>;
}> {
  const skills: Array<{ skill: TSkill; source: TSource }> = [];
  const diagnostics: Array<SkillDiagnostic & { source: TSource }> = [];
  for (const input of inputs) {
    const result = await loadSkills(input.path);
    for (const skill of result.skills) {
      skills.push({
        skill: mapSkill ? mapSkill(skill, input.source) : (skill as TSkill),
        source: input.source,
      });
    }
    for (const diagnostic of result.diagnostics)
      diagnostics.push({ ...diagnostic, source: input.source });
  }
  return { skills, diagnostics };
}

async function loadSkillsFromDirInternal(
  dir: string,
  includeRootFiles: boolean,
  ignoreMatcher: IgnoreMatcher,
  rootDir: string,
): Promise<{ skills: Skill[]; diagnostics: SkillDiagnostic[] }> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  const dirInfoResult = await fileInfo(resolve(dir));
  if (!dirInfoResult.ok) {
    if (dirInfoResult.error.code !== "not_found") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: dirInfoResult.error.message,
        path: dir,
      });
    }
    return { skills, diagnostics };
  }
  const dirInfo = dirInfoResult.value;
  if (dirInfo.kind !== "directory") return { skills, diagnostics };

  await addIgnoreRules(ignoreMatcher, dir, rootDir, diagnostics);

  const entriesResult = await listDir(dir);
  if (!entriesResult.ok) {
    diagnostics.push({
      type: "warning",
      code: "list_failed",
      message: entriesResult.error.message,
      path: dir,
    });
    return { skills, diagnostics };
  }
  const entries = entriesResult.value;

  for (const entry of entries) {
    if (entry.name !== "SKILL.md") continue;
    const fullPath = entry.path;
    if (entry.kind !== "file") continue;
    const relPath = relativeEnvPath(rootDir, fullPath);
    if (ignoreMatcher.ignores(relPath)) continue;

    const result = await loadSkillFromFile(fullPath, dirInfo.name);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
    return { skills, diagnostics };
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = entry.path;
    const kind = entry.kind;
    if (kind === "other") continue;

    const relPath = relativeEnvPath(rootDir, fullPath);
    const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
    if (ignoreMatcher.ignores(ignorePath)) continue;

    if (kind === "directory") {
      const result = await loadSkillsFromDirInternal(
        fullPath,
        false,
        ignoreMatcher,
        rootDir,
      );
      skills.push(...result.skills);
      diagnostics.push(...result.diagnostics);
      continue;
    }

    if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md"))
      continue;
    const result = await loadSkillFromFile(fullPath, dirInfo.name);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
  }

  return { skills, diagnostics };
}

async function addIgnoreRules(
  ig: IgnoreMatcher,
  dir: string,
  rootDir: string,
  diagnostics: SkillDiagnostic[],
): Promise<void> {
  const relativeDir = relativeEnvPath(rootDir, dir);
  const prefix = relativeDir ? `${relativeDir}/` : "";

  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    const info = await fileInfo(ignorePath);
    if (!info.ok) {
      if (info.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: info.error.message,
          path: ignorePath,
        });
      }
      continue;
    }
    if (info.value.kind !== "file") continue;
    const content = await readTextFile(ignorePath);
    if (!content.ok) {
      diagnostics.push({
        type: "warning",
        code: "read_failed",
        message: content.error.message,
        path: ignorePath,
      });
      continue;
    }
    const patterns = content.value
      .split(/\r?\n/)
      .map((line) => prefixIgnorePattern(line, prefix))
      .filter((line): line is string => Boolean(line));
    if (patterns.length > 0) ig.add(patterns);
  }
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

async function loadSkillFromFile(
  filePath: string,
  parentDirName: string,
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  const isDeclaredSkill =
    filePath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() === "SKILL.md";
  const rawContent = await readTextFile(filePath);
  if (!rawContent.ok) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: rawContent.error.message,
      path: filePath,
    });
    return { skill: null, diagnostics };
  }

  const parsed = parseFrontmatter<SkillFrontmatter>(rawContent.value);
  if (!parsed.ok) {
    if (isDeclaredSkill) {
      diagnostics.push({
        type: "warning",
        code: "parse_failed",
        message: parsed.error.message,
        path: filePath,
      });
    }
    return { skill: null, diagnostics };
  }

  const { frontmatter, body } = parsed.value;
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description
      : undefined;
  if (!isDeclaredSkill && (!description || description.trim() === "")) {
    return { skill: null, diagnostics };
  }

  for (const error of validateDescription(description)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message: error,
      path: filePath,
    });
  }

  const frontmatterName =
    typeof frontmatter.name === "string" ? frontmatter.name : undefined;
  const name = frontmatterName || parentDirName;
  for (const error of validateName(name, parentDirName)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message: error,
      path: filePath,
    });
  }

  if (!description || description.trim() === "") {
    return { skill: null, diagnostics };
  }

  return {
    skill: {
      name,
      description,
      content: body,
      filePath,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    },
    diagnostics,
  };
}

function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName)
    errors.push(
      `name "${name}" does not match parent directory "${parentDirName}"`,
    );
  if (name.length > MAX_NAME_LENGTH)
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(
      "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
    );
  }
  if (name.startsWith("-") || name.endsWith("-"))
    errors.push("name must not start or end with a hyphen");
  if (name.includes("--"))
    errors.push("name must not contain consecutive hyphens");
  return errors;
}

function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];
  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    );
  }
  return errors;
}

function parseFrontmatter<T extends Record<string, unknown>>(
  content: string,
): Result<{ frontmatter: T; body: string }, Error> {
  try {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---"))
      return { ok: true, value: { frontmatter: {} as T, body: normalized } };
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1)
      return { ok: true, value: { frontmatter: {} as T, body: normalized } };
    const yamlString = normalized.slice(4, endIndex);
    const body = normalized.slice(endIndex + 4).trim();
    return {
      ok: true,
      value: { frontmatter: (parse(yamlString) ?? {}) as T, body },
    };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

function relativeEnvPath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) return "";
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath.replace(/^\/+/, "");
}
