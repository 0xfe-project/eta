/**
 * MCP reaches a session's realm on the host: a server declared in the project's `.mcp.json` is
 * `import "mcp:<server>"` and `eta.mcp` in a session opened there, and a session with no server
 * declared is told MCP is not connected.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir, testHost } from "./support/host";

const ECHO = fileURLToPath(new URL("./fixtures/mcp-echo.ts", import.meta.url));

async function projectWithEcho(): Promise<string> {
  const cwd = await tempDir("eta-mcp-project-");
  await writeFile(
    join(cwd, ".mcp.json"),
    JSON.stringify({
      mcpServers: { echo: { command: process.execPath, args: [ECHO] } },
    }),
  );
  return cwd;
}

describe("mCP in a host's sessions", () => {
  it("a project's server is an import in the session's realm", async () => {
    const host = await testHost({
      mcp: { resolvers: false, checkIntervalMs: 0 },
    });
    const cwd = await projectWithEcho();
    const { session } = await host.server.sessions.create({ cwd });
    const agent = session.esm?.agent;
    expect(agent).toBeDefined();
    const result = await agent!.run(`
      import eta from "eta";
      import { echo } from "mcp:echo";
      const answer = await echo({ text: "hi" });
      export default { echoed: answer.echoed, servers: eta.mcp.servers().map((s) => s.name) };
    `);
    expect(result.value).toEqual({ echoed: { text: "hi" }, servers: ["echo"] });
    expect(result.effects.map((effect) => effect.name)).toContain(
      "mcp.echo.echo",
    );
  }, 30_000);

  it("a session with no server declared is told MCP is not connected", async () => {
    const host = await testHost({
      mcp: { resolvers: false, checkIntervalMs: 0 },
    });
    const cwd = await tempDir("eta-mcp-empty-");
    await mkdir(join(cwd, ".eta"), { recursive: true });
    const { session } = await host.server.sessions.create({ cwd });
    await expect(
      session.esm!.agent.run(`import x from "mcp:echo"; export default x;`),
    ).rejects.toThrow(/MCP not connected on this machine/);
  });
});
