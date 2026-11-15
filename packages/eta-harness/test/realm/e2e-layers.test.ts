import type { AuthorizeRequest } from "../../src/realm/authorize";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/realm/agent";
import {
  defaultApprovalStorePath,
  FileApprovalStore,
} from "../../src/realm/authorize";

describe("e2e: 两个 agent 共享和覆盖能力", () => {
  let projectRoot: string;
  let agentARoot: string;
  let agentBRoot: string;

  beforeEach(() => {
    const base = join(tmpdir(), `e2e-layers-test-${Date.now()}`);
    projectRoot = join(base, "project");
    agentARoot = join(base, "agentA");
    agentBRoot = join(base, "agentB");

    for (const dir of [projectRoot, agentARoot, agentBRoot]) {
      mkdirSync(dir, { recursive: true });
    }

    // Initialize empty env.js files for all layers
    for (const dir of [projectRoot, agentARoot, agentBRoot]) {
      writeFileSync(
        join(dir, "env.js"),
        `// @capabilities []\nimport eta from "eta";\n\n// eta:generated\n\n// eta:by hand\n`,
      );
    }
  });

  afterEach(() => {
    const base = join(projectRoot, "..");
    rmSync(base, { recursive: true, force: true });
  });

  it("两个 agent 共享和覆盖能力", async () => {
    const authorizeRequestsA: AuthorizeRequest[] = [];
    const authorizeRequestsB: AuthorizeRequest[] = [];

    // Create Agent A with auto-approve hook
    const agentA = new Agent({
      root: agentARoot,
      project: projectRoot,
      hooks: {
        authorize: async (req) => {
          const parts = req.name.split(".");
          const layer = parts[1] as "self" | "project" | "global";
          const capability = parts[2] || "";

          authorizeRequestsA.push({
            layer,
            capability,
            args: req.input as readonly unknown[],
          });
          // Auto-approve
          return undefined;
        },
      },
    });

    // Create Agent B with auto-approve hook
    const agentB = new Agent({
      root: agentBRoot,
      project: projectRoot,
      hooks: {
        authorize: async (req) => {
          const parts = req.name.split(".");
          const layer = parts[1] as "self" | "project" | "global";
          const capability = parts[2] || "";

          authorizeRequestsB.push({
            layer,
            capability,
            args: req.input as readonly unknown[],
          });
          // Auto-approve
          return undefined;
        },
      },
    });

    // ===== Step 1: Agent A 在项目层 define shout =====
    await agentA.run(`
      import eta from "eta:project";
      eta.define("shout", (msg) => msg.toUpperCase());
    `);

    // Verify: 项目层的 env.js 应该包含 shout
    agentA.layers.reload();
    const projectEnv = agentA.layers.get("project");
    expect(projectEnv?.has("shout")).toBe(true);
    const shoutCap = projectEnv?.capability("shout");
    expect(shoutCap?.source).toContain("toUpperCase");
    expect(shoutCap?.meta).toBeDefined();

    // ===== Step 2: Agent B 能看到并调用项目层的 shout =====
    // 首次调用应该触发审批
    authorizeRequestsB.length = 0;
    const resultB1 = await agentB.run(`
      import shout from "eta:shout";
      export default await shout("hello");
    `);

    // Verify: Agent B 看到项目层的 shout
    expect(resultB1.value).toBe("HELLO");

    // Verify: 首次调用触发了审批
    expect(authorizeRequestsB.length).toBe(1);
    expect(authorizeRequestsB[0]?.layer).toBe("project");
    expect(authorizeRequestsB[0]?.capability).toBe("shout");

    // Verify: 审批已记录
    expect(
      new FileApprovalStore(defaultApprovalStorePath(agentBRoot)).isApproved(
        "project",
        "shout",
      ),
    ).toBe(true);

    // ===== Step 3: Agent A 在个人层 define 同名能力 =====
    await agentA.run(`
      import eta from "eta:self";
      eta.define("shout", (msg) => \`!!! \${msg.toUpperCase()} !!!\`);
    `);

    // Verify: Agent A 的个人层有 shout
    agentA.layers.reload();
    const selfEnvA = agentA.layers.get("self");
    expect(selfEnvA?.has("shout")).toBe(true);
    const shoutSelfCap = selfEnvA?.capability("shout");
    expect(shoutSelfCap?.source).toContain("!!!");

    // ===== Step 4: Agent A 调用 shout，用的是个人层版本 =====
    const resultA = await agentA.run(`
      import shout from "eta:shout";
      export default shout("hello");
    `);

    // Verify: Agent A 返回个人层版本（覆盖项目层）
    expect(resultA.value).toBe("!!! HELLO !!!");

    // ===== Step 5: Agent B 调用 shout，仍然是项目层版本 =====
    // 第二次调用不应触发审批（已批准）
    authorizeRequestsB.length = 0;
    const resultB2 = await agentB.run(`
      import shout from "eta:shout";
      export default await shout("hello");
    `);

    // Verify: Agent B 仍然返回项目层版本（不受 A 的个人层影响）
    expect(resultB2.value).toBe("HELLO");

    // Verify: 第二次调用没有触发审批
    expect(authorizeRequestsB.length).toBe(0);

    // The lookup each agent sees: B finds the project's, A its own.
    agentB.layers.reload();
    expect(agentB.layers.find("shout")?.layer).toBe("project");
    expect(agentA.layers.find("shout")?.layer).toBe("self");
  });

  it("分层查找顺序：self > project > global", async () => {
    const globalRoot = join(tmpdir(), `global-${Date.now()}`);
    mkdirSync(globalRoot, { recursive: true });
    writeFileSync(
      join(globalRoot, "env.js"),
      `// @capabilities []\nimport eta from "eta";\n\n// eta:generated\n\n// eta:by hand\n`,
    );

    const agent = new Agent({
      root: agentARoot,
      project: projectRoot,
      global: globalRoot,
    });

    // Global layer defines "greet"
    await agent.run(`
      import eta from "eta:global";
      eta.define("greet", () => "from global");
    `);

    // Project layer defines "greet"
    await agent.run(`
      import eta from "eta:project";
      eta.define("greet", () => "from project");
    `);

    // Self layer defines "greet"
    await agent.run(`
      import eta from "eta:self";
      eta.define("greet", () => "from self");
    `);

    // Call should resolve to self (highest priority)
    const result = await agent.run(`
      import greet from "eta:greet";
      export default greet();
    `);

    expect(result.value).toBe("from self");

    // Verify lookup order
    agent.layers.reload();
    const found = agent.layers.find("greet");
    expect(found?.layer).toBe("self");

    // Clean up
    rmSync(globalRoot, { recursive: true, force: true });
  });

  it("两个 agent 先后向项目层 define 不同能力，互不覆盖", async () => {
    const agentA = new Agent({
      root: agentARoot,
      project: projectRoot,
    });

    const agentB = new Agent({
      root: agentBRoot,
      project: projectRoot,
    });

    // Both agents concurrently define different capabilities to project layer
    // Both should succeed
    const [resultA, resultB] = await Promise.all([
      agentA.run(`
        import eta from "eta:project";
        eta.define("capA", () => "from A");
      `),
      agentB.run(`
        import eta from "eta:project";
        eta.define("capB", () => "from B");
      `),
    ]);

    // Both evaluations should complete without error
    expect(resultA.value).toBeUndefined();
    expect(resultB.value).toBeUndefined();

    // Verify both capabilities exist in project layer
    agentA.layers.reload();
    agentB.layers.reload();

    const projectEnv = agentA.layers.get("project");
    expect(projectEnv?.has("capA")).toBe(true);
    expect(projectEnv?.has("capB")).toBe(true);

    // Both agents should see both capabilities
    expect(agentA.layers.find("capA")?.layer).toBe("project");
    expect(agentA.layers.find("capB")?.layer).toBe("project");
    expect(agentB.layers.find("capA")?.layer).toBe("project");
    expect(agentB.layers.find("capB")?.layer).toBe("project");
  });

  it("realm 重建：修改 env.js 后自动重新唤醒", async () => {
    const agent = new Agent({
      root: agentARoot,
      project: projectRoot,
    });

    // Define initial capability
    await agent.run(`
      import eta from "eta:self";
      eta.define("version", () => "v1");
    `);

    // Call it
    const result1 = await agent.run(`
      import version from "eta:version";
      export default version();
    `);
    expect(result1.value).toBe("v1");

    // Directly modify env.js to simulate external change
    const selfEnv = agent.layers.get("self")!;
    selfEnv.replace("version", "() => 'v2'");

    // No reload: the next run notices the file changed and wakes a fresh realm.
    const result2 = await agent.run(`
      import version from "eta:version";
      export default version();
    `);
    expect(result2.value).toBe("v2");
  });
});
