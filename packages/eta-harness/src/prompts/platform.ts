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
  /** Whether the session has a realm (`esmrun`); the realm part of the briefing is only written then. */
  realm?: boolean;
}

/** What a session on an external runtime is told about the app; see `renderRuntimePlatformBlock`. */
export interface RuntimePlatformPromptInfo {
  /** The eta config file, when this machine has one: a remote machine's is the primary's. */
  configPath?: string | undefined;
  /** The session's own directory, when the session is persisted. */
  sessionDir?: string | undefined;
  /** The tools the host gave this session, by name: what the board's rules are about. */
  tools: readonly string[];
}

const configLine = (configPath: string): string =>
  `Config: ${configPath} — the model providers: id, baseUrl, apiKey, the model list, and any per-provider \`headers\`. The GUI writes this file as well. Its apiKeys are secrets: consult them when a request needs debugging, never paste them back.`;

const sessionLine = (sessionDir: string): string =>
  `This session's history: ${sessionDir} — \`meta.json\` (persona, cwd, title, model), \`journal.jsonl\` (every accepted change, append-only), \`dev.jsonl\` (what the app logged for itself). The journal is an internal format: the app rewrites it from the state it produced once it outgrows that state, so hand-editing it is not a supported operation.`;

const BOARD_TASK =
  "A task lives on the board. It outlives the conversation, the user can see it and confirm it, and it runs in a session of its own.";

/** The rule that sends work to the board. `steps` is whether this session has a step list too. */
const draftRule = (steps: boolean): string =>
  `Work that changes files, runs a build or tests, needs the user to accept a result, or takes more than a couple of tool rounds is not chat work${steps ? ", and it is not a step either" : ""}. Propose it with \`draft_task\` and let the user confirm it. \`create_task\` is not a shortcut around that${steps ? ", and neither is a step list" : ""}: draft first, then create.`;

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
 * tools it has. A session on an external runtime is told something else:
 * `renderRuntimePlatformBlock`.
 */
export function renderPlatformBlock(info: PlatformPromptInfo): string {
  const home = info.home;
  const cwd = info.cwd;
  const lines: string[] = [
    "<platform>",
    "eta is the app running this session. Its own files are readable, and the ones that describe you are yours to change:",
    "",
    configLine(info.configPath),
  ];
  if (info.sessionDir !== undefined) lines.push(sessionLine(info.sessionDir));
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
    `- ${BOARD_TASK} \`create_task\` puts one there; \`update_task\`, \`comment_task\` and \`finish_task\` act on it.`,
  );
  lines.push(`- ${draftRule(true)}`);
  lines.push(
    "- A task runs in a fresh session that cannot see this conversation. Write its goal and acceptance for a reader who knows nothing else, put what is already settled in `decided`, and always give `base`: the branch, commit or `#N` its worktree starts from. Give `assignee` when the work is for another agent; then that agent runs it, not you.",
  );
  lines.push("");
  lines.push("Working with others in a conversation:");
  lines.push(
    "- `conversation_info` says who is here, the goal and what has been decided. Read it before you take on work or answer for someone.",
  );
  lines.push(
    "- `mention` wakes the members you name and posts your message where they see it. You do not wait for them; they answer in the conversation. Wake-ups are limited: mention someone only when they have to act or know something, and say exactly what (the file, the decision, the question).",
  );
  lines.push(
    "- Do not do work assigned to another member, and do not redo a review someone else owns. If you disagree with a decision, say so once with the reason, then follow what was decided.",
  );
  lines.push("");
  lines.push(
    "Loops and schedules run in the app rather than in a shell you hold open: a loop you created fires on its own clock and returns to this session as an injected message, so a run ending is not the loop ending.",
  );
  if (info.realm === true) lines.push("", ...realmLines());
  lines.push("</platform>");
  return lines.join("\n");
}

/**
 * The platform briefing for a session an external runtime answers in (Claude Code, Codex, ...).
 *
 * `renderPlatformBlock` describes eta's own loop, and most of that is false here: the runtime has
 * no steps, its memory and its loops are its own, and a persona card does not reach it. What is
 * still true is the app's files and the board, so that is what this says, in the same words.
 *
 * What it says about the board follows from the session's tools rather than from what kind of
 * session it is, because the tools are what a host on any machine knows: a member of a
 * conversation has `draft_task`, and a session working on a task has `comment_task` and no
 * `draft_task`, so nothing there sends it off to draft the work it was given. A session with
 * neither hears nothing about the board. With nothing to say this renders nothing.
 */
export function renderRuntimePlatformBlock(
  info: RuntimePlatformPromptInfo,
): string {
  const paths = [
    ...(info.configPath === undefined ? [] : [configLine(info.configPath)]),
    ...(info.sessionDir === undefined ? [] : [sessionLine(info.sessionDir)]),
  ];
  const board = info.tools.includes("draft_task")
    ? [
        `- ${BOARD_TASK} \`create_task\` puts one there; \`update_task\` and \`comment_task\` act on it.`,
        `- ${draftRule(false)} The file and shell tools your runtime gives you do not change that: being able to make the edit yourself is no reason to make it in chat. Reading, looking things up, explaining and checking a command or two stay in chat.`,
        "- These tools are eta's, served to your runtime over MCP. It may list them under a prefix (`mcp__eta__draft_task`) or load them on demand, so look them up before you decide you do not have them.",
      ]
    : info.tools.includes("comment_task")
      ? [
          `- ${BOARD_TASK} This session is one of those: do what it was given here, and report on the task. It needs no draft.`,
        ]
      : [];
  if (paths.length === 0 && board.length === 0) return "";
  return [
    "<platform>",
    "eta is the app running this session, on top of your runtime.",
    ...(paths.length === 0
      ? []
      : ["", "Its own files are readable:", "", ...paths]),
    ...(board.length === 0 ? [] : ["", ...board]),
    "</platform>",
  ].join("\n");
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

export interface RealmExample {
  /** What the snippet shows, one line. */
  title: string;
  /** The scripts, one per `esmrun` call, in order. */
  scripts: string[];
}

// The examples are scripts as text: their `${...}` is the realm's template, not ours.
/* eslint-disable no-template-curly-in-string */
export const REALM_EXAMPLES: RealmExample[] = [
  {
    title:
      "`$` quotes every interpolation (arrays become several arguments), so build commands from values, never by string concatenation",
    scripts: [
      [
        'const name = "my notes; rm -rf ~";',
        'await $`touch ${name}`.timeout("5s");',
        'const listed = (await $`ls`.timeout("5s")).lines();',
        'const args = ["-n", "1"];',
        'const head = (await $`git log ${args} --format=%s`.timeout("10s").nothrow()).exitCode;',
        "({ listed, head });",
      ].join("\n"),
    ],
  },
  {
    title:
      "Every command gets a timeout that fits it; `.timeout()` kills one that hangs. A failing command throws; `.nothrow()` returns it instead. `Promise.all` runs commands side by side, `.pipe()` chains them, `$({ input })` feeds stdin",
    scripts: [
      [
        'let slow = "finished";',
        'try { await $`sleep 999`.timeout("1s"); } catch (e) { slow = `killed by ${e.signal}`; }',
        'const missing = await $`ls /no/such/dir`.timeout("5s").nothrow();',
        'const [one, two] = await Promise.all([$`echo one`.timeout("5s"), $`echo two`.timeout("5s")]);',
        'const sorted = (await $`printf "b\\na\\n"`.timeout("5s").pipe($`sort`.timeout("5s"))).lines();',
        'const parsed = (await $({ input: \'{"ok":true}\' })`cat`.timeout("5s")).json();',
        "({ slow, missing: [missing.exitCode, missing.stderr.trim()], both: [one.stdout.trim(), two.stdout.trim()], sorted, parsed });",
      ].join("\n"),
    ],
  },
  {
    title:
      "Files: search/view/edit first; node:fs/promises when you need more. Relative paths are the session cwd",
    scripts: [
      [
        'import { writeFile } from "node:fs/promises";',
        'await writeFile("app.ts", "const port = 3000; // TODO read from config\\n");',
        'const [hit] = await search("TODO", { glob: "*.ts" });',
        'await edit(hit.file, "const port = 3000;", "const port = Number(config.port);");',
        "await view(hit.file, { start: hit.line, limit: 3 });",
      ].join("\n"),
    ],
  },
  {
    title:
      "Top-level const does not reach the next call; eta.state does, with any value (a client, a function, a Map)",
    scripts: [
      [
        'import eta from "eta";',
        'eta.state.seen = new Set(["a.ts"]);',
        'eta.state.slug = (s) => s.toLowerCase().replace(/\\W+/g, "-");',
        "eta.state.seen.size;",
      ].join("\n"),
      [
        'import eta from "eta";',
        'eta.state.seen.add("b.ts");',
        '[eta.state.seen.size, eta.state.slug("Hello World")];',
      ].join("\n"),
    ],
  },
  {
    title:
      "eta.ask runs a nested turn of you, with your tools and the history so far; Promise.all fans out (5 at a time) and you merge the answers in code",
    scripts: [
      [
        'import eta from "eta";',
        'const areas = ["the parser", "the type checker"];',
        "const answers = await Promise.all(areas.map((a) => eta.ask(`Find the riskiest bug in ${a}. One line.`)));",
        'answers.map((r) => `${r.status}: ${r.text.split("\\n").at(-1)}`);',
      ].join("\n"),
    ],
  },
  {
    title:
      "eta.platform.<tool> is every tool you have, callable from code; eta.platform.llm is a bare model call with no tools and no history",
    scripts: [
      [
        'import eta from "eta";',
        'const summary = await eta.platform.llm({ system: "Answer in five words.", prompt: "What does a linker do?" });',
        "summary;",
      ].join("\n"),
    ],
  },
];
/* eslint-enable no-template-curly-in-string */

/** The realm part of the platform briefing: how to work in `esmrun`, then the examples. */
function realmLines(): string[] {
  return [
    "You act through code. `esmrun` runs JavaScript in a realm that belongs to this session; its description carries the realm's declarations. The realm is a full JS runtime with top-level await, so when the work is more than one call, write the loop, the retry or the fan-out in code and make one call, not a tool call per step.",
    "",
    "How a script behaves:",
    "- The last expression is the result. Do not `export default` it.",
    "- Each call is its own module. Top-level `const`/`let` are gone in the next call; put what the next call needs on `eta.state`, never on `globalThis`.",
    "- Every script is saved under the session's runs/ directory, so what you did can be read and replayed.",
    '- A bare import (`import x from "some-package"`) installs that package from npm on first use. Before writing a helper, check whether a package already does it: a driver, a parser, a browser, an SDK.',
    "- For files use `search`, `view` and `edit`. Do not reach for `$` with cat/sed/grep to read or change a file.",
    "",
    "Shell (`$`, zx):",
    '- Every command gets a time limit that makes sense for it: `.timeout("5s")` for a quick lookup, minutes for a build or a test run. The only exception is a service you mean to leave running (a dev server, a watcher); start that without awaiting it and keep the handle on `eta.state` so you can `.kill()` it later.',
    "- `$` is not intercepted: what you run is what happens. Destructive commands are yours to judge.",
    "",
    "Yourself, from code:",
    "- `eta.ask(prompt)` is a nested turn of this same model instance, you, with your tools and the session history so far. Concurrent calls (`Promise.all`) run in parallel, 5 at a time, and do not see each other; merge their answers in code.",
    "- `eta.platform.llm({ prompt, system? })` is the same model instance called bare: no tools, no history. Use it for a cheap transform (summarize, classify, extract) inside a loop.",
    "- `eta.platform.<tool>` is every tool you have as a function, so a workflow can call `draft_task`, `mention` or `web_search` from code.",
    "",
    "Making tools:",
    '- When you write the same code a second time, make it a capability with `esmrunandkeep`: it saves the module, runs it once, and keeps it only if that run succeeds. Afterwards it is `import f from "eta:<name>"`. `list_capabilities` shows what exists in this session, the project and globally; look there before building.',
    "- A capability is the plugin system: wrap a package or an API in one, and every later session can call it. Keep only what you will call again; one-off work stays in esmrun.",
    "",
    renderExamples(),
  ];
}

/** The examples as they appear in the prompt. */
function renderExamples(): string {
  return REALM_EXAMPLES.map(
    (example) =>
      `${example.title}:\n${example.scripts.map((s) => `\`\`\`js\n${s}\n\`\`\``).join("\nnext call:\n")}`,
  ).join("\n\n");
}
