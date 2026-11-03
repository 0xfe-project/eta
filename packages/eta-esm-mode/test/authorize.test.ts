import type { AuthorizeRequest } from "../src/authorize";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../src/agent";
import { MemoryApprovalStore } from "../src/authorize";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("authorization", () => {
  const testRoot = join(__dirname, "fixtures", "authorize-test");
  const selfRoot = join(testRoot, "self");
  const projectRoot = join(testRoot, "project");
  const globalRoot = join(testRoot, "global");

  beforeEach(() => {
    // Clean up and create fresh directories
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true, force: true });
    }
    mkdirSync(selfRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
  });

  it("项目层能力首次调用弹审批，批准后记录", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: AuthorizeRequest[] = [];
    const approveNext = true;

    const agent = new Agent({
      root: selfRoot,
      project: projectRoot,
      global: globalRoot,
      approvalStore,
      hooks: {
        authorize: async (req) => {
          // Parse layer from request name
          const parts = req.name.split(".");
          const layer =
            parts[1] === "project"
              ? "project"
              : parts[1] === "global"
                ? "global"
                : "self";
          const capability = parts[2] || "";

          authorizeRequests.push({
            layer: layer as any,
            capability,
            args: req.input as readonly unknown[],
          });
          return approveNext ? undefined : "User denied";
        },
      },
    });

    // Write a capability to the project env.js file
    writeFileSync(
      join(projectRoot, "env.js"),
      `
import eta from "eta";
eta.define("testCap", function() { return "works"; }, { desc: "test capability" });
`,
    );

    // First call should trigger authorization
    authorizeRequests.length = 0;
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

  it("同一能力第二次调用不弹窗", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: AuthorizeRequest[] = [];

    const agent = new Agent({
      root: selfRoot,
      project: projectRoot,
      approvalStore,
      hooks: {
        authorize: async (req) => {
          const parts = req.name.split(".");
          const layer = parts[1] === "project" ? "project" : "self";
          const capability = parts[2] || "";

          authorizeRequests.push({
            layer: layer as any,
            capability,
            args: req.input as readonly unknown[],
          });
          return undefined; // Always approve
        },
      },
    });

    // Write capability
    writeFileSync(
      join(projectRoot, "env.js"),
      `
import eta from "eta";
eta.define("testCap2", function() { return "works"; }, { desc: "test" });
`,
    );

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

  it("个人层能力不弹窗", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: AuthorizeRequest[] = [];

    const agent = new Agent({
      root: selfRoot,
      approvalStore,
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

    // Write capability to self layer
    writeFileSync(
      join(selfRoot, "env.js"),
      `
import eta from "eta";
eta.define("selfCap", function() { return "self-works"; }, { desc: "test" });
`,
    );

    // Call the capability - should NOT trigger authorization
    authorizeRequests.length = 0;
    const result = await agent.run(`
      import cap from "eta:selfCap";
      export default cap();
    `);

    expect(authorizeRequests.length).toBe(0);
    expect(result.value).toBe("self-works");
  });

  it("全局层能力首次调用弹审批", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: AuthorizeRequest[] = [];

    const agent = new Agent({
      root: selfRoot,
      global: globalRoot,
      approvalStore,
      hooks: {
        authorize: async (req) => {
          const parts = req.name.split(".");
          const layer = parts[1] === "global" ? "global" : "self";
          const capability = parts[2] || "";

          authorizeRequests.push({
            layer: layer as any,
            capability,
            args: req.input as readonly unknown[],
          });
          return undefined; // Approve
        },
      },
    });

    // Write capability to global layer
    writeFileSync(
      join(globalRoot, "env.js"),
      `
import eta from "eta";
eta.define("globalCap", function() { return "global-works"; }, { desc: "test" });
`,
    );

    // First call should trigger authorization
    authorizeRequests.length = 0;
    const result = await agent.run(`
      import cap from "eta:global:globalCap";
      export default await cap();
    `);

    expect(authorizeRequests.length).toBe(1);
    expect(authorizeRequests[0]?.layer).toBe("global");
    expect(authorizeRequests[0]?.capability).toBe("globalCap");
    expect(result.value).toBe("global-works");
    expect(approvalStore.isApproved("global", "globalCap")).toBe(true);
  });

  it("拒绝时能力不执行，返回 status: 'blocked'", async () => {
    const approvalStore = new MemoryApprovalStore();

    const agent = new Agent({
      root: selfRoot,
      project: projectRoot,
      approvalStore,
      hooks: {
        authorize: async (_req) => {
          // Deny the authorization
          return "User explicitly denied this capability";
        },
      },
    });

    // Write capability
    writeFileSync(
      join(projectRoot, "env.js"),
      `
import eta from "eta";
eta.define("deniedCap", function() { return "should-not-run"; }, { desc: "test" });
`,
    );

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

  it("不同层的同名能力审批独立", async () => {
    const approvalStore = new MemoryApprovalStore();
    const authorizeRequests: string[] = [];

    const agent = new Agent({
      root: selfRoot,
      project: projectRoot,
      global: globalRoot,
      approvalStore,
      hooks: {
        authorize: async (req) => {
          authorizeRequests.push(req.name);
          return undefined; // Approve all
        },
      },
    });

    // Write same capability name to both layers
    writeFileSync(
      join(projectRoot, "env.js"),
      `
import eta from "eta";
eta.define("sameName", function() { return "project"; }, { desc: "test" });
`,
    );

    writeFileSync(
      join(globalRoot, "env.js"),
      `
import eta from "eta";
eta.define("sameName", function() { return "global"; }, { desc: "test" });
`,
    );

    // Reload layers to pick up the new capabilities
    agent.reload();

    // Call project version
    authorizeRequests.length = 0;
    await agent.run(`
      import cap from "eta:project:sameName";
      export default await cap();
    `);
    expect(authorizeRequests.length).toBe(1);
    expect(authorizeRequests[0]).toContain("project");

    // Call global version - should also require authorization (separate)
    authorizeRequests.length = 0;
    await agent.run(`
      import cap from "eta:global:sameName";
      export default await cap();
    `);
    expect(authorizeRequests.length).toBe(1);
    expect(authorizeRequests[0]).toContain("global");

    // Both should be recorded separately
    expect(approvalStore.isApproved("project", "sameName")).toBe(true);
    expect(approvalStore.isApproved("global", "sameName")).toBe(true);
  });
});
