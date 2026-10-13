import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { expect, test } from "bun:test";

test("recall resolves current source names without storing them in memory", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "axp-memory-test-"));
  let name = "原来的群名";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/groups/names") {
        expect(await request.json()).toEqual({ ids: ["group-id"] });
        return Response.json({ "group-id": name });
      }
      return Response.json({
        memories: [
          {
            id: "memory-id",
            text: "使用独立数据库",
            source_group_id: "group-id",
          },
        ],
      });
    },
  });
  const recall = async () => {
    const hook = Bun.spawn(
      [
        "node",
        join(import.meta.dir, "../plugins/memory/hooks/memory.mjs"),
        "recall",
      ],
      {
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
          AXP_GATEWAY_URL: server.url.toString().replace(/\/$/u, ""),
          AXP_AGENT_KEY: "test",
        },
        stdin: new Blob([
          JSON.stringify({ turn_id: "turn", prompt: "数据库" }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = JSON.parse(await new Response(hook.stdout).text());
    expect(await hook.exited).toBe(0);
    expect(await new Response(hook.stderr).text()).toBe("");
    return output.context as string;
  };
  try {
    expect(await recall()).toContain("source group: 原来的群名");
    name = "改名后的群";
    const context = await recall();
    expect(context).toContain("source group: 改名后的群");
    expect(context).not.toContain("原来的群名");
  } finally {
    server.stop(true);
    await rm(codexHome, { recursive: true, force: true });
  }
});
