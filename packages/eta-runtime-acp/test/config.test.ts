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
    expect(
      checkAcpAgent({ ...agent, cwd: " /work ", autoAllow: true }),
    ).toEqual({ ...agent, cwd: "/work", autoAllow: true });
    // What is left out is filled in; `autoAllow: false` is the default and is not written.
    expect(
      checkAcpAgent({ id: "x", command: " run ", autoAllow: false }),
    ).toEqual({ id: "x", label: "x", command: "run", args: [], env: {} });
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
    const warnings: string[] = [];
    const file = new AcpConfigFile(path, (message) => warnings.push(message));
    expect(file.read()).toEqual([]);
    file.write([agent]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ agents: [agent] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(file.get("gemini")).toEqual(agent);
    expect(warnings).toEqual([]);
    // A hand-edit that went wrong costs the entry it is in, not the others.
    writeFileSync(
      path,
      JSON.stringify({
        agents: [agent, { id: "Bad Id", command: "x" }, { ...agent }],
      }),
    );
    expect(file.read()).toEqual([agent]);
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("gemini is listed twice");
    writeFileSync(path, "{ not json");
    expect(file.read()).toEqual([]);
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
