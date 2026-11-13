/**
 * `/edit-host-config` against a real host: which of the host's two files, where it is (this
 * computer's `~/.eta`, or the host's over `ssh -t`), and telling the host to read `config.json`
 * again when the editor exits cleanly.
 */
import type { ConnectionPhase } from "../../src/connection/types";
import type { HostRendered } from "../ext-support/render-with-host";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it, vi } from "vitest";
import { editHostConfigExtension } from "../../src/ext/edit-host-config";
import { homeOf, isLocalHost } from "../../src/ext/edit-host-config/locality";
import { renderWithHost } from "../ext-support/render-with-host";
import { tempDir } from "../support/temp";
import { KEYS } from "../ui-support/render";

const PROVIDER = {
  id: "added",
  kind: "openai-compatible",
  baseUrl: "https://added.example/v1",
  apiKey: "test-key",
  models: [{ id: "m1", name: "m1" }],
};

interface Started {
  r: HostRendered;
  /** The TUI's home in the test: the host's data directory is `<home>/.eta`. */
  home: string;
  reloads: () => number;
}

/**
 * The shell with `/edit-host-config` only. The host's data directory is `.eta` under a
 * temporary home, and the command is given that home as the TUI's, as with a host on this
 * computer. The harness keeps its own temporary HOME for the settings files; the command's
 * environment is handed to it directly.
 */
async function start(
  options: {
    exitCode?: number | null;
    remote?: boolean;
    sshTarget?: string;
    write?: (file: string) => Promise<void>;
  } = {},
): Promise<Started> {
  const home = await tempDir("eta-tui-host-config-");
  const dataDir = join(home, ".eta");
  await mkdir(dataDir, { recursive: true });
  const env = { HOME: home, USERPROFILE: home };
  const extension = editHostConfigExtension({
    env,
    platform: process.platform,
    ...(options.remote === true ? { isLocal: () => false } : {}),
  });
  const r = await renderWithHost({
    extensions: [extension],
    host: { dataDir },
    columns: 220,
    settings:
      options.sshTarget === undefined
        ? {}
        : { ssh: { target: options.sshTarget } },
    runProcess: async (launch) => {
      await options.write?.(launch.args.at(-1) ?? "");
      return options.exitCode === undefined ? 0 : options.exitCode;
    },
  });
  const call = vi.spyOn(r.wire, "call");
  const reloads = () =>
    call.mock.calls.filter(
      ([target, action]) => target === "providers" && action === "reload",
    ).length;
  return { r, home, reloads };
}

/** The provider ids in the host's config, as the `providers` target says. */
function providerIds(r: HostRendered): string[] {
  const config = r.wire.store.getState().targets.providers?.sections.config as
    | { providers: { id: string }[] }
    | undefined;
  return (config?.providers ?? []).map((p) => p.id);
}

describe("/edit-host-config on this computer", () => {
  it("opens <home>/.eta/config.json and has the host read it again", async () => {
    const { r, home, reloads } = await start({
      write: async (file) =>
        writeFile(file, `${JSON.stringify({ providers: [PROVIDER] })}\n`),
    });
    const release = r.wire.subscribe("providers");
    await r.runCommand("/edit-host-config config.json");
    const path = join(home, ".eta", "config.json");
    await r.waitUntil(() => r.launches.length === 1, "the editor to open");
    expect(r.launches[0]?.args.at(-1)).toBe(path);
    await r.waitFor(path);
    await r.waitUntil(() => reloads() === 1, "providers.reload");
    await r.waitUntil(
      () => providerIds(r).includes("added"),
      "the host to list the new provider",
    );
    release();
  });

  it("opens <home>/.eta/mcp.json and says when it is read", async () => {
    const { r, home, reloads } = await start();
    await r.runCommand("/edit-host-config mcp.json");
    const path = join(home, ".eta", "mcp.json");
    await r.waitUntil(() => r.launches.length === 1, "the editor to open");
    expect(r.launches[0]?.args.at(-1)).toBe(path);
    await r.waitFor("/mcp");
    expect(r.screen()).toContain(path);
    expect(reloads()).toBe(0);
  });

  it("does not have the host reload when the editor exits with an error", async () => {
    const { r, reloads } = await start({ exitCode: 1 });
    await r.runCommand("/edit-host-config config.json");
    await r.waitUntil(() => r.launches.length === 1, "the editor to open");
    await r.waitFor("code 1");
    await r.settle(300);
    expect(reloads()).toBe(0);
  });

  it("does not have the host reload when the editor did not run to the end", async () => {
    const { r, reloads } = await start({ exitCode: null });
    await r.runCommand("/edit-host-config config.json");
    await r.waitUntil(() => r.launches.length === 1, "the editor to open");
    await r.settle(300);
    expect(reloads()).toBe(0);
  });

  it("asks which file when none is named, with a line about each", async () => {
    const { r, home } = await start();
    await r.runCommand("/edit-host-config");
    await r.waitFor("mcp.json");
    const screen = r.screen();
    const configLine = screen
      .split("\n")
      .find((l) => l.includes("config.json"));
    expect(configLine).toBeDefined();
    expect(screen).toMatch(/provider/i);
    expect(screen).toMatch(/MCP server/i);
    expect(r.launches).toEqual([]);
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await r.waitUntil(() => r.launches.length === 1, "the editor to open");
    expect(r.launches[0]?.args.at(-1)).toBe(join(home, ".eta", "mcp.json"));
  });

  it("closes the question on Esc and opens nothing", async () => {
    const { r } = await start();
    await r.runCommand("/edit-host-config");
    await r.waitFor("mcp.json");
    await r.press(KEYS.escape);
    await r.waitForGone("mcp.json");
    expect(r.launches).toEqual([]);
  });

  it("lists the two files when given another name", async () => {
    const { r } = await start();
    await r.runCommand("/edit-host-config tui.json");
    await r.waitFor("tui.json");
    expect(r.screen()).toContain("config.json");
    expect(r.screen()).toContain("mcp.json");
    expect(r.launches).toEqual([]);
  });
});

describe("/edit-host-config on a remote host", () => {
  it("edits the file over ssh -t, leaving the editor and ~ to the remote shell", async () => {
    const { r } = await start({ remote: true, sshTarget: "me@box" });
    await r.runCommand("/edit-host-config mcp.json");
    await r.waitUntil(() => r.launches.length === 1, "ssh to run");
    expect(r.launches[0]?.command).toBe("ssh");
    expect(r.launches[0]?.args).toEqual([
      "-t",
      "me@box",
      "--",
      // eslint-disable-next-line no-template-curly-in-string -- shell syntax, left to the remote shell
      "${EDITOR:-vi}",
      "~/.eta/mcp.json",
    ]);
  });

  it("has the host read config.json again after ssh exits cleanly", async () => {
    const { r, reloads } = await start({ remote: true, sshTarget: "me@box" });
    await r.runCommand("/edit-host-config config.json");
    await r.waitUntil(() => reloads() === 1, "providers.reload");
    expect(r.launches[0]?.args.at(-1)).toBe("~/.eta/config.json");
  });

  it("starts nothing without ssh.target, and says where the file is and how to reach it", async () => {
    const { r, reloads } = await start({ remote: true });
    await r.runCommand("/edit-host-config config.json");
    await r.waitFor("~/.eta/config.json");
    expect(r.screen()).toContain("ssh.target");
    expect(r.screen()).toContain("/config");
    await r.settle(300);
    expect(r.launches).toEqual([]);
    expect(reloads()).toBe(0);
  });
});

describe("whether the host is on this computer", () => {
  const at = (url: string, temporary = false): ConnectionPhase => ({
    name: "connected",
    url,
    temporary,
  });

  it.each([
    "http://127.0.0.1:8787",
    "http://127.4.5.6:1",
    "http://localhost:8787",
    "http://LOCALHOST:8787",
    "http://[::1]:8787",
    "https://127.0.0.1",
  ])("is for %s", (url) => {
    expect(isLocalHost(at(url))).toBe(true);
  });

  it.each([
    "http://10.0.0.5:8787",
    "http://192.168.1.2:8787",
    "http://128.0.0.1:8787",
    "http://0.0.0.0:8787",
    "http://example.com:8787",
    "http://127.0.0.1.example.com:8787",
    "http://localhost.example.com",
    "http://[::2]:8787",
    "not a url",
  ])("is not for %s", (url) => {
    expect(isLocalHost(at(url))).toBe(false);
  });

  it("is for a temporary host whatever its address", () => {
    expect(isLocalHost(at("http://10.0.0.5:1", true))).toBe(true);
  });
});

describe("the TUI's home", () => {
  it("is USERPROFILE on Windows and HOME elsewhere", () => {
    const env = { HOME: "/home/me", USERPROFILE: "C:\\Users\\me" };
    expect(homeOf(env, "win32", () => "fallback")).toBe("C:\\Users\\me");
    expect(homeOf(env, "linux", () => "fallback")).toBe("/home/me");
    expect(homeOf(env, "darwin", () => "fallback")).toBe("/home/me");
  });
});

describe("/edit-host-config when something is off", () => {
  it("says so when the host refuses to read config.json again", async () => {
    const { r, reloads } = await start({
      write: async (file) => writeFile(file, "{ not json"),
    });
    await r.runCommand("/edit-host-config config.json");
    await r.waitUntil(() => reloads() === 1, "providers.reload");
    await r.waitFor("did not read");
  });

  it("refuses an ssh.target that ssh would take for an option, and starts nothing", async () => {
    const { r, reloads } = await start({
      remote: true,
      sshTarget: "-oProxyCommand=calc",
    });
    await r.runCommand("/edit-host-config config.json");
    await r.waitFor("ssh.target");
    expect(r.screen()).toContain("-oProxyCommand=calc");
    await r.settle(300);
    expect(r.launches).toEqual([]);
    expect(reloads()).toBe(0);
  });
});
