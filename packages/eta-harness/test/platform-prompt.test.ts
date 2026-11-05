/**
 * The platform briefing (ported from eta-agent's `test/platform-prompt.test.ts`).
 *
 * The briefing is what makes an agent able to change its own setup instead of
 * asking where things go, so what it must contain is the *paths and rules*: the
 * config it may read but not leak, the persona card convention, and — because the
 * action differs — the memory line for a project that already has a note and one
 * that does not.
 */
import { describe, expect, it } from "vitest";
import {
  renderPlatformBlock,
  renderRuntimePlatformBlock,
} from "../src/prompts/platform";

const base = {
  cwd: "/work/0xts",
  home: "/home/lemon",
  configPath: "/home/lemon/.eta/config.json",
  memoryTarget: "/work/0xts/.eta/MEMORY.md",
};

describe("the platform briefing", () => {
  it("names no config on a machine that has none", () => {
    const text = renderPlatformBlock({
      ...base,
      configPath: undefined,
      memoryExists: false,
    });
    expect(text).not.toContain("Config:");
    expect(text).toContain(base.memoryTarget);
  });

  it("tells the agent where the app keeps its own files", () => {
    const text = renderPlatformBlock({
      ...base,
      sessionDir: "/home/lemon/.eta/sessions/eta-1",
      memoryExists: false,
    });
    expect(text.startsWith("<platform>")).toBe(true);
    expect(text.endsWith("</platform>")).toBe(true);
    expect(text).toContain("/home/lemon/.eta/config.json");
    // Headers and keys are the parts the agent is likely to need, and the ones
    // it must not paste back.
    expect(text).toContain("`headers`");
    expect(text).toContain("secrets");
    expect(text).toContain("/home/lemon/.eta/sessions/eta-1");
    // The journal is the app's format: an agent that understood it might edit it.
    expect(text).toContain("journal.jsonl");
    expect(text).toContain("hand-editing it is not a supported operation");
  });

  it("says how a persona card is written, and that it needs no restart", () => {
    const text = renderPlatformBlock({ ...base, memoryExists: true });
    expect(text).toContain("<id>.persona.md");
    expect(text).toContain("/home/lemon/.eta/persona");
    expect(text).toContain("/work/0xts/.eta/persona");
    expect(text).toContain("without a restart");
  });

  it("points at the memory file when the project already has one", () => {
    const text = renderPlatformBlock({ ...base, memoryExists: true });
    expect(text).toContain("/work/0xts/.eta/MEMORY.md");
    expect(text).toContain("loaded above as the memory block");
    expect(text).not.toContain("nothing has been remembered");
  });

  it("tells the agent to create .eta/MEMORY.md when the project has none", () => {
    const text = renderPlatformBlock({ ...base, memoryExists: false });
    expect(text).toContain("nothing has been remembered");
    expect(text).toContain("create /work/0xts/.eta/");
    expect(text).toContain("MEMORY.md");
    // The rule, not just the instruction: the nearest one up the tree is loaded.
    expect(text).toContain("nearest .eta/MEMORY.md up the tree");
  });

  it("leaves the session directory out when nothing is persisted", () => {
    const text = renderPlatformBlock({ ...base, memoryExists: true });
    expect(text).not.toContain("journal.jsonl");
  });
});

describe("the board rules an eta session reads", () => {
  it("keeps its words: the runtime briefing shares them, and must not move them", () => {
    const text = renderPlatformBlock({ ...base, memoryExists: true });
    expect(text).toContain(
      "- A task lives on the board. It outlives the conversation, the user can see it and confirm it, and it runs in a session of its own. `create_task` puts one there; `update_task`, `comment_task` and `finish_task` act on it.\n",
    );
    expect(text).toContain(
      "- Work that changes files, runs a build or tests, needs the user to accept a result, or takes more than a couple of tool rounds is not chat work, and it is not a step either. Propose it with `draft_task` and let the user confirm it. `create_task` is not a shortcut around that, and neither is a step list: draft first, then create.\n",
    );
  });
});

describe("the runtime briefing", () => {
  const paths = {
    configPath: base.configPath,
    sessionDir: "/home/lemon/.eta/sessions/eta-1",
  };

  it("gives a member of a conversation the draft rule, in the words eta's own sessions read", () => {
    const text = renderRuntimePlatformBlock({
      ...paths,
      tools: ["draft_task", "comment_task"],
    });
    expect(text.startsWith("<platform>")).toBe(true);
    expect(text.endsWith("</platform>")).toBe(true);
    expect(text).toContain(base.configPath);
    expect(text).toContain(paths.sessionDir);
    expect(text).toContain(
      "takes more than a couple of tool rounds is not chat work. Propose it with `draft_task` and let the user confirm it. `create_task` is not a shortcut around that: draft first, then create.",
    );
    expect(text).toContain("mcp__eta__draft_task");
  });

  it("says nothing of steps, memory, personas or loops", () => {
    const text = renderRuntimePlatformBlock({
      configPath: base.configPath,
      tools: ["draft_task", "comment_task"],
    });
    for (const word of ["step", "memory", "persona", "loop"])
      expect(text.toLowerCase()).not.toContain(word);
  });

  it("tells a session that is working on a task that it needs no draft", () => {
    const text = renderRuntimePlatformBlock({
      ...paths,
      tools: ["comment_task", "finish_task"],
    });
    expect(text).toContain("This session is one of those");
    expect(text).not.toContain("draft_task");
    expect(text).not.toContain("create_task");
  });

  it("leaves the board out of a session that has no board tools", () => {
    const text = renderRuntimePlatformBlock({ ...paths, tools: ["web_fetch"] });
    expect(text).toContain(base.configPath);
    expect(text).not.toContain("board");
  });

  it("renders nothing when it has nothing to say", () => {
    expect(renderRuntimePlatformBlock({ tools: [] })).toBe("");
  });
});

describe("host-supplied platform facts", () => {
  it("uses the supplied remote home verbatim without substituting the process home", () => {
    const text = renderPlatformBlock({
      ...base,
      home: "/remote/home",
      cwd: "/remote/work",
      memoryTarget: "/remote/work/.eta/MEMORY.md",
      memoryExists: false,
    });
    expect(text).toContain("/remote/home/.eta/persona");
    expect(text).toContain("/remote/work/.eta/persona");
    expect(text).toContain("/remote/work/.eta/MEMORY.md");
    expect(text).not.toContain(`${base.home}/.eta/persona`);
    expect(text).toContain(base.configPath);
  });
});
