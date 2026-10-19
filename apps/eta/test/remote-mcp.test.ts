/**
 * An MCP server on a remote session: the project's `.mcp.json` names it, it starts on the daemon's
 * machine when the session first calls it, and the model reaches it through the `mcp` tool.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { until } from "./support/client";
import { call, say, scriptedModels } from "./support/models";
import { remoteWorld } from "./support/remote";

const script = fileURLToPath(
  new URL("../../daemon/test/fixtures/fake-mcp-stdio.ts", import.meta.url),
);

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("an MCP server on a remote session", () => {
  it("starts on the daemon, serves the session's calls and ends with the session", async () => {
    const { models, requests } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") return say(`saw: ${request.last}`);
      return call("mcp", { tool: "pid", server: "fake" });
    });
    const r = await remoteWorld({ models });
    await writeFile(
      join(r.dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: { fake: { command: process.execPath, args: [script] } },
      }),
    );
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "which process?");
    const done = await r.settled(group.id, sent.replies[0]!.id);

    expect(done.status).toBe("done");
    expect(requests[0]!.tools).toContain("mcp");
    const pid = Number(/saw: .*?(\d+)/.exec(done.text ?? "")?.[1]);
    expect(pid).toBeGreaterThan(0);
    // The server is a process of the daemon's machine, not a thing the primary relayed.
    expect(pid).not.toBe(process.pid);

    await r.daemon.stop();
    await until(() => !alive(pid));
  });
});
