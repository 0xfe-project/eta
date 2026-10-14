import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { expect, test } from "bun:test";

test("recall labels group context using only the memory route", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "axp-memory-test-"));
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path !== "/bundles/memory/recall")
        return new Response(null, { status: 404 });
      return Response.json({
        memories: [
          { id: "local", text: "使用独立数据库", group_context: "this" },
          { id: "elsewhere", text: "部署需要确认", group_context: "other" },
          { id: "unknown", text: "回答简洁" },
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
    const context = await recall();
    expect(context).toContain("使用独立数据库 (memory local; from this group)");
    expect(context).toContain(
      "部署需要确认 (memory elsewhere; from another group)",
    );
    expect(context).toContain("回答简洁 (memory unknown)");
    expect(requests).toEqual(["/bundles/memory/recall"]);
  } finally {
    server.stop(true);
    await rm(codexHome, { recursive: true, force: true });
  }
});
