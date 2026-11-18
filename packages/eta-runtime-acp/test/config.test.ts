/**
 * `acp.json` as it is read and checked, and a session's MCP servers in ACP's shape.
 */
import type { AcpAgentConfig } from "@eta/client-contracts";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAgentRuntime } from "@eta/client-contracts";
import { describe, expect, it } from "vitest";
import { acpServers } from "../src/delegate";
import {
  acpAgentId,
  AcpConfigError,
  AcpConfigFile,
  acpRuntimeId,
  checkAcpAgent,
} from "../src/index";

const agent: AcpAgentConfig = {
  id: "gemini",
  label: "Gemini CLI",
  command: "gemini",
  args: ["--acp"],
  env: { KEY: "value" },
};

describe("an ACP agent's configuration", () => {
  it("holds up, or says in words why not", () => {
    expect(checkAcpAgent(agent)).toEqual(agent);
    // What is left out is filled in.
    expect(checkAcpAgent({ id: "x", command: " run " })).toEqual({
      id: "x",
      label: "x",
      command: "run",
      args: [],
      env: {},
    });
    // `cwd` and `autoAllow` are gone: an older file's are read past, whatever they hold.
    expect(
      checkAcpAgent({ ...agent, cwd: " /work ", autoAllow: true }),
    ).toEqual(agent);
    expect(checkAcpAgent({ ...agent, cwd: 42, autoAllow: "yes" })).toEqual(
      agent,
    );
    expect(() => checkAcpAgent({ ...agent, id: "Gemini" })).toThrow(
      /id "Gemini" is not valid/,
    );
    expect(() => checkAcpAgent({ ...agent, id: "-x" })).toThrow(/not valid/);
    expect(() => checkAcpAgent({ ...agent, command: "" })).toThrow(
      /command is empty/,
    );
    expect(() => checkAcpAgent({ ...agent, env: { " ": "x" } })).toThrow(
      /empty name/,
    );
    expect(() => checkAcpAgent({ ...agent, args: [1] })).toThrow(/args/);
    expect(() => checkAcpAgent(null)).toThrow(/object/);
  });

  it("names a runtime, and only an id that could be one", () => {
    expect(acpRuntimeId("gemini")).toBe("acp.gemini");
    expect(acpAgentId("acp.gemini")).toBe("gemini");
    expect(acpAgentId("claude")).toBeUndefined();
    expect(acpAgentId("acp.Not Valid")).toBeUndefined();
    expect(isAgentRuntime("acp.gemini")).toBe(true);
    expect(isAgentRuntime("claude")).toBe(true);
    expect(isAgentRuntime("acp.")).toBe(false);
    expect(isAgentRuntime("acp.a:b")).toBe(false);
    expect(isAgentRuntime("nope")).toBe(false);
  });
});

describe("acp.json", () => {
  it("is read each time, written whole, and the user's alone to read", () => {
    const path = join(mkdtempSync(join(tmpdir(), "eta-acp-file-")), "acp.json");
    const file = new AcpConfigFile(path);
    expect(file.read()).toEqual([]);
    file.write([agent]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ agents: [agent] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(file.get("gemini")).toEqual(agent);
  });

  it("that cannot be read whole is an error naming the file, never a shorter list", () => {
    const path = join(mkdtempSync(join(tmpdir(), "eta-acp-file-")), "acp.json");
    const file = new AcpConfigFile(path);
    const refuses = (text: string, reason: RegExp) => {
      writeFileSync(path, text);
      expect(() => file.read()).toThrow(AcpConfigError);
      expect(() => file.read()).toThrow(path);
      expect(() => file.read()).toThrow(reason);
      expect(() => file.get("gemini")).toThrow(path);
    };
    // A trailing comma, as a hand-edit leaves it.
    refuses(
      `{ "agents": [${JSON.stringify(agent)}, ${JSON.stringify({ ...agent, id: "two" })},] }`,
      /is not valid JSON/,
    );
    refuses(`{ "agents": {} }`, /does not hold a list of agents/);
    refuses(`null`, /does not hold a list of agents/);
    // One agent that does not hold up fails the file: skipped, it would be lost at the next write.
    refuses(
      JSON.stringify({ agents: [agent, { id: "Bad Id", command: "x" }] }),
      /agent 2 \("Bad Id"\): the id "Bad Id" is not valid/,
    );
    refuses(
      JSON.stringify({ agents: [agent, { ...agent }] }),
      /gemini is listed twice/,
    );
    // Fixed, it reads again.
    writeFileSync(path, JSON.stringify({ agents: [agent] }));
    expect(file.read()).toEqual([agent]);
  });
});

describe("a session's MCP servers, for an ACP agent", () => {
  it("change shape, and an HTTP one goes only to an agent that takes it", () => {
    const servers = [
      { name: "files", command: "/bin/sh", args: ["-c", "x"], env: { A: "1" } },
      { name: "bare", command: "/bin/true" },
      {
        name: "web",
        type: "http" as const,
        url: "http://127.0.0.1:1/mcp",
        headers: { Authorization: "Bearer t" },
      },
    ];
    const warnings: string[] = [];
    const warn = (message: string) => void warnings.push(message);
    expect(
      acpServers(servers, { mcpCapabilities: { http: true } }, warn),
    ).toEqual([
      {
        name: "files",
        command: "/bin/sh",
        args: ["-c", "x"],
        env: [{ name: "A", value: "1" }],
      },
      { name: "bare", command: "/bin/true", args: [], env: [] },
      {
        type: "http",
        name: "web",
        url: "http://127.0.0.1:1/mcp",
        headers: [{ name: "Authorization", value: "Bearer t" }],
      },
    ]);
    expect(warnings).toEqual([]);
    expect(acpServers(servers, {}, warn).map((s) => s.name)).toEqual([
      "files",
      "bare",
    ]);
    expect(warnings[0]).toContain("web is HTTP");
  });
});
