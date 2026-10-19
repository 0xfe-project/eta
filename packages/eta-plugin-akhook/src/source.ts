/**
 * Where a session's rules come from, read again when a file changes.
 *
 * The configuration is the user's files, so it is the user's to edit while sessions run: a
 * `.akhook.yml` saved mid-conversation applies to the next tool call. The check is a `stat` per
 * file (and a look for a project file that appeared), cheap enough to do at every call.
 */
import type { ConfigInput } from "./types";
import { statSync } from "node:fs";
import process from "node:process";
import { loadConfig, projectConfigPath } from "./config";
import { RuleSet } from "./rules";

export interface RuleSourceOptions {
  /**
   * The session's working directory: where the nearest `.akhook.yml` is looked for. Without one
   * there is no project layer (a session whose files live on another machine), and commands run
   * from `fallbackRoot`.
   */
  cwd: string | undefined;
  /** Where commands run when there is no project; defaults to the process's directory. */
  fallbackRoot?: string | undefined;
  userConfigPath?: string | undefined;
  /** The host's configuration: layers merged after the user and project ones. */
  additional?: (() => readonly ConfigInput[]) | undefined;
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return -1;
  }
}

interface Loaded {
  rules: RuleSet;
  files: readonly string[];
  /** What the load was made from; a different one means read again. */
  signature: string;
}

export class RuleSource {
  private readonly options: RuleSourceOptions;
  private loaded: Loaded | undefined;

  constructor(options: RuleSourceOptions) {
    this.options = options;
  }

  private signature(
    files: readonly string[],
    additional: readonly ConfigInput[],
  ): string {
    const { cwd } = this.options;
    return [
      cwd === undefined ? "" : (projectConfigPath(cwd) ?? ""),
      ...files.map((file) => `${file}:${mtime(file)}`),
      // Text the host holds is part of what was loaded; a file's content is its mtime.
      ...additional.map((input) => ("text" in input ? input.text : "")),
    ].join("\0");
  }

  /** The rules now; throws `ConfigError` when a file is invalid. */
  get(): RuleSet {
    const additional = this.options.additional?.() ?? [];
    const previous = this.loaded;
    if (
      previous !== undefined &&
      this.signature(previous.files, additional) === previous.signature
    )
      return previous.rules;
    const loaded = loadConfig({
      cwd: this.options.cwd ?? this.options.fallbackRoot ?? process.cwd(),
      project: this.options.cwd !== undefined,
      userConfigPath: this.options.userConfigPath,
      additional,
    });
    const files = loaded.files;
    this.loaded = {
      rules: new RuleSet(loaded),
      files,
      signature: this.signature(files, additional),
    };
    return this.loaded.rules;
  }
}
