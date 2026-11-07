import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hostOrigin,
  readConnection,
  writeConnection,
} from "../src/bun/connection";

const remote = {
  mode: "remote",
  address: "https://mac.ts.net",
  token: "secret",
} as const;

let dir: string;
let file: string;
const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "eta-connection-"));
  file = join(dir, "shell", "connection.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the saved connection", () => {
  it("has none before the first choice", async () => {
    await expect(readConnection(file)).resolves.toBeUndefined();
  });

  it("reads back what was written, either mode", async () => {
    await writeConnection(file, remote);
    await expect(readConnection(file)).resolves.toEqual(remote);
    await writeConnection(file, { mode: "local" });
    await expect(readConnection(file)).resolves.toEqual({ mode: "local" });
  });

  it("holds a token only its owner can read, whatever the umask would allow", async () => {
    const umask = process.umask(0o022);
    try {
      await writeConnection(file, remote);
    } finally {
      process.umask(umask);
    }
    expect(await modeOf(file)).toBe(0o600);
    expect(await modeOf(dirname(file))).toBe(0o700);
  });

  it("does not inherit the old file's permissions", async () => {
    await writeConnection(file, { mode: "local" });
    await chmod(file, 0o644);
    await writeConnection(file, remote);
    expect(await modeOf(file)).toBe(0o600);
  });

  it("takes back a file that came back readable by others", async () => {
    await writeConnection(file, remote);
    await chmod(file, 0o644);
    await readConnection(file);
    expect(await modeOf(file)).toBe(0o600);
  });

  it("leaves no temporary file with the token behind", async () => {
    await writeConnection(file, remote);
    expect(await readdir(dirname(file))).toEqual(["connection.json"]);
  });

  it.each([
    "not json",
    "null",
    '{"mode":"remote"}',
    '{"mode":"remote","address":"ftp://x","token":""}',
    '{"mode":"remote","address":"https://x"}',
    '{"mode":"elsewhere"}',
  ])("asks again rather than guess from %s", async (text) => {
    await writeConnection(file, { mode: "local" });
    await writeFile(file, text);
    await expect(readConnection(file)).resolves.toBeUndefined();
  });

  it("is formatted for a person to read", async () => {
    await writeConnection(file, { mode: "local" });
    expect(await readFile(file, "utf8")).toBe('{\n  "mode": "local"\n}\n');
  });
});

describe("an address", () => {
  it.each([
    ["https://mac.ts.net", "https://mac.ts.net"],
    ["https://mac.ts.net/", "https://mac.ts.net"],
    ["  http://10.0.0.2:8790/settings  ", "http://10.0.0.2:8790"],
    ["mac-studio:8790", "http://mac-studio:8790"],
    ["mac-studio", "http://mac-studio"],
    ["HTTPS://Mac.TS.net:443", "https://mac.ts.net"],
  ])("%s is the origin %s", (typed, origin) => {
    expect(hostOrigin(typed)).toBe(origin);
  });

  it.each(["", "   ", "ftp://x", "not a url at all", "http://"])(
    "%j is not one",
    (typed) => {
      expect(hostOrigin(typed)).toBeUndefined();
    },
  );
});
