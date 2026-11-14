import type { AuthorizeRequest } from "../../src/realm/authorize";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Agent } from "../../src/realm/agent";
import {
  defaultApprovalStorePath,
  FileApprovalStore,
} from "../../src/realm/authorize";

describe("authorization", () => {
  let testRoot = "";
  let selfRoot = "";
  let projectRoot = "";
  let globalRoot = "";

  // What the agent wrote to its own approvals file, read back by a fresh reader.
  const approvalStore = {
    isApproved: (layer: "project" | "global", capability: string) =>
      new FileApprovalStore(defaultApprovalStorePath(selfRoot)).isApproved(
        layer,
        capability,
      ),
  };

  beforeEach(() => {
    testRoot = mkdtempSync(join(tmpdir(), "eta-authorize-"));
    selfRoot = join(testRoot, "self");
    projectRoot = join(testRoot, "project");
    globalRoot = join(testRoot, "global");
    mkdirSync(selfRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
  });

  afterEach(() => rmSync(testRoot, { recursive: true, force: true }));

  it("项目层能力首次调用弹审批，批准后记录", async () => {
    if (process.platform === "win32") return;
    const authorizeRequests: AuthorizeRequest[] = [];
    const approveNext = true;

    const agent = new Agent({
      root: selfRoot,
      project: projectRoot,
      global: globalRoot,
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
    const authorizeRequests: AuthorizeRequest[] = [];

    const agent = new Agent({
      root: selfRoot,
      project: projectRoot,
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
    const authorizeRequests: AuthorizeRequest[] = [];

    const agent = new Agent({
      root: selfRoot,
      global: globalRoot,
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

  it("拒绝时能力不执行，脚本收到拒绝", async () => {
    const marker = join(testRoot, "ran.txt");
    const agent = new Agent({
      root: selfRoot,
      project: projectRoot,
      hooks: {
        // Deny the capability itself; the file write inside it would be allowed.
        authorize: async (req) =>
          req.name.startsWith("capability.")
            ? "User explicitly denied this capability"
            : undefined,
      },
    });

    // The capability leaves a mark when its body runs.
    writeFileSync(
      join(projectRoot, "env.js"),
      `
import eta from "eta";
import { writeFileSync } from "node:fs";
eta.define("deniedCap", function() { writeFileSync(${JSON.stringify(marker)}, "ran"); return "should-not-run"; }, { desc: "test" });
`,
    );

    await expect(
      agent.run(`
        import cap from "eta:project:deniedCap";
        export default await cap();
      `),
    ).rejects.toThrow(/denied/);

    expect(existsSync(marker)).toBe(false);
    expect(approvalStore.isApproved("project", "deniedCap")).toBe(false);
  });

  it("不同层的同名能力审批独立", async () => {
    const authorizeRequests: string[] = [];

    const agent = new Agent({
      root: selfRoot,
      project: projectRoot,
      global: globalRoot,
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
