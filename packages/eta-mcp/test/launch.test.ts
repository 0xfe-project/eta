import type { ResolverEnv } from "../src";
/**
 * Launch acceleration: npx, npm exec, bunx and uvx resolved to cached executables, against fake
 * package caches. Anything doubtful must leave the command alone.
 */
import {
  chmodSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveLaunch } from "../src";
import { cleanupAll, setup, tool } from "./helpers/harness";

const HOUR = 60 * 60 * 1000;
let root: string;
let clock: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eta-mcp-launch-"));
  clock = Date.now();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function env(extra: ResolverEnv = {}): ResolverEnv {
  return {
    cacheFile: join(root, "resolutions.json"),
    now: () => clock,
    npmCacheDir: () => join(root, "npm"),
    bunxDir: join(root, "bunx"),
    uid: 1000,
    uvCacheDir: () => join(root, "uv"),
    warm: false,
    ...extra,
  };
}

/** `<npm>/_npx/<hash>/node_modules/<name>` with a bin, a `.bin` link, and an optional script. */
function npxPackage(
  hash: string,
  name: string,
  options: {
    version?: string;
    bin?: string | Record<string, string>;
    shebang?: string;
  } = {},
): string {
  const modules = join(root, "npm", "_npx", hash, "node_modules");
  const dir = join(modules, name);
  mkdirSync(dir, { recursive: true });
  const bin = options.bin ?? "cli.js";
  const first = typeof bin === "string" ? bin : Object.values(bin)[0]!;
  mkdirSync(dirname(join(dir, first)), { recursive: true });
  writeFileSync(
    join(dir, first),
    `${options.shebang ?? "#!/usr/bin/env node"}\nconsole.log(1)\n`,
  );
  chmodSync(join(dir, first), 0o755);
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: options.version ?? "1.0.0", bin }),
  );
  mkdirSync(join(modules, ".bin"), { recursive: true });
  const linkName =
    typeof bin === "string" ? name.split("/").at(-1)! : Object.keys(bin)[0]!;
  symlinkSync(join(dir, first), join(modules, ".bin", linkName));
  return join(dir, first);
}

describe("npx", () => {
  it("starts the cached executable with node, passing the arguments through", async () => {
    const bin = npxPackage("h1", "demo-pkg");
    const launch = await resolveLaunch(
      "npx",
      ["-y", "demo-pkg", "--token=secret", "--", "x"],
      env(),
    );
    expect(launch).toEqual({
      command: "node",
      args: [await realBin(bin), "--token=secret", "--", "x"],
    });
  });

  it("handles scoped packages, -p/--package, and npm exec", async () => {
    const bin = npxPackage("h2", "@scope/tool", {
      bin: { "tool-cli": "bin/cli.js" },
    });
    const real = await realBin(bin);
    expect(await resolveLaunch("npx", ["-y", "@scope/tool"], env())).toEqual({
      command: "node",
      args: [real],
    });
    expect(
      await resolveLaunch("npx", ["-p", "@scope/tool", "tool-cli", "a"], env()),
    ).toEqual({ command: "node", args: [real, "a"] });
    expect(
      await resolveLaunch("npx", ["--package=@scope/tool", "tool-cli"], env()),
    ).toEqual({ command: "node", args: [real] });
    expect(
      await resolveLaunch(
        "npm",
        ["exec", "--yes", "--package", "@scope/tool", "--", "tool-cli", "b"],
        env(),
      ),
    ).toEqual({ command: "node", args: [real, "b"] });
  });

  it("runs a native executable directly", async () => {
    const bin = npxPackage("h3", "native-pkg", {
      bin: "run.sh",
      shebang: "#!/bin/sh",
    });
    expect(await resolveLaunch("npx", ["native-pkg", "x"], env())).toEqual({
      command: await realBin(bin),
      args: ["x"],
    });
  });

  it("leaves the command alone for flags it does not know, unknown packages and other commands", async () => {
    npxPackage("h4", "demo-pkg");
    for (const args of [
      ["--no-install", "demo-pkg"],
      ["-y"],
      ["unknown-pkg"],
      ["./local-script.js"],
      ["https://example.com/p.tgz"],
      [],
    ]) {
      expect(await resolveLaunch("npx", args, env())).toEqual({
        command: "npx",
        args,
      });
    }
    expect(await resolveLaunch("npm", ["install"], env())).toEqual({
      command: "npm",
      args: ["install"],
    });
    expect(await resolveLaunch("node", ["server.js"], env())).toEqual({
      command: "node",
      args: ["server.js"],
    });
  });

  it("will not start a different bin than the one asked for", async () => {
    npxPackage("h5", "multi", { bin: { one: "one.js" } });
    expect(await resolveLaunch("npx", ["-p", "multi", "two"], env())).toEqual({
      command: "npx",
      args: ["-p", "multi", "two"],
    });
  });

  it("matches an exact version only", async () => {
    const bin = npxPackage("h6", "versioned", { version: "1.2.3" });
    expect(
      (await resolveLaunch("npx", ["versioned@1.2.3"], env())).command,
    ).toBe("node");
    expect(await resolveLaunch("npx", ["versioned@1.2.3"], env())).toEqual({
      command: "node",
      args: [await realBin(bin)],
    });
    expect(await resolveLaunch("npx", ["versioned@2.0.0"], env())).toEqual({
      command: "npx",
      args: ["versioned@2.0.0"],
    });
    // A tag or range is not pinned: whatever is cached is used.
    expect(
      (await resolveLaunch("npx", ["versioned@latest"], env())).command,
    ).toBe("node");
  });

  it("remembers a resolution for 24 hours, and an exact version for as long as the file exists", async () => {
    const old = npxPackage("old", "floating", { version: "1.0.0" });
    const pinned = npxPackage("pin", "pinned", { version: "3.0.0" });
    const realOld = await realBin(old);
    const realPinned = await realBin(pinned);
    await resolveLaunch("npx", ["floating"], env());
    await resolveLaunch("npx", ["pinned@3.0.0"], env());
    const stored = JSON.parse(
      await readFile(join(root, "resolutions.json"), "utf8"),
    ) as { entries: Record<string, { bin: string }> };
    expect(
      Object.values(stored.entries)
        .map((entry) => entry.bin)
        .sort(),
    ).toEqual([realOld, realPinned].sort());

    // The package cache is replaced by a newer floating version; the exact one is untouched.
    const fresh = npxPackage("new", "floating", { version: "2.0.0" });
    const later = new Date(clock + HOUR);
    utimesSync(join(root, "npm", "_npx", "new"), later, later);
    expect((await resolveLaunch("npx", ["floating"], env())).args[0]).toBe(
      realOld,
    );
    clock += 25 * HOUR;
    expect((await resolveLaunch("npx", ["floating"], env())).args[0]).toBe(
      await realBin(fresh),
    );
    expect((await resolveLaunch("npx", ["pinned@3.0.0"], env())).args[0]).toBe(
      realPinned,
    );
  });

  it("fills npm's cache for a package nobody ran yet, once", async () => {
    const warm = vi.fn(async () => {
      npxPackage("warmed", "fresh-pkg");
    });
    const launch = await resolveLaunch(
      "npx",
      ["-y", "fresh-pkg"],
      env({ warm }),
    );
    expect(warm).toHaveBeenCalledTimes(1);
    expect(launch.command).toBe("node");
    await resolveLaunch("npx", ["-y", "fresh-pkg"], env({ warm }));
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("falls back when warming does not help, and when the cache is unreadable", async () => {
    const warm = vi.fn(async () => undefined);
    expect(
      await resolveLaunch("npx", ["-y", "nothing"], env({ warm })),
    ).toEqual({ command: "npx", args: ["-y", "nothing"] });
    expect(
      await resolveLaunch(
        "npx",
        ["-y", "nothing"],
        env({ npmCacheDir: () => undefined }),
      ),
    ).toEqual({ command: "npx", args: ["-y", "nothing"] });
    expect(
      await resolveLaunch(
        "npx",
        ["-y", "nothing"],
        env({
          npmCacheDir: () => {
            throw new Error("npm broke");
          },
        }),
      ),
    ).toEqual({ command: "npx", args: ["-y", "nothing"] });
  });

  it("survives a corrupt resolution file", async () => {
    npxPackage("h7", "demo-pkg");
    writeFileSync(join(root, "resolutions.json"), "{ not json");
    expect((await resolveLaunch("npx", ["demo-pkg"], env())).command).toBe(
      "node",
    );
  });
});

/** The path a symlink resolves to, as the resolver stores it. */
async function realBin(path: string): Promise<string> {
  return await realpath(path);
}

describe("bunx", () => {
  function bunxPackage(
    directory: string,
    name: string,
    version = "1.0.0",
    options: { bin?: string } = {},
  ): string {
    const dir = join(root, "bunx", directory, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    const bin = options.bin ?? "cli.js";
    writeFileSync(join(dir, bin), "#!/usr/bin/env node\n");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        version,
        bin: { [name.split("/").at(-1)!]: bin },
      }),
    );
    return join(dir, bin);
  }

  it("finds an exact version by its directory, in both spellings of the command", async () => {
    const bin = bunxPackage("bunx-1000-demo@1.2.3", "demo", "1.2.3");
    expect(
      await resolveLaunch("bunx", ["demo@1.2.3", "--flag"], env()),
    ).toEqual({ command: "node", args: [bin, "--flag"] });
    expect(await resolveLaunch("bun", ["x", "demo@1.2.3"], env())).toEqual({
      command: "node",
      args: [bin],
    });
    expect(await resolveLaunch("bunx", ["demo@1.2.4"], env())).toEqual({
      command: "bunx",
      args: ["demo@1.2.4"],
    });
  });

  it("finds a floating version while its directory is under 24 hours old", async () => {
    const bin = bunxPackage("bunx-1000-demo@latest", "demo");
    const dir = join(root, "bunx", "bunx-1000-demo@latest");
    const now = new Date(clock);
    utimesSync(dir, now, now);
    expect(await resolveLaunch("bunx", ["demo"], env())).toEqual({
      command: "node",
      args: [bin],
    });
    const stale = new Date(clock - 30 * HOUR);
    utimesSync(dir, stale, stale);
    // Remembered for a day, then the directory itself is too old to trust.
    clock += 25 * HOUR;
    expect(await resolveLaunch("bunx", ["demo"], env())).toEqual({
      command: "bunx",
      args: ["demo"],
    });
  });

  it("finds scoped packages and honours --bun and -p", async () => {
    const bin = bunxPackage(
      "bunx-1000-@scope/tool@2.0.0",
      "@scope/tool",
      "2.0.0",
    );
    expect(
      await resolveLaunch("bunx", ["--bun", "@scope/tool@2.0.0"], env()),
    ).toEqual({ command: "bun", args: [bin] });
    expect(
      await resolveLaunch(
        "bunx",
        ["-p", "@scope/tool@2.0.0", "tool", "x"],
        env(),
      ),
    ).toEqual({ command: "node", args: [bin, "x"] });
  });

  it("ignores other users' directories and unknown flags", async () => {
    bunxPackage("bunx-1001-demo@1.0.0", "demo", "1.0.0");
    expect(await resolveLaunch("bunx", ["demo@1.0.0"], env())).toEqual({
      command: "bunx",
      args: ["demo@1.0.0"],
    });
    bunxPackage("bunx-1000-other@1.0.0", "other", "1.0.0");
    expect(
      await resolveLaunch("bunx", ["--no-install", "other@1.0.0"], env()),
    ).toEqual({ command: "bunx", args: ["--no-install", "other@1.0.0"] });
    expect(await resolveLaunch("bun", ["run", "x"], env())).toEqual({
      command: "bun",
      args: ["run", "x"],
    });
  });
});

describe("uvx", () => {
  function uvEnvironment(
    hash: string,
    distribution: string,
    version: string,
    script = distribution,
  ): string {
    const environment = join(root, "uv", "environments-v2", hash);
    const site = join(
      environment,
      "lib",
      "python3.12",
      "site-packages",
      `${distribution.replace(/-/g, "_")}-${version}.dist-info`,
    );
    mkdirSync(site, { recursive: true });
    mkdirSync(join(environment, "bin"), { recursive: true });
    writeFileSync(join(environment, "bin", script), "#!/path/to/python\n");
    chmodSync(join(environment, "bin", script), 0o755);
    return join(environment, "bin", script);
  }

  it("finds the environment by what is installed in it", async () => {
    const bin = uvEnvironment("abc", "my-tool", "1.2.3");
    expect(await resolveLaunch("uvx", ["my-tool", "--help"], env())).toEqual({
      command: bin,
      args: ["--help"],
    });
    expect(await resolveLaunch("uvx", ["my-tool@1.2.3"], env())).toEqual({
      command: bin,
      args: [],
    });
    expect(await resolveLaunch("uvx", ["my-tool==1.2.3"], env())).toEqual({
      command: bin,
      args: [],
    });
    expect(
      await resolveLaunch("uv", ["tool", "run", "my-tool"], env()),
    ).toEqual({ command: bin, args: [] });
  });

  it("requires the exact version when one is pinned", async () => {
    uvEnvironment("abc", "my-tool", "1.2.3");
    expect(await resolveLaunch("uvx", ["my-tool==1.2.4"], env())).toEqual({
      command: "uvx",
      args: ["my-tool==1.2.4"],
    });
    const other = uvEnvironment("def", "my-tool", "2.0.0");
    expect(await resolveLaunch("uvx", ["my-tool@2.0.0"], env())).toEqual({
      command: other,
      args: [],
    });
  });

  it("supports --from with a different script name", async () => {
    const bin = uvEnvironment("abc", "big-package", "0.5.0", "bp");
    expect(
      await resolveLaunch(
        "uvx",
        ["--from", "big-package==0.5.0", "bp", "run"],
        env(),
      ),
    ).toEqual({ command: bin, args: ["run"] });
    expect(
      await resolveLaunch("uvx", ["--from=big-package@0.5.0", "bp"], env()),
    ).toEqual({ command: bin, args: [] });
    expect(
      await resolveLaunch(
        "uvx",
        ["--from", "big-package", "missing-script"],
        env(),
      ),
    ).toEqual({
      command: "uvx",
      args: ["--from", "big-package", "missing-script"],
    });
  });

  it("takes a floating version only from a fresh environment", async () => {
    const bin = uvEnvironment("abc", "my-tool", "1.2.3");
    const environment = join(root, "uv", "environments-v2", "abc");
    const old = new Date(clock - 30 * HOUR);
    utimesSync(environment, old, old);
    expect(await resolveLaunch("uvx", ["my-tool"], env())).toEqual({
      command: "uvx",
      args: ["my-tool"],
    });
    const now = new Date(clock);
    utimesSync(environment, now, now);
    expect(await resolveLaunch("uvx", ["my-tool"], env())).toEqual({
      command: bin,
      args: [],
    });
  });

  it("leaves the command alone for flags, ranges, extras and sources it cannot judge", async () => {
    uvEnvironment("abc", "my-tool", "1.2.3");
    for (const args of [
      ["--with", "x", "my-tool"],
      ["--python", "3.12", "my-tool"],
      ["my-tool>=1"],
      ["my-tool[extra]"],
      ["git+https://example.com/x.git"],
      ["./local"],
      [],
    ]) {
      expect(await resolveLaunch("uvx", args, env())).toEqual({
        command: "uvx",
        args,
      });
    }
  });
});

describe("in the manager", () => {
  it("starts a server through the resolved executable instead of npx", async () => {
    const fixture = fileURLToPath(
      new URL("./fixtures/stdio-server.ts", import.meta.url),
    );
    // A package whose executable is a shell script starting the fake server; npx itself could not
    // run it (it would go to the network for a package that does not exist).
    const bin = npxPackage("mgr", "fake-mcp-pkg", {
      bin: "run.sh",
      shebang: "#!/bin/sh",
    });
    writeFileSync(bin, `#!/bin/sh\nexec bun ${fixture} "$@"\n`);
    const h = await setup({
      resolvers: {
        npmCacheDir: () => join(root, "npm"),
        warm: false,
        cacheFile: join(root, "mgr-resolutions.json"),
      },
    });
    try {
      const scope = h.manager.scope({
        owner: "a",
        sources: [
          h.source({
            s: {
              ...h.stdio({ tools: [tool("hi")] }),
              command: "npx",
              args: ["-y", "fake-mcp-pkg"],
            },
          }),
        ],
      });
      const outcome = await scope.connect("s");
      expect(outcome).toMatchObject({ ok: true });
      expect(h.starts()).toBe(1);
      expect(
        JSON.parse(await readFile(join(root, "mgr-resolutions.json"), "utf8"))
          .entries,
      ).toBeTypeOf("object");
    } finally {
      await cleanupAll();
    }
  });
});
