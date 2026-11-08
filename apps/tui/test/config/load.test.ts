import type { ConfigProblem, TuiConfig } from "../../src/config/types";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../src/config/defaults";
import { loadConfig, parseConfig } from "../../src/config/load";
import { tempDir } from "../support/temp";

const FILE = "/conf/tui.json";

const parse = (value: unknown) => parseConfig(JSON.stringify(value), FILE);

/** The defaults, as a fresh deep copy, so a test can state what it expects without sharing. */
const defaults = (): TuiConfig => structuredClone(DEFAULT_CONFIG);

const problem = (
  key: string,
  reason: ConfigProblem["reason"],
  detail?: string,
): ConfigProblem => ({
  file: FILE,
  key,
  reason,
  ...(detail === undefined ? {} : { detail }),
});

const k = (
  key: string,
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
) => ({
  key,
  ctrl: mods.ctrl ?? false,
  alt: mods.alt ?? false,
  shift: mods.shift ?? false,
});

describe("parseConfig: the whole file", () => {
  it("gives the defaults for an empty object, with no problem", () => {
    expect(parse({})).toEqual({ config: defaults(), problems: [] });
  });

  it("allows and ignores $schema", () => {
    expect(parse({ $schema: "https://example.com/tui.json" })).toEqual({
      config: defaults(),
      problems: [],
    });
  });

  it("falls back to the defaults when the JSON is broken, keeping the parser's words", () => {
    const { config, problems } = parseConfig('{"locale": "zh",', FILE);
    expect(config).toEqual(defaults());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      file: FILE,
      key: "",
      reason: "invalid-json",
    });
    let parserSays = "";
    try {
      JSON.parse('{"locale": "zh",');
    } catch (error) {
      parserSays = (error as Error).message;
    }
    expect(problems[0]!.detail).toBe(parserSays);
  });

  it("falls back to the defaults when the top level is not an object", () => {
    for (const text of ["[]", "null", "3", '"zh"']) {
      expect(parseConfig(text, FILE)).toEqual({
        config: defaults(),
        problems: [problem("", "not-an-object")],
      });
    }
  });

  it("reads a file that starts with a byte order mark", () => {
    const { config, problems } = parseConfig('﻿{"locale":"en"}', FILE);
    expect(problems).toEqual([]);
    expect(config.locale).toBe("en");
  });

  it("reports and ignores an unknown top-level key, and keeps the rest", () => {
    expect(parse({ colour: "red", locale: "zh" })).toEqual({
      config: { ...defaults(), locale: "zh" },
      problems: [problem("colour", "unknown-key")],
    });
  });
});

describe("parseConfig: locale", () => {
  it("takes zh and en", () => {
    expect(parse({ locale: "zh" }).config.locale).toBe("zh");
    expect(parse({ locale: "en" }).config.locale).toBe("en");
  });

  it("reports another string as an invalid value and a non-string as the wrong type", () => {
    expect(parse({ locale: "fr" })).toEqual({
      config: defaults(),
      problems: [problem("locale", "invalid-value", '"fr"')],
    });
    expect(parse({ locale: 1 })).toEqual({
      config: defaults(),
      problems: [problem("locale", "wrong-type", "1")],
    });
  });

  it("cuts the detail to 80 characters", () => {
    const long = "x".repeat(200);
    const { problems } = parse({ locale: long });
    expect(problems[0]!.detail).toBe(JSON.stringify(long).slice(0, 80));
    expect(problems[0]!.detail).toHaveLength(80);
  });
});

describe("parseConfig: connection", () => {
  it("reads a resident host, normalising its address", () => {
    expect(
      parse({
        connection: {
          mode: "resident",
          url: " wss://Eta.Example.com:9443/ws?x=1#y ",
          token: "t",
        },
      }),
    ).toEqual({
      config: {
        ...defaults(),
        connection: {
          mode: "resident",
          url: "https://eta.example.com:9443",
          token: "t",
        },
      },
      problems: [],
    });
  });

  it("reads a temporary host", () => {
    expect(parse({ connection: { mode: "temporary" } })).toEqual({
      config: { ...defaults(), connection: { mode: "temporary" } },
      problems: [],
    });
  });

  it("drops the whole connection when the mode is missing or unknown, so the first start asks", () => {
    const missing = parse({ connection: { url: "http://h:1" } });
    expect(missing.config.connection).toBeUndefined();
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toMatchObject({
      key: "connection.mode",
      reason: "invalid-value",
    });

    expect(
      parse({ connection: { mode: "remote", url: "http://h:1" } }),
    ).toEqual({
      config: defaults(),
      problems: [problem("connection.mode", "invalid-value", '"remote"')],
    });
    expect(parse({ connection: { mode: 7 } })).toEqual({
      config: defaults(),
      problems: [problem("connection.mode", "wrong-type", "7")],
    });
  });

  it("drops the whole connection when a resident address is missing or not an address", () => {
    const missing = parse({ connection: { mode: "resident" } });
    expect(missing.config.connection).toBeUndefined();
    expect(missing.problems).toHaveLength(1);
    expect(missing.problems[0]).toMatchObject({
      key: "connection.url",
      reason: "invalid-value",
    });

    expect(parse({ connection: { mode: "resident", url: "ftp://h" } })).toEqual(
      {
        config: defaults(),
        problems: [problem("connection.url", "invalid-value", '"ftp://h"')],
      },
    );
    expect(parse({ connection: { mode: "resident", url: 8787 } })).toEqual({
      config: defaults(),
      problems: [problem("connection.url", "wrong-type", "8787")],
    });
  });

  it("reports a connection that is not an object as the wrong type", () => {
    expect(parse({ connection: "temporary" })).toEqual({
      config: defaults(),
      problems: [problem("connection", "wrong-type", '"temporary"')],
    });
  });

  it("reports extra keys and still reads the connection", () => {
    expect(
      parse({ connection: { mode: "temporary", url: "http://h:1" } }),
    ).toEqual({
      config: { ...defaults(), connection: { mode: "temporary" } },
      problems: [problem("connection.url", "unknown-key")],
    });
    expect(
      parse({ connection: { mode: "resident", url: "http://h:1", port: 2 } }),
    ).toEqual({
      config: {
        ...defaults(),
        connection: { mode: "resident", url: "http://h:1" },
      },
      problems: [problem("connection.port", "unknown-key")],
    });
  });

  it("drops a token that is not a string and keeps the host", () => {
    expect(
      parse({ connection: { mode: "resident", url: "http://h:1", token: 5 } }),
    ).toEqual({
      config: {
        ...defaults(),
        connection: { mode: "resident", url: "http://h:1" },
      },
      problems: [problem("connection.token", "wrong-type", "5")],
    });
  });
});

describe("parseConfig: ssh", () => {
  it("reads a target", () => {
    expect(parse({ ssh: { target: "me@box" } }).config.ssh).toEqual({
      target: "me@box",
    });
  });

  it("reports an empty target, a non-string target and unknown keys", () => {
    expect(parse({ ssh: { target: "" } })).toEqual({
      config: defaults(),
      problems: [problem("ssh.target", "invalid-value", '""')],
    });
    expect(parse({ ssh: { target: 1, port: 22 } })).toEqual({
      config: defaults(),
      problems: [
        problem("ssh.target", "wrong-type", "1"),
        problem("ssh.port", "unknown-key"),
      ],
    });
    expect(parse({ ssh: "me@box" })).toEqual({
      config: defaults(),
      problems: [problem("ssh", "wrong-type", '"me@box"')],
    });
  });
});

describe("parseConfig: theme", () => {
  it("takes every kind of colour", () => {
    const theme = {
      brand: "#abc",
      brandDim: "#A1B2C3",
      text: "default",
      muted: "grey",
      accent: "magentaBright",
      warning: "gray",
      error: "redBright",
      success: "whiteBright",
      border: "black",
      selection: "blackBright",
    };
    expect(parse({ theme })).toEqual({
      config: { ...defaults(), theme: { ...defaults().theme, ...theme } },
      problems: [],
    });
  });

  it("replaces only the token that is wrong", () => {
    const { config, problems } = parse({
      theme: {
        accent: "orange",
        error: "#12345",
        warning: 3,
        success: "#00ff00",
        glow: "red",
      },
    });
    expect(config.theme).toEqual({ ...defaults().theme, success: "#00ff00" });
    expect(problems).toEqual([
      problem("theme.accent", "invalid-value", '"orange"'),
      problem("theme.error", "invalid-value", '"#12345"'),
      problem("theme.warning", "wrong-type", "3"),
      problem("theme.glow", "unknown-key"),
    ]);
  });

  it("refuses colour names that are not Ink's", () => {
    for (const colour of [
      "Red",
      "greyBright",
      "grayBright",
      "#ggg",
      "rgb(1,2,3)",
      "",
    ]) {
      const { problems } = parse({ theme: { accent: colour } });
      expect(problems, colour).toEqual([
        problem("theme.accent", "invalid-value", JSON.stringify(colour)),
      ]);
    }
  });

  it("reports a theme that is not an object", () => {
    expect(parse({ theme: ["red"] })).toEqual({
      config: defaults(),
      problems: [problem("theme", "wrong-type", '["red"]')],
    });
  });
});

describe("parseConfig: theme.agents", () => {
  it("takes a list of colours of every kind, in its order", () => {
    const agents = ["magenta", "#abc", "#A1B2C3", "default", "blueBright"];
    const { config, problems } = parse({ theme: { agents } });
    expect(problems).toEqual([]);
    expect(config.theme).toEqual({ ...defaults().theme, agents });
  });

  it("takes a list of one", () => {
    const { config, problems } = parse({ theme: { agents: ["green"] } });
    expect(problems).toEqual([]);
    expect(config.theme.agents).toEqual(["green"]);
  });

  it("keeps the other tokens and the default list when the list is wrong", () => {
    const { config, problems } = parse({
      theme: { accent: "magenta", agents: "green" },
    });
    expect(config.theme).toEqual({ ...defaults().theme, accent: "magenta" });
    expect(problems).toEqual([
      problem("theme.agents", "wrong-type", '"green"'),
    ]);
  });

  it("uses the whole default list when the value is not a list of strings", () => {
    for (const agents of [
      "green",
      3,
      null,
      { a: "green" },
      ["green", 3],
      ["green", null],
    ]) {
      const { config, problems } = parse({ theme: { agents } });
      expect(config.theme.agents, JSON.stringify(agents)).toEqual(
        defaults().theme.agents,
      );
      expect(problems).toEqual([
        problem("theme.agents", "wrong-type", JSON.stringify(agents)),
      ]);
    }
  });

  it("uses the whole default list for an empty list or a list with one value that is not a colour", () => {
    for (const agents of [[], ["green", "orange"], ["#12345"], ["Red"]]) {
      const { config, problems } = parse({ theme: { agents } });
      expect(config.theme.agents, JSON.stringify(agents)).toEqual(
        defaults().theme.agents,
      );
      expect(problems).toEqual([
        problem("theme.agents", "invalid-value", JSON.stringify(agents)),
      ]);
    }
  });

  it("does not share the list with the defaults", () => {
    const { config } = parse({ theme: { agents: ["green"] } });
    (config.theme.agents as string[]).push("#000001");
    const untouched = parse({});
    (untouched.config.theme.agents as string[]).push("#000002");
    expect(DEFAULT_CONFIG.theme.agents).not.toContain("#000001");
    expect(DEFAULT_CONFIG.theme.agents).not.toContain("#000002");
  });
});

describe("parseConfig: keybindings", () => {
  it("takes one string or a list of them per action", () => {
    const { config, problems } = parse({
      keybindings: {
        "tabs.next": "ctrl+right",
        "tabs.previous": ["ctrl+left", "Alt+H"],
      },
    });
    expect(problems).toEqual([]);
    expect(config.keybindings["tabs.next"]).toEqual([
      k("right", { ctrl: true }),
    ]);
    expect(config.keybindings["tabs.previous"]).toEqual([
      k("left", { ctrl: true }),
      k("h", { alt: true }),
    ]);
    expect(config.keybindings["app.quit"]).toEqual(
      defaults().keybindings["app.quit"],
    );
  });

  it("takes an empty list as no key for that action", () => {
    const { config, problems } = parse({ keybindings: { "panel.open": [] } });
    expect(problems).toEqual([]);
    expect(config.keybindings["panel.open"]).toEqual([]);
  });

  it("refuses an empty list for app.quit, which would leave no way out", () => {
    expect(parse({ keybindings: { "app.quit": [] } })).toEqual({
      config: defaults(),
      problems: [problem("keybindings.app.quit", "invalid-value", "[]")],
    });
  });

  it("keeps the whole default of an action when any of its keys does not parse", () => {
    expect(
      parse({ keybindings: { "tabs.next": ["ctrl+right", "alt+lfet"] } }),
    ).toEqual({
      config: defaults(),
      problems: [
        problem(
          "keybindings.tabs.next",
          "invalid-value",
          '["ctrl+right","alt+lfet"]',
        ),
      ],
    });
    expect(parse({ keybindings: { "tabs.next": "" } })).toEqual({
      config: defaults(),
      problems: [problem("keybindings.tabs.next", "invalid-value", '""')],
    });
  });

  it("reports a value of the wrong type and an unknown action", () => {
    expect(
      parse({
        keybindings: { "tabs.next": 3, "tabs.jump": "j", "app.quit": [1] },
      }),
    ).toEqual({
      config: defaults(),
      problems: [
        problem("keybindings.tabs.next", "wrong-type", "3"),
        problem("keybindings.tabs.jump", "unknown-key"),
        problem("keybindings.app.quit", "wrong-type", "[1]"),
      ],
    });
    expect(parse({ keybindings: "vim" })).toEqual({
      config: defaults(),
      problems: [problem("keybindings", "wrong-type", '"vim"')],
    });
  });
});

describe("parseConfig: layout and tool output", () => {
  it("takes the tab bar at the top or the bottom", () => {
    expect(parse({ layout: { tabBar: "top" } }).config.layout).toEqual({
      tabBar: "top",
    });
    expect(parse({ layout: { tabBar: "bottom" } }).config.layout).toEqual({
      tabBar: "bottom",
    });
    expect(parse({ layout: { tabBar: "left" } })).toEqual({
      config: defaults(),
      problems: [problem("layout.tabBar", "invalid-value", '"left"')],
    });
    expect(parse({ layout: { tabBar: true } })).toEqual({
      config: defaults(),
      problems: [problem("layout.tabBar", "wrong-type", "true")],
    });
  });

  it("takes 1 to 500 preview lines", () => {
    expect(
      parse({ toolOutput: { previewLines: 1 } }).config.toolOutput,
    ).toEqual({
      previewLines: 1,
    });
    expect(
      parse({ toolOutput: { previewLines: 500 } }).config.toolOutput,
    ).toEqual({
      previewLines: 500,
    });
    for (const value of [0, 501, 2.5, -1]) {
      expect(
        parse({ toolOutput: { previewLines: value } }),
        String(value),
      ).toEqual({
        config: defaults(),
        problems: [
          problem("toolOutput.previewLines", "invalid-value", String(value)),
        ],
      });
    }
    expect(parse({ toolOutput: { previewLines: "5" } })).toEqual({
      config: defaults(),
      problems: [problem("toolOutput.previewLines", "wrong-type", '"5"')],
    });
  });

  it("takes the steps of a reply collapsed or expanded", () => {
    expect(
      parse({ transcript: { toolCalls: "expanded" } }).config.transcript,
    ).toEqual({ toolCalls: "expanded" });
    expect(
      parse({ transcript: { toolCalls: "collapsed" } }).config.transcript,
    ).toEqual({ toolCalls: "collapsed" });
    expect(parse({ transcript: { toolCalls: "hidden" } })).toEqual({
      config: defaults(),
      problems: [problem("transcript.toolCalls", "invalid-value", '"hidden"')],
    });
    expect(parse({ transcript: { toolCalls: false } })).toEqual({
      config: defaults(),
      problems: [problem("transcript.toolCalls", "wrong-type", "false")],
    });
  });

  it("turns the mouse off with false and refuses anything not a boolean", () => {
    expect(parse({ mouse: false }).config.mouse).toBe(false);
    expect(parse({ mouse: true }).config.mouse).toBe(true);
    expect(parse({ mouse: "off" })).toEqual({
      config: defaults(),
      problems: [problem("mouse", "wrong-type", '"off"')],
    });
  });

  it("reports sections that are not objects and keys they do not have", () => {
    expect(parse({ transcript: "collapsed", mouse: 1 })).toEqual({
      config: defaults(),
      problems: [
        problem("transcript", "wrong-type", '"collapsed"'),
        problem("mouse", "wrong-type", "1"),
      ],
    });
    expect(parse({ transcript: { tools: "collapsed" } })).toEqual({
      config: defaults(),
      problems: [problem("transcript.tools", "unknown-key")],
    });
    expect(
      parse({ layout: "top", toolOutput: { previewLines: 9, wrap: true } }),
    ).toEqual({
      config: { ...defaults(), toolOutput: { previewLines: 9 } },
      problems: [
        problem("layout", "wrong-type", '"top"'),
        problem("toolOutput.wrap", "unknown-key"),
      ],
    });
  });
});

describe("loadConfig", () => {
  it("gives the defaults for a file that does not exist, with no problem", async () => {
    const file = join(await tempDir(), "nope", "tui.json");
    expect(await loadConfig(file)).toEqual({
      path: file,
      exists: false,
      config: defaults(),
      problems: [],
    });
  });

  it("reads the file it is given and reports against it", async () => {
    const file = join(await tempDir(), "tui.json");
    await writeFile(file, JSON.stringify({ locale: "zh", bogus: 1 }));
    expect(await loadConfig(file)).toEqual({
      path: file,
      exists: true,
      config: { ...defaults(), locale: "zh" },
      problems: [{ file, key: "bogus", reason: "unknown-key" }],
    });
  });

  it("reports a file it cannot read as unreadable, with the error's message", async () => {
    // A directory where the file should be cannot be read on any platform.
    const file = join(await tempDir(), "tui.json");
    await mkdir(file);
    const loaded = await loadConfig(file);
    expect(loaded.config).toEqual(defaults());
    expect(loaded.exists).toBe(true);
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]).toMatchObject({
      file,
      key: "",
      reason: "unreadable",
    });
    expect(loaded.problems[0]!.detail).toMatch(/\S/);
  });
});
