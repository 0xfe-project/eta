/**
 * `git clone` on the machine, with `simple-git`: the progress git reports, a stop when asked, a
 * stall that ends it, and a failure that says what went wrong in words a person can act on.
 *
 * A repository chosen from `gh`'s list is cloned over the protocol gh is set to
 * (`gh config get git_protocol`), and over HTTPS with gh as git's credential helper
 * (`gh auth git-credential`, what `gh auth setup-git` configures): the user's gh login, and no
 * token kept by eta. Nothing may stop to ask a question nobody will see: prompts for a password
 * or a host key fail instead.
 */
import type { CloneProgress } from "@eta/client-contracts";
import type { PlaceFs, PlaceRunner } from "./system";
import process from "node:process";
import { cloneUrlOf, isCloneable, isGitRemote } from "@eta/client-contracts";
import { isGuardedEnvKey } from "@simple-git/argv-parser";
import { GitPluginError, simpleGit } from "simple-git";
import { classifyNetwork, PlaceError } from "./system";

/** A clone that writes nothing for this long is stuck, and is stopped like a cancelled one. */
const STALL_MS = 10 * 60 * 1000;

/** Nothing interactive: no terminal prompt, no credential manager window, no host-key question. */
const QUIET_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
};

/**
 * The environment a clone runs in: the machine's, less what simple-git guards against (an
 * editor, a pager, a work tree, an SSH command, a config of the shell's: nothing a fresh clone
 * should follow, and what simple-git would refuse to be handed), plus the quiet ones above.
 */
function cloneEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !isGuardedEnvKey(key.toLowerCase()))
      env[key] = value;
  return { ...env, ...QUIET_ENV };
}

/** What git's complaint means. */
export function classifyCloneFailure(stderr: string): PlaceError {
  const text = stderr.trim();
  const detail = text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-3)
    .join("\n")
    .slice(0, 500);
  if (/already exists and is not an empty directory/i.test(text))
    return new PlaceError("exists");
  if (
    /repository .* not found|not found[^\n]*repository|could not find repository|does not appear to be a git repository|ERROR: Repository not found/i.test(
      text,
    )
  )
    return new PlaceError("repo_not_found", detail);
  if (
    /authentication failed|could not read username|could not read password|permission denied \(publickey|host key verification failed|terminal prompts disabled|invalid username or password|returned error: 40[13]/i.test(
      text,
    )
  )
    return new PlaceError("auth", detail);
  if (classifyNetwork(text) !== undefined)
    return new PlaceError("network", detail);
  return new PlaceError("other", detail === "" ? "git clone failed" : detail);
}

export async function clone(input: {
  url: string;
  protocol?: "https" | "ssh";
  target: string;
  cwd: string;
  /** `gh` is signed in: an `owner/repo` with no protocol is cloned with its login. */
  useGh: boolean;
  run: PlaceRunner;
  fs: PlaceFs;
  /** The git program; a test hands in a scripted one. */
  git?: string;
  signal?: AbortSignal;
  onProgress?: (progress: CloneProgress) => void;
}): Promise<void> {
  const typed = input.url.trim();
  // Neither a remote git can clone nor `owner/repo` (an option dressed as a URL included).
  if (!isCloneable(typed)) throw new PlaceError("invalid");
  const shorthand = !isGitRemote(typed);
  const viaGh = shorthand && input.protocol === undefined && input.useGh;
  let protocol = input.protocol;
  if (viaGh) {
    const asked = await input.run(
      "gh",
      ["config", "get", "git_protocol", "-h", "github.com"],
      { timeoutMs: 10_000 },
    );
    protocol = asked.stdout.trim() === "ssh" ? "ssh" : "https";
  }
  const url = cloneUrlOf(typed, protocol);
  let last = "";
  const git = simpleGit({
    baseDir: input.cwd,
    ...(input.git === undefined
      ? {}
      : { binary: input.git, unsafe: { allowUnsafeCustomBinary: true } }),
    ...(input.signal === undefined ? {} : { abort: input.signal }),
    timeout: { block: STALL_MS },
    allowEnvironment: Object.keys(QUIET_ENV),
    ...(viaGh && protocol === "https"
      ? {
          config: [
            "credential.helper=",
            "credential.helper=!gh auth git-credential",
          ],
          allowConfig: ["credential.helper"],
        }
      : {}),
    progress: ({ stage, progress }) => {
      const key = `${stage}:${progress}`;
      if (key === last) return;
      last = key;
      input.onProgress?.({ phase: stage, percent: progress });
    },
  }).env(cloneEnv());
  try {
    await git.clone(url, input.target);
  } catch (error) {
    // What git left behind is ours: the target was not there before it started.
    await input.fs.remove(input.target).catch(() => undefined);
    throw failureOf(error, input.signal);
  }
}

function failureOf(
  error: unknown,
  signal: AbortSignal | undefined,
): PlaceError {
  if (signal?.aborted === true) return new PlaceError("cancelled");
  if (error instanceof GitPluginError) {
    if (error.plugin === "abort") return new PlaceError("cancelled");
    if (error.plugin === "timeout") return new PlaceError("timeout");
  }
  const message = error instanceof Error ? error.message : String(error);
  // simple-git says so when the program itself could not be started.
  if (/\bENOENT\b/.test(message) && !/fatal:/.test(message))
    return new PlaceError("no_git");
  return classifyCloneFailure(message);
}
