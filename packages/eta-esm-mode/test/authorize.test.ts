import type { AuthorizeRequest } from "../src/authorize";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { MemoryApprovalStore } from "../src/authorize";

describe("Authorization", () => {
  const testRoot = join(import.meta.dir, "fixtures", "authorize-test");
  const selfRoot = join(testRoot, "self");
  const projectRoot = join(testRoot, "project");
  const globalRoot = join(testRoot, "global");

  beforeEach(() => {
    // Clean up and create fresh directories
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
    mkdirSync(selfRoot, { recursive: true });
    mkdirSync(join(projectRoot, ".eta"), { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
  });

  test("项目层能力首次调用弹审批，批准后记录", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: AuthorizeRequest[] = [];
    const approveNext = true;

    const agent = new Agent({
      root: selfRoot,
      project: join(projectRoot, ".eta"),
      global: globalRoot,
      hooks: {
        authorize: async (req) => {
          // Record the authorization request
          authorizeRequests.push({
            layer: req.name.startsWith("capability.project.")
              ? "project"
              : req.name.startsWith("capability.global.")
                ? "global"
                : "self",
            capability: req.name.split(".").pop() || "",
            args: req.input as readonly unknown[],
          });
          // Return undefined (approve) or error message (deny)
          return approveNext ? undefined : "User denied";
        },
      },
    });

    // Manually set approval store for testing
    (agent as any).approvalStore = approvalStore;

    // Define a capability in project layer
    await agent.run(`
      import eta from "eta:project";
      eta.define("testCap", async function() { return "works"; }, { desc: "test" });
    `);

    // First call should trigger authorization
    authorizeRequests.length = 0; // Reset
    const result1 = await agent.run(`
      import cap from "eta:project:testCap";
      export default await cap();
    `);

    expect(authorizeRequests.length).toBe(1);
    expect(authorizeRequests[0]?.layer).toBe("project");
    expect(authorizeRequests[0]?.capability).toBe("testCap");
    expect(result1.value).toBe("works");
    expect(approvalStore.isApproved("project", "testCap")).toBe(true);
  });

  test("同一能力第二次调用不弹窗", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: AuthorizeRequest[] = [];

    const agent = new Agent({
      root: selfRoot,
      project: join(projectRoot, ".eta"),
      hooks: {
        authorize: async (req) => {
          authorizeRequests.push({
            layer: req.name.startsWith("capability.project.")
              ? "project"
              : "self",
            capability: req.name.split(".").pop() || "",
            args: req.input as readonly unknown[],
          });
          return undefined; // Always approve
        },
      },
    });

    (agent as any).approvalStore = approvalStore;

    // Define capability
    await agent.run(`
      import eta from "eta:project";
      eta.define("testCap2", async function() { return "works"; }, { desc: "test" });
    `);

    // First call - should trigger authorization
    authorizeRequests.length = 0;
    await agent.run(`
      import cap from "eta:project:testCap2";
      export default await cap();
    `);
    expect(authorizeRequests.length).toBe(1);

    // Second call - should NOT trigger authorization
    authorizeRequests.length = 0;
    const result2 = await agent.run(`
      import cap from "eta:project:testCap2";
      export default await cap();
    `);
    expect(authorizeRequests.length).toBe(0);
    expect(result2.value).toBe("works");
  });

  test("个人层能力不弹窗", async () => {
    const authorizeRequests: AuthorizeRequest[] = [];

    const agent = new Agent({
      root: selfRoot,
      hooks: {
        authorize: async (req) => {
          authorizeRequests.push({
            layer: "self",
            capability: req.name.split(".").pop() || "",
            args: req.input as readonly unknown[],
          });
          return undefined;
        },
      },
    });

    // Define capability in self layer
    await agent.run(`
      import eta from "eta";
      eta.define("selfCap", function() { return "self-works"; }, { desc: "test" });
    `);

    // Call the capability - should NOT trigger authorization
    authorizeRequests.length = 0;
    const result = await agent.run(`
      import cap from "eta:selfCap";
      export default cap();
    `);

    expect(authorizeRequests.length).toBe(0);
    expect(result.value).toBe("self-works");
  });

  test("全局层能力首次调用弹审批", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: AuthorizeRequest[] = [];

    const agent = new Agent({
      root: selfRoot,
      global: globalRoot,
      hooks: {
        authorize: async (req) => {
          authorizeRequests.push({
            layer: req.name.startsWith("capability.global.")
              ? "global"
              : "self",
            capability: req.name.split(".").pop() || "",
            args: req.input as readonly unknown[],
          });
          return undefined; // Approve
        },
      },
    });

    (agent as any).approvalStore = approvalStore;

    // Define capability in global layer
    await agent.run(`
      import eta from "eta:global";
      eta.define("globalCap", function() { return "global-works"; }, { desc: "test" });
    `);

    // First call should trigger authorization
    authorizeRequests.length = 0;
    const result = await agent.run(`
      import cap from "eta:global:globalCap";
      export default cap();
    `);

    expect(authorizeRequests.length).toBe(1);
    expect(authorizeRequests[0]?.layer).toBe("global");
    expect(authorizeRequests[0]?.capability).toBe("globalCap");
    expect(result.value).toBe("global-works");
    expect(approvalStore.isApproved("global", "globalCap")).toBe(true);
  });

  test("拒绝时能力不执行，返回 status: 'blocked'", async () => {
    const approvalStore = new MemoryApprovalStore();

    const agent = new Agent({
      root: selfRoot,
      project: join(projectRoot, ".eta"),
      hooks: {
        authorize: async (_req) => {
          // Deny the authorization
          return "User explicitly denied this capability";
        },
      },
    });

    (agent as any).approvalStore = approvalStore;

    // Define capability
    await agent.run(`
      import eta from "eta:project";
      eta.define("deniedCap", function() { return "should-not-run"; }, { desc: "test" });
    `);

    // Try to call - should be blocked
    let errorThrown = false;
    try {
      await agent.run(`
        import cap from "eta:project:deniedCap";
        export default await cap();
      `);
    } catch (err: any) {
      errorThrown = true;
      expect(err.message).toContain("denied");
    }

    expect(errorThrown).toBe(true);
    expect(approvalStore.isApproved("project", "deniedCap")).toBe(false);
  });

  test("不同层的同名能力审批独立", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: string[] = [];

    const agent = new Agent({
      root: selfRoot,
      project: join(projectRoot, ".eta"),
      global: globalRoot,
      hooks: {
        authorize: async (req) => {
          authorizeRequests.push(req.name);
          return undefined; // Approve all
        },
      },
    });

    (agent as any).approvalStore = approvalStore;

    // Define same capability name in both project and global layers
    await agent.run(`
      import etaProject from "eta:project";
      import etaGlobal from "eta:global";
      etaProject.define("sameName", function() { return "project"; }, { desc: "test" });
      etaGlobal.define("sameName", function() { return "global"; }, { desc: "test" });
    `);

    // Call project version
    authorizeRequests.length = 0;
    await agent.run(`
      import cap from "eta:project:sameName";
      export default cap();
    `);
    expect(authorizeRequests.length).toBe(1);
    expect(authorizeRequests[0]).toContain("project");

    // Call global version - should also require authorization (separate)
    authorizeRequests.length = 0;
    await agent.run(`
      import cap from "eta:global:sameName";
      export default cap();
    `);
    expect(authorizeRequests.length).toBe(1);
    expect(authorizeRequests[0]).toContain("global");

    // Both should be recorded separately
    expect(approvalStore.isApproved("project", "sameName")).toBe(true);
    expect(approvalStore.isApproved("global", "sameName")).toBe(true);
  });
});
