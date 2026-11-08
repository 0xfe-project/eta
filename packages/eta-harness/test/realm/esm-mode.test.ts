import type { Hooks } from "../../src/realm/index";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Agent,
  mountGlobals,
  mountModules,
  mountNodeGlobals,
  Realm,
} from "../../src/realm/index";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "esm-mode-test-"));
});

afterEach(() => {
  root = "";
});

describe("realm", () => {
  it("runs a module with top-level await and returns its default", async () => {
    const realm = new Realm({ name: "test" });
    const result = await realm.evaluate(
      `const n = await Promise.resolve(2);\nexport default n * 3;`,
    );
    expect(result.value).toBe(6);
  });

  it("a bare specifier resolves to the built-in, not npm", async () => {
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
    });
    await writeFile(join(root, "note.txt"), "bare");

    // No node_modules anywhere near `root`: if the bare specifier reached the
    // package resolver it would install the same-named npm dummy and fail.
    const result = await realm.evaluate(
      `import { readFile } from "fs/promises";\n\nconst text = await readFile(${JSON.stringify(join(root, "note.txt"))});\nexport default text;`,
      { identifier: join(root, "probe.js") },
    );

    expect(result.value).toBe("bare");
    expect(result.effects[0]?.name).toBe("fs.readFile");
  });

  it("a curated module answers a default import the way Node's interop does", async () => {
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
    });

    const result = await realm.evaluate(
      `import fs from "fs";\nexport default typeof fs.readFileSync;`,
      { identifier: join(root, "probe.js") },
    );

    expect(result.value).toBe("function");
  });

  it("a passthrough module answers with the host's own object", async () => {
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
    });

    const result = await realm.evaluate(
      `import os from "os";\nexport default typeof os.platform;`,
      { identifier: join(root, "probe.js") },
    );

    expect(result.value).toBe("function");
  });

  it("the node globals are the host's own objects", async () => {
    const realm = new Realm({
      name: "test",
      mounts: (r) => {
        mountNodeGlobals(r);
        return mountModules(r, { root });
      },
    });

    const result = await realm.evaluate(
      `export default [typeof process, Buffer.isBuffer(Buffer.from("hi"))];`,
      { identifier: join(root, "probe.js") },
    );

    expect(result.value).toEqual(["object", true]);
  });

  it("child_process is a built-in that is not mounted, bare or prefixed", async () => {
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
    });

    const bare = await realm
      .evaluate(`import { execFile } from "child_process";\nexport default 1;`)
      .catch((e: Error) => e);
    expect(bare).toBeInstanceOf(Error);
    expect((bare as Error).message).toContain("not mounted");

    const prefixed = await realm
      .evaluate(
        `import { execFile } from "node:child_process";\nexport default 1;`,
      )
      .catch((e: Error) => e);
    expect(prefixed).toBeInstanceOf(Error);
    expect((prefixed as Error).message).toContain("not mounted");
  });

  it("effects carry the line and column that made the call", async () => {
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
    });
    await writeFile(join(root, "note.txt"), "hello");

    const result = await realm.evaluate(
      `import { readFile } from "node:fs/promises";\n\nconst text = await readFile(${JSON.stringify(join(root, "note.txt"))});\nexport default text;`,
      { identifier: join(root, "probe.js") },
    );

    expect(result.value).toBe("hello");
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]?.name).toBe("fs.readFile");
    expect(result.effects[0]?.at.line).toBe(3);
    expect(result.effects[0]?.status).toBe("ok");
  });

  it("a failed binding is recorded and still throws into the script", async () => {
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
    });
    const error = await realm
      .evaluate(
        `import { readFile } from "node:fs/promises";\nexport default await readFile("/nope/missing");`,
        {
          identifier: join(root, "probe.js"),
        },
      )
      .catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ENOENT");
    expect(realm.effects.at(-1)?.status).toBe("failed");
  });

  it("a synchronous spin is cut off by the timeout", async () => {
    const realm = new Realm({ name: "test" });
    const error = await realm
      .evaluate(`while (true) {}`, { timeoutMs: 100 })
      .catch((e: Error) => e);
    expect((error as Error).message).toMatch(/timed out/i);
  });

  it("two realms do not share globals", async () => {
    const a = new Realm({ name: "a" });
    const b = new Realm({ name: "b" });
    await a.evaluate(`globalThis.leak = 7;`);
    expect(
      await b.evaluate(`export default typeof globalThis.leak;`),
    ).toMatchObject({ value: "undefined" });
  });
});

describe("modules", () => {
  it("a relative import shares the realm and its globals", async () => {
    await mkdir(join(root, "lib"), { recursive: true });
    await writeFile(
      join(root, "lib", "count.js"),
      `export function count(text, needle) {\n  return text.split("\\n").filter((line) => line.includes(needle)).length;\n}\n`,
    );

    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
    });
    const result = await realm.evaluate(
      `import { count } from "./lib/count.js";\nexport default count("a\\nERROR b\\nc", "ERROR");`,
      { identifier: join(root, "probe.js") },
    );
    expect(result.value).toBe(1);
  });

  // Autoinstall is Bun's: it lives in `Bun.resolveSync`. Under plain node with
  // `--experimental-vm-modules` resolution walks node_modules by hand.
  it.skipIf(typeof (globalThis as { Bun?: unknown }).Bun === "undefined")(
    "a bare specifier resolves to a package",
    async () => {
      const realm = new Realm({
        name: "test",
        mounts: (r) => mountModules(r, { root }),
      });
      const result = await realm.evaluate(
        `import Queue from "yocto-queue";\nconst q = new Queue();\nq.enqueue(1);\nexport default q.size;`,
        { identifier: join(root, "probe.js") },
      );
      expect(result.value).toBe(1);
      // The install is a change in the project, not a hit in a global cache.
      expect(
        existsSync(join(root, "node_modules", "yocto-queue", "package.json")),
      ).toBe(true);
      const manifest = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
      };
      expect(manifest.dependencies?.["yocto-queue"]).toBeDefined();
    },
  );

  it("an unmounted specifier names itself in the error", async () => {
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
      authorize: (request) =>
        request.name === "packages.install" ? "no installs here" : undefined,
    });
    const error = await realm
      .evaluate(`import thing from "left-pad";\nexport default thing;`, {
        identifier: join(root, "probe.js"),
      })
      .catch((e: Error) => e);
    expect((error as Error).message).toContain("left-pad");
    expect(realm.effects.map((effect) => effect.status)).toEqual(["blocked"]);
  });
});

describe("env.js", () => {
  it("an ability is written as source and comes back on wake", async () => {
    const agent = new Agent({ root });
    agent.env.add("shout", `(text) => text.toUpperCase()`, {
      desc: "uppercase",
    });
    agent.env.save();

    const result = await agent.run(
      `import eta from "eta"; const { shout } = eta.modules; export default shout("hi");`,
      {
        identifier: join(root, "probe.js"),
      },
    );
    expect(result.value).toBe("HI");
  });

  it("a taken name is refused rather than replaced", () => {
    const agent = new Agent({ root });
    agent.env.add("shout", `(text) => text.toUpperCase()`);
    expect(() => agent.env.add("shout", `() => 1`)).toThrow(/already exists/);
  });

  it("editing the file re-wakes the realm with the new ability", async () => {
    const agent = new Agent({ root });
    agent.env.add("one", `() => 1`);
    agent.env.save();
    expect(
      (
        await agent.run(
          `import eta from "eta"; const { one } = eta.modules; export default one();`,
          {
            identifier: join(root, "p.js"),
          },
        )
      ).value,
    ).toBe(1);
    expect(agent.awake).toBe(true);

    agent.env.add("two", `() => 2`);
    agent.env.save();
    expect(agent.awake).toBe(false);

    const after = await agent.run(
      `import eta from "eta"; const { two } = eta.modules; export default two();`,
      {
        identifier: join(root, "p2.js"),
      },
    );
    expect(after.value).toBe(2);
    expect(agent.awake).toBe(true);
  });

  it("the hand-written half survives a write", async () => {
    const agent = new Agent({ root });
    agent.env.add("one", `() => 1`);
    agent.env.save();
    const first = await readFile(join(root, "env.js"), "utf8");
    const withHand = `${first}\nexport const lastError = "boom";\n`;
    await writeFile(join(root, "env.js"), withHand);

    const again = new Agent({ root });
    again.env.add("two", `() => 2`);
    again.env.save();
    expect(await readFile(join(root, "env.js"), "utf8")).toContain(
      `export const lastError = "boom";`,
    );
  });
});

describe("hooks", () => {
  it("every hook is reachable and every call lands in the ledger", async () => {
    const seen: string[] = [];
    const hooks: Hooks = {
      onConsole: (level, line) => seen.push(`${level}:${line}`),
      ctx: () => ({
        frame: { id: "f1", parent: null, seq: 0 },
        budget: { limit: 100, spent: 0 },
        messages: async () => [{ role: "user", text: "hi" }],
      }),
      emit: { progress: (text) => seen.push(`progress:${text}`) },
      tools: { ask: async (question) => `asked:${question}` },
      platform: { classify: async () => "spam" },
      memory: {
        append: async () => {},
        read: async (query) => `note:${query}`,
      },
      spawn: async (request) => ({
        text: `child:${request.prompt}`,
        effects: [],
      }),
    };

    const agent = new Agent({ root, hooks });
    const result = await agent.run(
      `import eta from "eta";
emit.progress("go");
const last = (await ctx.messages(1))[0];
const label = await eta.platform.classify({});
const note = await eta.memory.read("x");
const child = await eta.spawn({ prompt: "y" });
const asked = await tools.ask("z");
console.log("done");
export default [last.text, label, note, child.text, asked].join("|");`,
      { identifier: join(root, "probe.js") },
    );

    expect(result.value).toBe("hi|spam|note:x|child:y|asked:z");
    expect(result.effects.map((effect) => effect.name)).toEqual([
      "emit.progress",
      "ctx.messages",
      "eta.platform.classify",
      "eta.memory.read",
      "eta.spawn",
      "tools.ask",
    ]);
    expect(seen).toContain("log:done");
  });

  it("a realm with no hooks still evaluates", async () => {
    const realm = new Realm({ name: "bare" });
    mountGlobals(realm);
    expect((await realm.evaluate(`export default 1 + 1;`)).value).toBe(2);
  });
});

describe("console", () => {
  it("console output is captured, not written to the host", async () => {
    const lines: string[] = [];
    const realm = new Realm({
      name: "test",
      onConsole: (level, line) => lines.push(`${level}:${line}`),
    });
    await realm.evaluate(`console.log("a", 1);\nconsole.warn("b");`);
    expect(lines).toEqual(["log:a 1", "warn:b"]);
  });
});

describe("authorize", () => {
  it("a refused call is recorded as blocked and never reaches the host", async () => {
    const target = join(root, "keep.txt");
    await writeFile(target, "still here");

    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
      authorize: (request) =>
        request.name === "fs.rm" ? "no deleting files" : undefined,
    });

    const error = await realm
      .evaluate(
        `import { rm } from "node:fs/promises";\nexport default await rm(${JSON.stringify(target)});`,
        { identifier: join(root, "probe.js") },
      )
      .catch((e: Error) => e);

    expect((error as Error).message).toContain("no deleting files");
    expect(realm.effects.at(-1)).toMatchObject({
      name: "fs.rm",
      status: "blocked",
      detail: "no deleting files",
    });
    expect(await readFile(target, "utf8")).toBe("still here");
  });

  it("an allowed call runs and keeps the line it was made on", async () => {
    await writeFile(join(root, "note.txt"), "hello");
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
      authorize: () => undefined,
    });

    const result = await realm.evaluate(
      `import { readFile } from "node:fs/promises";\n\nexport default await readFile(${JSON.stringify(join(root, "note.txt"))});`,
      { identifier: join(root, "probe.js") },
    );

    expect(result.value).toBe("hello");
    expect(result.effects[0]).toMatchObject({
      name: "fs.readFile",
      status: "ok",
    });
    expect(result.effects[0]?.at.line).toBe(3);
  });

  it("the authorizer may take its time", async () => {
    const asked: string[] = [];
    const realm = new Realm({
      name: "test",
      mounts: (r) => mountModules(r, { root }),
      authorize: async (request) => {
        await new Promise((done) => setTimeout(done, 5));
        asked.push(request.name);
        return undefined;
      },
    });

    const result = await realm.evaluate(
      `import { readdir } from "node:fs/promises";\nexport default (await readdir(${JSON.stringify(root)})).length;`,
      { identifier: join(root, "probe.js") },
    );
    expect(result.value).toBeGreaterThanOrEqual(0);
    expect(asked).toEqual(["fs.readdir"]);
  });
});

describe("kill", () => {
  it("a killed realm stops answering", async () => {
    const realm = new Realm({ name: "test" });
    expect((await realm.evaluate(`export default 1;`)).value).toBe(1);
    realm.kill();
    await expect(realm.evaluate(`export default 2;`)).rejects.toThrow(/killed/);
  });

  it("an agent comes back after its realm was killed", async () => {
    const agent = new Agent({ root });
    agent.env.add("one", `() => 1`);
    agent.env.save();
    expect(
      (
        await agent.run(
          `import eta from "eta"; const { one } = eta.modules; export default one();`,
          {
            identifier: join(root, "p.js"),
          },
        )
      ).value,
    ).toBe(1);

    agent.dispose();
    const after = await agent.run(
      `import eta from "eta"; const { one } = eta.modules; export default one() + 1;`,
      {
        identifier: join(root, "p2.js"),
      },
    );
    expect(after.value).toBe(2);
  });
});

describe("waking", () => {
  it("two runs arriving at once wake the realm once", async () => {
    await writeFile(
      join(root, "env.js"),
      `import eta from "eta"; const marked = await eta.platform.mark(); eta.define("seen", () => marked);\n`,
    );
    let marks = 0;
    const agent = new Agent({
      root,
      hooks: {
        platform: {
          mark: async () => {
            marks += 1;
            return marks;
          },
        },
      },
    });

    const [a, b] = await Promise.all([
      agent.run(
        `import eta from "eta"; const { seen } = eta.modules; export default seen();`,
        {
          identifier: join(root, "a.js"),
        },
      ),
      agent.run(
        `import eta from "eta"; const { seen } = eta.modules; export default seen();`,
        {
          identifier: join(root, "b.js"),
        },
      ),
    ]);

    expect(marks).toBe(1);
    expect(a.value).toBe(1);
    expect(b.value).toBe(1);
  });

  it("a failed wake is not remembered as a success", async () => {
    await writeFile(join(root, "env.js"), `throw new Error("boom");\n`);
    const agent = new Agent({ root });

    await expect(agent.run(`export default 1;`)).rejects.toThrow(/boom/);
    expect(agent.awake).toBe(false);

    // The failed attempt is not remembered as a wake: the next run tries again.
    await expect(agent.run(`export default 2;`)).rejects.toThrow(/boom/);

    await writeFile(join(root, "env.js"), `export const fixed = 2;\n`);
    expect((await agent.run(`export default 3;`)).value).toBe(3);
    expect(agent.awake).toBe(true);
  });
});

describe("$", () => {
  it("the shell is there without importing anything", async () => {
    const agent = new Agent({ root });
    const script =
      "const out = await $`echo hi`;\nexport default { stdout: out.stdout.trim(), code: out.exitCode };";
    const result = await agent.run(script, {
      identifier: join(root, "probe.js"),
    });
    expect(result.value).toEqual({ stdout: "hi", code: 0 });
  });

  it("a failing command throws the way zx throws", async () => {
    const agent = new Agent({ root });
    const script = "await $`exit 3`;\nexport default 0;";
    const error = (await agent
      .run(script, { identifier: join(root, "probe.js") })
      .catch((e: Error) => e)) as Error;
    // Bun and Node word the same failure differently; both name the code.
    expect(error.message).toMatch(/zx error|exit code:? 3/);
  });

  it("the chained methods a prompt promises work inside the realm", async () => {
    const agent = new Agent({ root });
    const script = [
      "const started = Date.now();",
      "let timedOut = false;",
      "try { await $`sleep 5`.timeout('300ms'); } catch { timedOut = true; }",
      "const elapsed = Date.now() - started;",
      "const failed = await $`exit 3`.nothrow();",
      "const quiet = await $`echo hi`.quiet();",
      "const piped = await $`echo a b c`.pipe($`wc -w`);",
      "export default { timedOut, fast: elapsed < 3000, code: failed.exitCode, quiet: quiet.stdout.trim(), words: piped.stdout.trim() };",
    ].join("\n");
    const result = await agent.run(script, {
      identifier: join(root, "probe.js"),
    });
    expect(result.value).toEqual({
      timedOut: true,
      fast: true,
      code: 3,
      quiet: "hi",
      words: "3",
    });
  });

  it("a command is not a binding call, so it leaves no row", async () => {
    const agent = new Agent({ root });
    const result = await agent.run("await $`true`;\nexport default 1;", {
      identifier: join(root, "probe.js"),
    });
    expect(result.effects).toHaveLength(0);
  });
});
