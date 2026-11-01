export interface PlatformPromptInfo {
  /** The session's working directory — the project the agent is acting on. */
  cwd: string;
  /** Host-owned persona directory home; supplied explicitly, including for remote sessions. */
  home: string;
  /** The eta config file the GUI edits: providers, models, headers. */
  configPath: string;
  /** The session's own directory, when the session is persisted. */
  sessionDir?: string;
  /** Where a note for this project would be written. */
  memoryTarget: string;
  /** Whether anything has been remembered for this project yet. */
  memoryExists: boolean;
}

/**
 * The platform briefing (verbatim port of eta-agent's
 * `eta-server/src/platform-prompt.ts`): what the app around this agent is made
 * of and where its files live, so the agent can change its own setup — write a
 * persona card, take a project note — instead of asking a human where things go.
 *
 * The split of responsibilities, spelled out because it is easy to get wrong:
 * the *words* are here, in the harness, with every other model-visible string
 * (core owns none); the *paths* are the caller's, because only the app knows
 * where its config, session directories and project memory actually are. So this
 * renders a block from facts, and whoever assembles a session supplies the facts
 * — the server, once it exists.
 *
 * It is stable for a session — the paths do not move — so it sits with the blocks a
 * provider cache keeps, and it is written in terms of this session's real paths, because
 * "create .eta/MEMORY.md" is only useful next to a directory the agent is standing in.
 *
 * One paragraph names `draft_task` and `create_task`: those are the eta deployment's board
 * tools, and the sentence is written for a deployment that has them. A session without a
 * board simply never sees those tools, and the base prompt already tells a model to use the
 * tools it has.
 */
export function renderPlatformBlock(info: PlatformPromptInfo): string {
  const home = info.home;
  const cwd = info.cwd;
  const lines: string[] = [
    "<platform>",
    "eta is the app running this session. Its own files are readable, and the ones that describe you are yours to change:",
    "",
    `Config: ${info.configPath} — the model providers: id, baseUrl, apiKey, the model list, and any per-provider \`headers\`. The GUI writes this file as well. Its apiKeys are secrets: consult them when a request needs debugging, never paste them back.`,
  ];
  if (info.sessionDir !== undefined)
    lines.push(
      `This session's history: ${info.sessionDir} — \`meta.json\` (persona, cwd, title, model), \`journal.jsonl\` (every accepted change, append-only), \`dev.jsonl\` (what the app logged for itself). The journal is an internal format: the app rewrites it from the state it produced once it outgrows that state, so hand-editing it is not a supported operation.`,
    );
  lines.push(
    `Personas are markdown cards. Write \`<id>.persona.md\` into ${home}/.eta/persona (every session) or ${cwd}/.eta/persona (this project only): the file name is the persona id and the body is what gets injected as the persona block. Saving the file is enough — persona directories are re-read while the app runs, so a new card is pickable without a restart.`,
  );
  lines.push("");
  lines.push(
    info.memoryExists
      ? `Memory belongs to the project, not to the session. This project's memory is ${info.memoryTarget}, and it is loaded above as the memory block. Read it before contradicting it; edit it like any file when a note goes stale — it is re-read every turn, and the app appends to it itself when a run ends.`
      : `Memory belongs to the project, not to the session, and nothing has been remembered here yet. When something is worth keeping, create ${cwd}/.eta/ and write MEMORY.md in it — the write creates the directory. The app treats the nearest .eta/MEMORY.md up the tree from the working directory as that project's memory, so ${info.memoryTarget} is where yours belongs.`,
  );
  lines.push(
    "What belongs in memory: decisions and why, constraints nobody wrote down, facts about this codebase that were expensive to learn. What does not: what you are doing right now, in-flight plans, anything the next session can re-derive in seconds. A note earns its line when reading it later beats working it out again.",
  );
  lines.push("");
  lines.push(
    "A step and a task are two different things, and they are easy to confuse:",
  );
  lines.push(
    "- A step is one line of the plan this session keeps for itself: what you are doing now and in what order. `create_step`, `list_steps`, `get_step` and `update_step` work on it. Nobody else sees it, nothing runs it, and it ends with the session.",
  );
  lines.push(
    "- A task lives on the board. It outlives the conversation, the user can see it and confirm it, and it runs in a session of its own. `create_task` puts one there; `update_task`, `comment_task` and `finish_task` act on it.",
  );
  lines.push(
    "- Work that changes files, runs a build or tests, needs the user to accept a result, or takes more than a couple of tool rounds is not chat work, and it is not a step either. Propose it with `draft_task` and let the user confirm it. `create_task` is not a shortcut around that, and neither is a step list: draft first, then create.",
  );
  lines.push("");
  lines.push(
    "Loops and schedules run in the app rather than in a shell you hold open: a loop you created fires on its own clock and returns to this session as an injected message, so a run ending is not the loop ending.",
  );
  lines.push("</platform>");
  return lines.join("\n");
}

/**
 * The agent block: who this agent is in the deployment around it — its name, its
 * place in a conversation or task, the instructions it was given. The text is the
 * app's (only it knows its agents); the harness only frames it, and puts it in the
 * platform section rather than the base prompt, so the base reads the same for
 * every agent and nothing in it names one. Empty text renders nothing.
 */
export function renderAgentBlock(text: string): string {
  const body = text.trim();
  return body.length === 0 ? "" : `<agent>\n${body}\n</agent>`;
}
