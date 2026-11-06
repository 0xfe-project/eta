/**
 * The notices a compiled host carries: which packages make the list, on a small install laid out the
 * way bun lays one out, and the real repository.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { thirdPartyNotices, thirdPartyPackages } from "../scripts/notices";
import { tempDir } from "./support/host";

const REPOSITORY = resolve(import.meta.dirname, "../../..");

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A package in bun's store, linked from `from`'s node_modules. */
function installed(
  root: string,
  from: string,
  name: string,
  manifest: object,
): string {
  const store = join(root, "node_modules/.bun", `${name}@1`, "node_modules");
  const dir = join(store, name);
  write(
    dir,
    "package.json",
    JSON.stringify({ name, version: "1.0.0", ...manifest }),
  );
  mkdirSync(join(from, "node_modules"), { recursive: true });
  symlinkSync(dir, join(from, "node_modules", name));
  return store;
}

describe("thirdPartyPackages", () => {
  it("follows run-time dependencies through links, and leaves the rest out", async () => {
    const root = await tempDir("eta-notices-");
    const app = join(root, "apps/app");
    write(
      root,
      "apps/app/package.json",
      JSON.stringify({
        name: "@eta/app",
        dependencies: { direct: "1", "@eta/lib": "*" },
        optionalDependencies: { absent: "1" },
        devDependencies: { dev: "1" },
      }),
    );
    write(root, "packages/lib/package.json", '{"name":"@eta/lib"}');
    mkdirSync(join(app, "node_modules/@eta"), { recursive: true });
    symlinkSync(join(root, "packages/lib"), join(app, "node_modules/@eta/lib"));

    const store = installed(root, app, "direct", {
      license: { type: "ISC" },
      dependencies: { transitive: "1" },
      peerDependencies: { wanted: "1", spare: "1" },
      peerDependenciesMeta: { spare: { optional: true } },
    });
    installed(root, store, "transitive", { license: "AGPL-3.0-or-later" });
    installed(root, store, "wanted", {});
    installed(root, store, "spare", {});
    installed(root, app, "dev", { license: "MIT" });
    write(store, "direct/LICENSE", "the license\n");
    write(store, "direct/THIRD-PARTY-NOTICES.md", "the source\n");
    write(store, "direct/README.md", "not this\n");

    const packages = thirdPartyPackages(root, ["apps/app"]);

    expect(packages.map((pkg) => [pkg.name, pkg.license])).toEqual([
      ["direct", "ISC"],
      ["transitive", "AGPL-3.0-or-later"],
      ["wanted", "not stated"],
    ]);
    expect(packages[0]?.texts).toEqual([
      ["LICENSE", "the license"],
      ["THIRD-PARTY-NOTICES.md", "the source"],
    ]);
  });
});

describe("thirdPartyNotices", () => {
  it("names what this repository's build carries", () => {
    const notices = thirdPartyNotices(REPOSITORY);

    expect(notices).toContain("## Eta Sans (font)");
    expect(notices).toContain("## npm packages in this build");
    expect(notices).toContain("### @botiverse/oar ");
  });

  // The other platforms' prebuilt SearXNG is optional, and some have none.
  it.runIf(process.platform === "linux" && process.arch === "x64")(
    "names the AGPL program and where its source is",
    () => {
      const notices = thirdPartyNotices(REPOSITORY);

      expect(notices).toMatch(/### @searxng-js\/\S+ \S+\n\nLicense: AGPL/);
      expect(notices).toContain("https://github.com/searxng/searxng/tree/");
    },
  );
});
