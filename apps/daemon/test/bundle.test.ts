/* eslint-disable no-template-curly-in-string -- `${NAME}` is the bundle format's own variable syntax */
/**
 * The bundle format: reading a directory, what a session is given from it (and which values go
 * where), and moving its files between machines.
 */
import { Buffer } from "node:buffer";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BundleError,
  bundleSkillDirs,
  BundleStore,
  checkValue,
  hashBundle,
  isConfigured,
  readBundle,
  snapshotBundle,
} from "../src/bundle";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "eta-bundle-"));
  dirs.push(dir);
  return dir;
};

/** A bundle directory from a map of path to text. */
function bundle(files: Record<string, string>): string {
  const dir = temp();
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return dir;
}

const PLUGIN = JSON.stringify({
  name: "demo",
  version: "1.0.0",
  description: "A demo",
  requires: ["node", "demo-cli"],
  targets: ["chat"],
  config: {
    type: "object",
    required: ["DEMO_KEY"],
    properties: {
      DEMO_KEY: {
        type: "string",
        title: "Key",
        writeOnly: true,
        maxLength: 20,
        minLength: 4,
      },
      DEMO_REGION: { type: "string", maxLength: 8, pattern: "^[a-z]+$" },
    },
  },
});

const FULL = {
  "plugin.json": PLUGIN,
  "mcp.json": JSON.stringify({
    mcpServers: {
      local: {
        command: "${PLUGIN_ROOT}/run",
        args: ["--region", "${DEMO_REGION}", "--cwd", "${ETA_WORKSPACE_DIR}"],
        env: { EXTRA: "x-${DEMO_REGION}" },
      },
      remote: {
        url: "${ETA_SERVICE_URL}/mcp",
        headers: { Authorization: "Bearer ${DEMO_KEY}" },
      },
    },
  }),
  "skills/demo/SKILL.md": "---\nname: demo\ndescription: d\n---\n# demo\n",
  "skills/demo/references/setup.md": "set up",
  "akhook.yml":
    "version: 1\nrules:\n  - id: r\n    on: prompt_submit\n    run:\n      argv: ['${PLUGIN_ROOT}/hook']\n",
};

describe("reading a bundle", () => {
  it("reads the manifest, the servers, the skills and the hooks", () => {
    const dir = bundle(FULL);
    const read = readBundle(dir);
    expect(read.manifest.name).toBe("demo");
    expect(read.manifest.requires).toEqual(["node", "demo-cli"]);
    expect(read.manifest.config.map((field) => field.name)).toEqual([
      "DEMO_KEY",
      "DEMO_REGION",
    ]);
    expect(read.manifest.config[0]).toMatchObject({
      secret: true,
      required: true,
      minLength: 4,
      maxLength: 20,
    });
    expect(read.manifest.config[1]!.secret).toBe(false);
    expect(Object.keys(read.mcp)).toEqual(["local", "remote"]);
    expect(read.skills).toEqual(["demo"]);
    expect(read.hooks).toContain("prompt_submit");
  });

  it("needs only a manifest", () => {
    const read = readBundle(bundle({ "plugin.json": '{"name":"bare"}' }));
    expect(read.manifest).toMatchObject({
      name: "bare",
      requires: [],
      config: [],
    });
    expect(read.mcp).toEqual({});
    expect(read.skills).toEqual([]);
    expect(read.hooks).toBeUndefined();
  });

  it.each([
    ["no manifest", { "mcp.json": "{}" }],
    ["a bad name", { "plugin.json": '{"name":"Bad Name"}' }],
    [
      "a reserved variable",
      {
        "plugin.json": JSON.stringify({
          name: "x",
          config: { type: "object", properties: { PATH: { type: "string" } } },
        }),
      },
    ],
    [
      "a property that is not a string",
      {
        "plugin.json": JSON.stringify({
          name: "x",
          config: { type: "object", properties: { A: { type: "number" } } },
        }),
      },
    ],
    [
      "a required field that is not declared",
      {
        "plugin.json": JSON.stringify({
          name: "x",
          config: { type: "object", required: ["A"], properties: {} },
        }),
      },
    ],
    [
      "a command with a slash",
      { "plugin.json": '{"name":"x","requires":["a/b"]}' },
    ],
    [
      "a server without a command or url",
      { "plugin.json": '{"name":"x"}', "mcp.json": '{"mcpServers":{"s":{}}}' },
    ],
    ["a manifest that is not JSON", { "plugin.json": "{" }],
  ])("refuses %s", (_, files) => {
    expect(() => readBundle(bundle(files))).toThrow(BundleError);
  });

  it("checks a value against its field and says nothing of the value", () => {
    const [key, region] = readBundle(bundle(FULL)).manifest.config;
    expect(() => checkValue(key!, "abc")).toThrow(/shorter/);
    expect(() => checkValue(key!, "x".repeat(21))).toThrow(/longer/);
    expect(() => checkValue(region!, "NOPE")).toThrow(/form/);
    expect(() => checkValue(region!, "nope")).not.toThrow();
    try {
      checkValue(region!, "SECRET-VALUE");
    } catch (error) {
      expect(String(error)).not.toContain("SECRET-VALUE");
    }
  });
});

describe("what a session is given", () => {
  const active = (config: Record<string, string>, serviceUrl?: string) => {
    const read = readBundle(bundle(FULL));
    return {
      bundle: read,
      config,
      configured: isConfigured(read.manifest, config),
      serviceUrl,
    };
  };

  it("is configured when every required value is there", () => {
    const read = readBundle(bundle(FULL));
    expect(isConfigured(read.manifest, {})).toBe(false);
    expect(isConfigured(read.manifest, { DEMO_REGION: "eu" })).toBe(false);
    expect(isConfigured(read.manifest, { DEMO_KEY: "abcd" })).toBe(true);
  });

  it("keeps its skills before the bundle is configured", () => {
    const a = active({});
    expect(bundleSkillDirs(a)).toEqual([join(a.bundle.dir, "skills")]);
  });
});

describe("moving a bundle's files", () => {
  it("snapshots, hashes and keeps them under their hash, executable bits and all", () => {
    const dir = bundle(FULL);
    writeFileSync(join(dir, "run"), "#!/bin/sh\n");
    chmodSync(join(dir, "run"), 0o755);
    const files = snapshotBundle(dir);
    expect(Object.keys(files)).toContain("skills/demo/references/setup.md");
    if (process.platform !== "win32") expect(files.run!.exec).toBe(true);
    const hash = hashBundle(files);
    expect(hashBundle(snapshotBundle(dir))).toBe(hash);

    const store = new BundleStore(join(temp(), "bundles"));
    expect(store.has(hash)).toBe(false);
    store.put(hash, files);
    expect(store.has(hash)).toBe(true);
    const copy = store.dir(hash);
    expect(readBundle(copy).manifest.name).toBe("demo");
    if (process.platform !== "win32")
      expect(statSync(join(copy, "run")).mode & 0o111).not.toBe(0);
    // Putting them again is nothing.
    store.put(hash, files);
  });

  it("changes the hash when a file does", () => {
    const dir = bundle(FULL);
    const before = hashBundle(snapshotBundle(dir));
    writeFileSync(join(dir, "skills/demo/references/setup.md"), "changed");
    expect(hashBundle(snapshotBundle(dir))).not.toBe(before);
  });

  it("refuses files that are not the contents the hash names, and paths that leave the bundle", () => {
    const store = new BundleStore(join(temp(), "bundles"));
    const files = snapshotBundle(bundle(FULL));
    expect(() => store.put("0".repeat(24), files)).toThrow(/hash/);
    const evil = { "../escape": { data: Buffer.from("x").toString("base64") } };
    expect(() => store.put(hashBundle(evil), evil)).toThrow(/outside/);
    expect(existsSync(join(store.dir("0".repeat(24)), ".."))).toBe(false);
  });

  it("refuses a bundle that is too big to send", () => {
    const dir = bundle({ "plugin.json": '{"name":"big"}' });
    writeFileSync(join(dir, "blob"), Buffer.alloc(3 * 1024 * 1024));
    expect(() => snapshotBundle(dir)).toThrow(/larger/);
  });
});
