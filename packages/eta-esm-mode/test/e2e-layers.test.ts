import type { AuthorizeRequest } from "../src/authorize";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent";
import { MemoryApprovalStore } from "../src/authorize";

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
    const approvalStoreA = new MemoryApprovalStore();
    const approvalStoreB = new MemoryApprovalStore();
    const authorizeRequestsA: AuthorizeRequest[] = [];
    const authorizeRequestsB: AuthorizeRequest[] = [];

    // Create Agent A with auto-approve hook
    const agentA = new Agent({
      root: agentARoot,
      project: projectRoot,
      approvalStore: approvalStoreA,
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
      approvalStore: approvalStoreB,
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
    agentA.reload();
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
    expect(approvalStoreB.isApproved("project", "shout")).toBe(true);

    // ===== Step 3: Agent A 在个人层 define 同名能力 =====
    await agentA.run(`
      import eta from "eta:self";
      eta.define("shout", (msg) => \`!!! \${msg.toUpperCase()} !!!\`);
    `);

    // Verify: Agent A 的个人层有 shout
    agentA.reload();
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

    // ===== 验收点汇总 =====
    // ✅ 1. Agent A 在项目层 define，写入 {project}/.eta/env.js
    expect(projectEnv?.has("shout")).toBe(true);

    // ✅ 2. Agent B 能从 eta.modules 里看到 shout
    agentB.reload();
    const foundByB = agentB.layers.find("shout");
    expect(foundByB).toBeDefined();
    expect(foundByB?.layer).toBe("project");

    // ✅ 3. Agent B 首次调用弹审批（mock 批准）
    expect(approvalStoreB.isApproved("project", "shout")).toBe(true);

    // ✅ 4. Agent B 调用返回正确结果（项目层版本）
    expect(resultB1.value).toBe("HELLO");
    expect(resultB2.value).toBe("HELLO");

    // ✅ 5. Agent A 在个人层 define 同名能力，写入 ~/.eta/sessions/{id}/env.js
    expect(selfEnvA?.has("shout")).toBe(true);

    // ✅ 6. Agent A 调用 shout 返回个人层版本（覆盖项目层）
    expect(resultA.value).toBe("!!! HELLO !!!");

    // ✅ 7. Agent B 调用 shout 仍返回项目层版本（不受 A 的个人层影响）
    expect(resultB2.value).toBe("HELLO");

    // ✅ 8. 分层查找顺序正确：self > project > global
    const foundByA = agentA.layers.find("shout");
    expect(foundByA?.layer).toBe("self"); // Agent A 优先找到个人层

    const foundByBAgain = agentB.layers.find("shout");
    expect(foundByBAgain?.layer).toBe("project"); // Agent B 找到项目层

    // ✅ 9. 写穿 + 锁 + authorize 三者协同工作，无冲突
    // (已通过上述所有步骤验证)
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
    agent.reload();
    const found = agent.layers.find("greet");
    expect(found?.layer).toBe("self");

    // Clean up
    rmSync(globalRoot, { recursive: true, force: true });
  });

  it("并发写入：两个 agent 同时向项目层 define 不同能力", async () => {
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
    agentA.reload();
    agentB.reload();

    const projectEnv = agentA.layers.get("project");
    expect(projectEnv?.has("capA")).toBe(true);
    expect(projectEnv?.has("capB")).toBe(true);

    // Both agents should see both capabilities
    expect(agentA.layers.find("capA")?.layer).toBe("project");
    expect(agentA.layers.find("capB")?.layer).toBe("project");
    expect(agentB.layers.find("capA")?.layer).toBe("project");
    expect(agentB.layers.find("capB")?.layer).toBe("project");
  });

  it("authorize 隔离：Agent A 的个人层不需要审批，项目层需要", async () => {
    const authorizeRequests: AuthorizeRequest[] = [];
    const approvalStore = new MemoryApprovalStore();

    const agent = new Agent({
      root: agentARoot,
      project: projectRoot,
      approvalStore,
      hooks: {
        authorize: async (req) => {
          const parts = req.name.split(".");
          const layer = parts[1] as "self" | "project" | "global";
          const capability = parts[2] || "";

          authorizeRequests.push({
            layer,
            capability,
            args: req.input as readonly unknown[],
          });
          return undefined; // Auto-approve
        },
      },
    });

    // Define capability in self layer
    await agent.run(`
      import eta from "eta:self";
      eta.define("selfCap", () => "self only");
    `);

    // Define capability in project layer
    await agent.run(`
      import eta from "eta:project";
      eta.define("projectCap", () => "project shared");
    `);

    // Call self layer capability - should NOT trigger authorization
    authorizeRequests.length = 0;
    await agent.run(`
      import selfCap from "eta:selfCap";
      export default selfCap();
    `);
    expect(authorizeRequests.length).toBe(0);

    // Call project layer capability - SHOULD trigger authorization
    authorizeRequests.length = 0;
    await agent.run(`
      import projectCap from "eta:projectCap";
      export default projectCap();
    `);
    expect(authorizeRequests.length).toBe(1);
    expect(authorizeRequests[0]?.layer).toBe("project");
    expect(authorizeRequests[0]?.capability).toBe("projectCap");
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

    // Agent should automatically reload and use new version
    agent.reload();
    const result2 = await agent.run(`
      import version from "eta:version";
      export default version();
    `);
    expect(result2.value).toBe("v2");
  });
});
