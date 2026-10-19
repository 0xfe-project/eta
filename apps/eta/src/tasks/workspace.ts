/**
 * Where a task's executor works, made on the project's own machine.
 *
 * Both are one shell script run through the machine's transport, so the primary does it in its own
 * shell and a daemon does it over the link, with the same text. A task in `worktree` mode works in
 * a git worktree of the project's repository, on the branch `eta/task-<number>`, which starts at
 * the commit the project's checkout is on. The worktree lives outside the project's directory, in
 * the machine's own eta data (`<data dir>/worktrees/<project id>/task-<number>` on the primary,
 * `~/.eta/worktrees/...` on a daemon's machine): the project's `git status` stays clean, the path
 * is a function of the task (so a rerun finds its way back to the same files), and nothing
 * deletes it, since it holds the work that is being reviewed. A task in `local` mode works in the
 * project's directory itself.
 */
import type { TaskWorkspaceMode } from "@eta/client-contracts";
import type { SshTransport } from "@eta/ssh";
import type { ConversationStore } from "../conversations/store";
import type { MachineRecord, MachineStore } from "../machines/store";
import type { ProjectStore } from "../projects/store";
import type { WorkspaceChoice } from "./tools";
import { shellQuote } from "@eta/ssh";

const TIMEOUT_MS = 60_000;

/** The branch of a task's worktree. */
const branchOf = (number: number): string => `eta/task-${number}`;

/** Whether a directory is inside a git work tree. A machine that cannot be asked says so. */
async function isGitRepo(
  transport: SshTransport,
  path: string,
): Promise<boolean> {
  const result = await transport.run(
    `cd ${shellQuote(path)} 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1`,
    { timeoutMs: 15_000 },
  );
  if (result.code === 127 || result.timedOut === true)
    throw new Error(result.stderr.trim() || "the machine did not answer");
  return result.code === 0;
}

export interface Worktree {
  /** The worktree's root: the path the task shows and the next run finds. */
  path: string;
  /** Where the session works: the worktree's root, or the same subdirectory the project is in. */
  cwd: string;
  branch: string;
}

/**
 * Make the worktree of a task, or find the one an earlier run made. `root` is a shell word for the
 * eta data directory of the machine (`'/var/eta'`, or `"$HOME/.eta"`).
 */
export async function prepareWorktree(
  transport: SshTransport,
  input: {
    projectPath: string;
    projectId: string;
    number: number;
    root: string;
  },
): Promise<Worktree> {
  const branch = branchOf(input.number);
  const script = [
    `cd ${shellQuote(input.projectPath)} || { echo ${shellQuote(`no such directory: ${input.projectPath}`)} >&2; exit 2; }`,
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo ${shellQuote(`${input.projectPath} is not a git repository, so its tasks can only run in local mode`)} >&2; exit 3; }`,
    `prefix=$(git rev-parse --show-prefix)`,
    `wt=${input.root}/worktrees/${shellQuote(input.projectId)}/task-${input.number}`,
    `if [ ! -d "$wt" ]; then`,
    `  mkdir -p "$(dirname "$wt")" || exit 4`,
    `  if git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; then`,
    `    git worktree add "$wt" ${shellQuote(branch)} >&2 || exit 5`,
    `  else`,
    `    git worktree add -b ${shellQuote(branch)} "$wt" >&2 || exit 5`,
    `  fi`,
    `fi`,
    `printf '%s\\n%s' "$wt" "$prefix"`,
  ].join("\n");
  const result = await transport.run(script, { timeoutMs: TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `could not make the worktree (exit ${result.code})`,
    );
  }
  const [path = "", prefix = ""] = result.stdout.split("\n");
  if (path === "") throw new Error("the worktree has no path");
  const inside = prefix.replace(/\/$/, "");
  return { path, cwd: inside === "" ? path : `${path}/${inside}`, branch };
}

/**
 * The workspace of a task proposed in a conversation: what the agent asked for, or, when it did
 * not say, a worktree for a project that is a git repository and the directory itself for one
 * that is not. A worktree in a project with no repository is refused, so the agent hears it when
 * it proposes the task and not when the run fails. A machine that cannot be asked (it is away)
 * does not keep a task from being proposed: the choice stands, and the run says what is wrong.
 */
export function workspaceChooser(deps: {
  conversations: ConversationStore;
  projects: ProjectStore;
  machines: MachineStore;
  transport: (machine: MachineRecord) => SshTransport;
}): WorkspaceChoice {
  return async (
    conversationId: string,
    requested: TaskWorkspaceMode | undefined,
  ) => {
    const conversation = deps.conversations.get(conversationId);
    const project =
      conversation === undefined
        ? undefined
        : deps.projects.get(conversation.projectId);
    const machine =
      project === undefined ? undefined : deps.machines.get(project.machineId);
    if (project === undefined || machine === undefined)
      throw new Error("this conversation's project is gone");
    let git: boolean | undefined;
    try {
      git = await isGitRepo(deps.transport(machine), project.path);
    } catch {
      git = undefined;
    }
    if (requested === "worktree" && git === false)
      throw new Error(
        `${project.path} is not a git repository, so the task can only run in local mode (the project directory)`,
      );
    return requested ?? (git === false ? "local" : "worktree");
  };
}
