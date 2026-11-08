/**
 * Reading `tui.json`: the user's values over the defaults, key by key. A key that cannot be used
 * keeps its default and is reported; only a file that is not JSON at all is dropped whole.
 */
import type {
  ActionName,
  ConfigProblem,
  ConfigProblemReason,
  ConnectionSetting,
  KeyBinding,
  LoadedConfig,
  ThemeToken,
  TuiConfig,
} from "./types";
import { readFile } from "node:fs/promises";
import { normalizeAddress } from "../connection/address";
import { DEFAULT_CONFIG } from "./defaults";
import { parseKeyBinding } from "./keys";
import { ACTION_NAMES, THEME_TOKENS } from "./types";

const DETAIL_LIMIT = 80;
const QUIT_ACTION: ActionName = "app.quit";
const PREVIEW_LINES_MIN = 1;
const PREVIEW_LINES_MAX = 500;
const AGENT_COLOURS_KEY = "agents";

const BASIC_COLOURS = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;
const COLOUR_NAMES = new Set<string>([
  "default",
  ...BASIC_COLOURS,
  ...BASIC_COLOURS.map((name) => `${name}Bright`),
  "gray",
  "grey",
]);
const HEX_COLOUR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value as the problem's detail: JSON, cut to 80 characters. */
function shown(value: unknown): string | undefined {
  const text = JSON.stringify(value);
  return text === undefined ? undefined : text.slice(0, DETAIL_LIMIT);
}

/** Collects the problems of one file. */
class Problems {
  readonly list: ConfigProblem[] = [];
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }

  add(key: string, reason: ConfigProblemReason, detail?: string): void {
    this.list.push({
      file: this.file,
      key,
      reason,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /** A value that was found but cannot be used. */
  value(
    key: string,
    reason: "wrong-type" | "invalid-value",
    value: unknown,
  ): void {
    this.add(key, reason, shown(value));
  }

  unknownKeys(
    prefix: string,
    object: JsonObject,
    known: readonly string[],
  ): void {
    for (const name of Object.keys(object)) {
      if (!known.includes(name)) this.add(`${prefix}${name}`, "unknown-key");
    }
  }
}

/**
 * Read the text of a settings file. Never throws: a key that cannot be used keeps its default
 * and adds a problem; text that is not JSON, or not an object, gives the whole defaults.
 */
export function parseConfig(
  text: string,
  file: string,
): { config: TuiConfig; problems: ConfigProblem[] } {
  const config = structuredClone(DEFAULT_CONFIG);
  const problems = new Problems(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutByteOrderMark(text));
  } catch (error) {
    problems.add(
      "",
      "invalid-json",
      error instanceof Error ? error.message : String(error),
    );
    return { config, problems: problems.list };
  }
  if (!isObject(parsed)) {
    problems.add("", "not-an-object");
    return { config, problems: problems.list };
  }
  for (const [name, value] of Object.entries(parsed)) {
    switch (name) {
      case "$schema":
        break;
      case "locale":
        readLocale(value, config, problems);
        break;
      case "connection":
        config.connection = readConnection(value, problems);
        break;
      case "ssh":
        readSsh(value, config, problems);
        break;
      case "theme":
        readTheme(value, config, problems);
        break;
      case "keybindings":
        readKeybindings(value, config, problems);
        break;
      case "layout":
        readLayout(value, config, problems);
        break;
      case "toolOutput":
        readToolOutput(value, config, problems);
        break;
      case "transcript":
        readTranscript(value, config, problems);
        break;
      case "mouse":
        if (typeof value !== "boolean")
          problems.value("mouse", "wrong-type", value);
        else config.mouse = value;
        break;
      default:
        problems.add(name, "unknown-key");
    }
  }
  return { config, problems: problems.list };
}

// Windows editors (Notepad among them) may start a UTF-8 file with a byte order mark, which
// JSON.parse refuses.
export function withoutByteOrderMark(text: string): string {
  return text.startsWith("﻿") ? text.slice(1) : text;
}

function readLocale(
  value: unknown,
  config: TuiConfig,
  problems: Problems,
): void {
  if (typeof value !== "string")
    return problems.value("locale", "wrong-type", value);
  if (value !== "zh" && value !== "en")
    return problems.value("locale", "invalid-value", value);
  config.locale = value;
}

function readConnection(
  value: unknown,
  problems: Problems,
): ConnectionSetting | undefined {
  if (!isObject(value)) {
    problems.value("connection", "wrong-type", value);
    return undefined;
  }
  const mode = value.mode;
  if (mode === "temporary") {
    problems.unknownKeys("connection.", value, ["mode"]);
    return { mode: "temporary" };
  }
  if (mode !== "resident") {
    if (mode === undefined) problems.add("connection.mode", "invalid-value");
    else if (typeof mode !== "string")
      problems.value("connection.mode", "wrong-type", mode);
    else problems.value("connection.mode", "invalid-value", mode);
    return undefined;
  }
  problems.unknownKeys("connection.", value, ["mode", "url", "token"]);
  const url = readResidentUrl(value.url, problems);
  if (url === undefined) return undefined;
  const token = value.token;
  if (token !== undefined && typeof token !== "string") {
    problems.value("connection.token", "wrong-type", token);
    return { mode: "resident", url };
  }
  return token === undefined
    ? { mode: "resident", url }
    : { mode: "resident", url, token };
}

function readResidentUrl(
  value: unknown,
  problems: Problems,
): string | undefined {
  if (value === undefined) {
    problems.add("connection.url", "invalid-value");
    return undefined;
  }
  if (typeof value !== "string") {
    problems.value("connection.url", "wrong-type", value);
    return undefined;
  }
  const url = normalizeAddress(value);
  if (url === undefined)
    problems.value("connection.url", "invalid-value", value);
  return url;
}

function readSsh(value: unknown, config: TuiConfig, problems: Problems): void {
  if (!isObject(value)) return problems.value("ssh", "wrong-type", value);
  for (const [name, item] of Object.entries(value)) {
    if (name !== "target") {
      problems.add(`ssh.${name}`, "unknown-key");
      continue;
    }
    if (typeof item !== "string")
      problems.value("ssh.target", "wrong-type", item);
    else if (item === "") problems.value("ssh.target", "invalid-value", item);
    else config.ssh.target = item;
  }
}

const isThemeToken = (name: string): name is ThemeToken =>
  (THEME_TOKENS as readonly string[]).includes(name);

const isColour = (value: string): boolean =>
  COLOUR_NAMES.has(value) || HEX_COLOUR.test(value);

function readTheme(
  value: unknown,
  config: TuiConfig,
  problems: Problems,
): void {
  if (!isObject(value)) return problems.value("theme", "wrong-type", value);
  for (const [name, item] of Object.entries(value)) {
    const key = `theme.${name}`;
    if (name === AGENT_COLOURS_KEY) readAgentColours(item, config, problems);
    else if (!isThemeToken(name)) problems.add(key, "unknown-key");
    else if (typeof item !== "string") problems.value(key, "wrong-type", item);
    else if (!isColour(item)) problems.value(key, "invalid-value", item);
    else config.theme[name] = item;
  }
}

/** `theme.agents`: a list of at least one colour, taken whole or not at all. */
function readAgentColours(
  value: unknown,
  config: TuiConfig,
  problems: Problems,
): void {
  const key = `theme.${AGENT_COLOURS_KEY}`;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    return problems.value(key, "wrong-type", value);
  if (value.length === 0 || !value.every(isColour))
    return problems.value(key, "invalid-value", value);
  config.theme.agents = [...value];
}

const isActionName = (name: string): name is ActionName =>
  (ACTION_NAMES as readonly string[]).includes(name);

function readKeybindings(
  value: unknown,
  config: TuiConfig,
  problems: Problems,
): void {
  if (!isObject(value))
    return problems.value("keybindings", "wrong-type", value);
  for (const [name, item] of Object.entries(value)) {
    const key = `keybindings.${name}`;
    if (!isActionName(name)) {
      problems.add(key, "unknown-key");
      continue;
    }
    const texts = typeof item === "string" ? [item] : item;
    if (
      !Array.isArray(texts) ||
      !texts.every((text) => typeof text === "string")
    ) {
      problems.value(key, "wrong-type", item);
      continue;
    }
    // Without a key for app.quit the interface has no way out but a signal.
    if (name === QUIT_ACTION && texts.length === 0) {
      problems.value(key, "invalid-value", item);
      continue;
    }
    const bindings = texts.map(parseKeyBinding);
    if (bindings.includes(undefined)) {
      problems.value(key, "invalid-value", item);
      continue;
    }
    config.keybindings[name] = bindings as KeyBinding[];
  }
}

function readLayout(
  value: unknown,
  config: TuiConfig,
  problems: Problems,
): void {
  if (!isObject(value)) return problems.value("layout", "wrong-type", value);
  for (const [name, item] of Object.entries(value)) {
    if (name !== "tabBar") {
      problems.add(`layout.${name}`, "unknown-key");
      continue;
    }
    if (typeof item !== "string")
      problems.value("layout.tabBar", "wrong-type", item);
    else if (item !== "top" && item !== "bottom")
      problems.value("layout.tabBar", "invalid-value", item);
    else config.layout.tabBar = item;
  }
}

function readToolOutput(
  value: unknown,
  config: TuiConfig,
  problems: Problems,
): void {
  if (!isObject(value))
    return problems.value("toolOutput", "wrong-type", value);
  for (const [name, item] of Object.entries(value)) {
    const key = `toolOutput.${name}`;
    if (name !== "previewLines") {
      problems.add(key, "unknown-key");
      continue;
    }
    if (typeof item !== "number") problems.value(key, "wrong-type", item);
    else if (
      !Number.isInteger(item) ||
      item < PREVIEW_LINES_MIN ||
      item > PREVIEW_LINES_MAX
    )
      problems.value(key, "invalid-value", item);
    else config.toolOutput.previewLines = item;
  }
}

function readTranscript(
  value: unknown,
  config: TuiConfig,
  problems: Problems,
): void {
  if (!isObject(value))
    return problems.value("transcript", "wrong-type", value);
  for (const [name, item] of Object.entries(value)) {
    const key = `transcript.${name}`;
    if (name !== "toolCalls") {
      problems.add(key, "unknown-key");
      continue;
    }
    if (typeof item !== "string") problems.value(key, "wrong-type", item);
    else if (item !== "collapsed" && item !== "expanded")
      problems.value(key, "invalid-value", item);
    else config.transcript.toolCalls = item;
  }
}

const errorCode = (error: unknown): unknown =>
  (error as { code?: unknown } | null)?.code;

/**
 * Read the settings file. Never throws: a missing file is the defaults (`exists: false`), a file
 * that cannot be read is the defaults with an `unreadable` problem.
 */
export async function loadConfig(file: string): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT")
      return {
        path: file,
        exists: false,
        config: structuredClone(DEFAULT_CONFIG),
        problems: [],
      };
    return {
      path: file,
      exists: true,
      config: structuredClone(DEFAULT_CONFIG),
      problems: [
        {
          file,
          key: "",
          reason: "unreadable",
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return { path: file, exists: true, ...parseConfig(text, file) };
}
