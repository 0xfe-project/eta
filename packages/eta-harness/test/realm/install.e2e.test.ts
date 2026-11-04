/**
 * The install guard against real bun, npm and OSV. Needs the network, so it only
 * runs when asked:
 *
 *   ETA_INSTALL_E2E=1 NODE_OPTIONS=--experimental-vm-modules bunx vitest --run test/realm/install.e2e.test.ts
 *
 * `safe-chain-test@0.0.1-security` is an npm placeholder with no code in it,
 * listed in OSV as MAL-2025-32615.
 */
import type { Server } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountModules, Realm } from "../../src/realm/index";

const TIMEOUT_MS = 120_000;

describe.skipIf(process.env.ETA_INSTALL_E2E === undefined)(
  "the install guard, for real",
  () => {
    let dir = "";
    let root = "";
    const saved = { ...process.env };

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "install-e2e-"));
      root = join(dir, "root");
      await mkdir(root);
      // Bun's cache stays the machine's: only the guard's directory moves.
      process.env.BUN_INSTALL_CACHE_DIR ??= join(
        process.env.HOME ?? "",
        ".bun",
        "install",
        "cache",
      );
      process.env.HOME = join(dir, "home");
    });

    afterEach(async () => {
      for (const key of Object.keys(process.env))
        if (!(key in saved)) process.env[key] = undefined;
      Object.assign(process.env, saved);
      await rm(dir, { recursive: true, force: true });
    });

    const newRealm = (): Realm =>
      new Realm({
        name: "e2e",
        mounts: (realm) => mountModules(realm, { root }),
      });

    const load = (realm: Realm, specifier: string): Promise<unknown> =>
      realm
        .evaluate(
          `const m = await import(${JSON.stringify(specifier)});\nexport default m.default;`,
          { identifier: join(root, "probe.js"), timeoutMs: TIMEOUT_MS },
        )
        .then((result) => result.value);

    const refusalOf = async (
      realm: Realm,
      specifier: string,
    ): Promise<string> =>
      await load(realm, specifier).then(
        () => "loaded",
        (error: Error) => error.message,
      );

    /**
     * A registry that serves one local package depending on the malware and
     * sends everything else on to npm.
     */
    async function wrapperRegistry(): Promise<{ url: string; server: Server }> {
      const staged = join(dir, "stage", "package");
      await mkdir(staged, { recursive: true });
      const manifest = {
        name: "wrap-demo",
        version: "1.0.0",
        main: "index.js",
        dependencies: { "safe-chain-test": "0.0.1-security" },
      };
      await writeFile(join(staged, "package.json"), JSON.stringify(manifest));
      await writeFile(join(staged, "index.js"), `export default "wrap-demo";`);
      const tgz = join(dir, "wrap-demo.tgz");
      spawnSync("tar", ["-C", join(dir, "stage"), "-czf", tgz, "package"]);
      const tarball = await readFile(tgz);

      const server = createServer((request, response) => {
        const address = server.address() as { port: number };
        const path = request.url ?? "/";
        if (path === "/wrap-demo") {
          const old = "2020-01-01T00:00:00.000Z";
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              name: "wrap-demo",
              "dist-tags": { latest: "1.0.0" },
              time: { created: old, modified: old, "1.0.0": old },
              versions: {
                "1.0.0": {
                  ...manifest,
                  dist: {
                    tarball: `http://127.0.0.1:${String(address.port)}/wrap-demo.tgz`,
                    shasum: createHash("sha1").update(tarball).digest("hex"),
                  },
                },
              },
            }),
          );
          return;
        }
        if (path === "/wrap-demo.tgz") {
          response.end(tarball);
          return;
        }
        void fetch(`https://registry.npmjs.org${path}`).then(
          async (upstream) => {
            response.statusCode = upstream.status;
            response.setHeader("content-type", "application/json");
            response.end(new Uint8Array(await upstream.arrayBuffer()));
          },
        );
      });
      await new Promise<void>((listening) => {
        server.listen(0, "127.0.0.1", listening);
      });
      const { port } = server.address() as { port: number };
      return { url: `http://127.0.0.1:${String(port)}/`, server };
    }

    it(
      "refuses a known malicious package and names the record",
      async () => {
        const realm = newRealm();
        const message = await refusalOf(realm, "safe-chain-test");
        expect(message).toContain("MAL-2025-32615");
        expect(message).not.toContain("not mounted");
        expect(realm.effects.at(-1)).toMatchObject({
          name: "packages.install",
          status: "blocked",
        });
        expect(existsSync(join(root, "node_modules", "safe-chain-test"))).toBe(
          false,
        );
      },
      TIMEOUT_MS,
    );

    it(
      "refuses it just the same with the package already in bun's cache",
      async () => {
        const warm = join(dir, "warm");
        await mkdir(warm);
        spawnSync("bun", ["add", "safe-chain-test"], { cwd: warm });
        const message = await refusalOf(newRealm(), "safe-chain-test");
        expect(message).toContain("MAL-2025-32615");
        expect(existsSync(join(root, "node_modules", "safe-chain-test"))).toBe(
          false,
        );
      },
      TIMEOUT_MS,
    );

    it(
      "refuses it as a dependency, and again on the next import",
      async () => {
        const { url, server } = await wrapperRegistry();
        process.env.BUN_CONFIG_REGISTRY = url;
        try {
          for (const realm of [newRealm(), newRealm()]) {
            const message = await refusalOf(realm, "wrap-demo");
            expect(message).toContain("MAL-2025-32615");
            expect(message).toContain("via wrap-demo");
            expect(existsSync(join(root, "node_modules", "wrap-demo"))).toBe(
              false,
            );
          }
        } finally {
          server.close();
        }
      },
      TIMEOUT_MS,
    );

    it(
      "installs an ordinary package and loads it",
      async () => {
        const realm = newRealm();
        expect(await refusalOf(realm, "yocto-queue")).toBe("loaded");
        expect(realm.effects.at(-1)?.status).toBe("ok");
      },
      TIMEOUT_MS,
    );

    // Checked by the ledger: the realm cannot load CommonJS yet, so `left-pad`
    // and `minimist` get past the guard and then stop at `load`.
    it.each(["left-pad", "minimist@1.2.5"])(
      "lets %s through",
      async (specifier) => {
        const realm = newRealm();
        await refusalOf(realm, specifier);
        expect(realm.effects.at(-1)).toMatchObject({
          name: "packages.install",
          status: "ok",
        });
      },
      TIMEOUT_MS,
    );

    it(
      "refuses when OSV cannot be reached",
      async () => {
        const { url, server } = await wrapperRegistry();
        process.env.BUN_CONFIG_REGISTRY = url;
        // The registry is plain http and local, so only the scanner's https goes this way.
        process.env.HTTPS_PROXY = "http://127.0.0.1:9";
        process.env.https_proxy = "http://127.0.0.1:9";
        try {
          const realm = newRealm();
          const message = await refusalOf(realm, "left-pad");
          expect(message).toContain("could not check against OSV");
          expect(realm.effects.at(-1)?.status).toBe("blocked");
          expect(existsSync(join(root, "node_modules", "left-pad"))).toBe(
            false,
          );
        } finally {
          server.close();
        }
      },
      TIMEOUT_MS,
    );
  },
);
