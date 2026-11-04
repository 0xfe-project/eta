import type { Mock } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountModules, Realm } from "../../src/realm/index";
import {
  explainFailure,
  OSV_SCANNER,
  registryPackage,
} from "../../src/realm/install";

interface Scanned {
  name: string;
  version: string;
}
interface Query {
  package: { name: string; ecosystem: string };
  version: string;
  page_token?: string;
}
interface Scanner {
  scan: (input: { packages: Scanned[] }) => Promise<
    {
      level: string;
      package: string;
      url: string;
      description: string;
    }[]
  >;
}

let dir = "";
let root = "";
let log = "";
const saved = { PATH: process.env.PATH, HOME: process.env.HOME };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "install-test-"));
  root = join(dir, "root");
  log = join(dir, "bun.log");
  await mkdir(root);
  await mkdir(join(dir, "bin"));
  process.env.HOME = join(dir, "home");
  process.env.PATH = `${join(dir, "bin")}:${saved.PATH}`;
  process.env.FAKE_BUN_LOG = log;
});

afterEach(async () => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  delete process.env.FAKE_BUN_LOG;
  await rm(dir, { recursive: true, force: true });
});

/** A `bun` on PATH that answers `--version`, logs its arguments and runs `body`. */
async function fakeBun(body: string, version = "1.4.3"): Promise<void> {
  const path = join(dir, "bin", "bun");
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho "$*" >> "$FAKE_BUN_LOG"\n${body}\n`,
  );
  await chmod(path, 0o755);
}

/** Shell that leaves `name` in node_modules the way a finished install would. */
const placePackage = (name: string): string =>
  `mkdir -p node_modules/${name}
echo "{\\"name\\":\\"${name}\\",\\"main\\":\\"index.js\\"}" > node_modules/${name}/package.json
echo "export default \\"${name} ran\\";" > node_modules/${name}/index.js`;

function newRealm(): Realm {
  return new Realm({
    name: "test",
    mounts: (realm) => mountModules(realm, { root }),
  });
}

async function importIn(realm: Realm, specifier: string): Promise<unknown> {
  const result = await realm.evaluate(
    `import thing from ${JSON.stringify(specifier)};\nexport default thing;`,
    { identifier: join(root, "probe.js") },
  );
  return result.value;
}

const failureOf = (realm: Realm, specifier: string): Promise<Error> =>
  importIn(realm, specifier).then(
    (value) => {
      throw new Error(`loaded: ${String(value)}`);
    },
    (error: Error) => error,
  );

const calls = (): string[] =>
  existsSync(log)
    ? readFileSync(log, "utf8").trimEnd().split("\n").filter(Boolean)
    : [];

describe("the OSV scanner", () => {
  async function scannerWith(
    respond: (queries: Query[]) => Response | Promise<Response>,
  ): Promise<{ scanner: Scanner; fetch: Mock }> {
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      const { queries } = JSON.parse(init.body) as { queries: Query[] };
      return await respond(queries);
    });
    vi.stubGlobal("fetch", fetch);
    const path = join(dir, `scanner-${String(Math.random())}.mjs`);
    await writeFile(path, OSV_SCANNER);
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(path).href
    )) as {
      scanner: Scanner;
    };
    return { scanner: module.scanner, fetch };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const none = (queries: Query[]): Response =>
    Response.json({ results: queries.map(() => ({})) });

  it("a MAL record is a fatal advisory", async () => {
    const { scanner } = await scannerWith((queries) =>
      Response.json({
        results: queries.map(() => ({
          vulns: [{ id: "MAL-2025-32615", modified: "x" }],
        })),
      }),
    );
    expect(
      await scanner.scan({ packages: [{ name: "evil", version: "1.0.0" }] }),
    ).toEqual([
      {
        level: "fatal",
        package: "evil",
        url: "https://osv.dev/vulnerability/MAL-2025-32615",
        description: "MAL-2025-32615: known malware",
      },
    ]);
  });

  it("a plain advisory lets the package through", async () => {
    const { scanner } = await scannerWith((queries) =>
      Response.json({
        results: queries.map(() => ({
          vulns: [{ id: "GHSA-xvch-5gv4-984h", modified: "x" }],
        })),
      }),
    );
    expect(
      await scanner.scan({
        packages: [{ name: "minimist", version: "1.2.5" }],
      }),
    ).toEqual([]);
  });

  it("sends the name and version and nothing else", async () => {
    const { scanner, fetch } = await scannerWith(none);
    await scanner.scan({
      packages: [
        {
          name: "a",
          version: "1.0.0",
          tarball: "https://registry.example/a.tgz",
        } as Scanned,
      ],
    });
    const [url, init] = fetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("https://api.osv.dev/v1/querybatch");
    expect(JSON.parse(init.body)).toEqual({
      queries: [{ package: { name: "a", ecosystem: "npm" }, version: "1.0.0" }],
    });
  });

  it("asks once about a package seen twice", async () => {
    const { scanner, fetch } = await scannerWith(none);
    await scanner.scan({
      packages: [
        { name: "a", version: "1.0.0" },
        { name: "a", version: "1.0.0" },
        { name: "a", version: "2.0.0" },
      ],
    });
    const [, init] = fetch.mock.calls[0] as [string, { body: string }];
    expect(
      (JSON.parse(init.body) as { queries: Query[] }).queries.map(
        (query) => query.version,
      ),
    ).toEqual(["1.0.0", "2.0.0"]);
  });

  it("splits a long list at a thousand", async () => {
    const { scanner, fetch } = await scannerWith(none);
    await scanner.scan({
      packages: Array.from({ length: 2500 }, (_, i) => ({
        name: `p${String(i)}`,
        version: "1.0.0",
      })),
    });
    expect(
      fetch.mock.calls.map(
        ([, init]) =>
          (JSON.parse((init as { body: string }).body) as { queries: Query[] })
            .queries.length,
      ),
    ).toEqual([1000, 1000, 500]);
  });

  it("follows a page token to a MAL record on the next page", async () => {
    const { scanner, fetch } = await scannerWith((queries) =>
      Response.json({
        results: queries.map((query) =>
          query.package.name !== "busy"
            ? {}
            : query.page_token === "two"
              ? { vulns: [{ id: "MAL-2026-1" }] }
              : { vulns: [{ id: "GHSA-a" }], next_page_token: "two" },
        ),
      }),
    );
    const advisories = await scanner.scan({
      packages: [
        { name: "quiet", version: "1.0.0" },
        { name: "busy", version: "1.0.0" },
      ],
    });
    expect(advisories.map((advisory) => advisory.package)).toEqual(["busy"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an error status", () => new Response("no", { status: 503 })],
    ["a short answer", () => Response.json({ results: [] })],
    ["no results", () => Response.json({})],
    ["something not JSON", () => new Response("<html>")],
    ["a null result", () => Response.json({ results: [null] })],
  ])("throws on %s, so bun refuses the install", async (_name, answer) => {
    const { scanner } = await scannerWith(answer);
    await expect(
      scanner.scan({ packages: [{ name: "a", version: "1.0.0" }] }),
    ).rejects.toThrow();
  });

  it("throws when OSV cannot be reached", async () => {
    const { scanner } = await scannerWith(() => {
      throw new TypeError("Unable to connect");
    });
    await expect(
      scanner.scan({ packages: [{ name: "a", version: "1.0.0" }] }),
    ).rejects.toThrow("Unable to connect");
  });
});

describe("registryPackage", () => {
  it.each([
    ["left-pad", "left-pad", "left-pad", ""],
    ["left-pad@1.3.0", "left-pad", "left-pad@1.3.0", ""],
    ["left-pad@latest", "left-pad", "left-pad@latest", ""],
    ["lodash/fp", "lodash", "lodash", "fp"],
    ["lodash@4/fp/map", "lodash", "lodash@4", "fp/map"],
    ["@scope/name", "@scope/name", "@scope/name", ""],
    ["@scope/name@^1.2.0/sub", "@scope/name", "@scope/name@^1.2.0", "sub"],
    ["JSONStream", "JSONStream", "JSONStream", ""],
  ])("%s", (specifier, name, install, subpath) => {
    expect(registryPackage(specifier)).toEqual({ name, install, subpath });
  });

  it.each([
    "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
    "github:stevemao/left-pad",
    "git+ssh://git@github.com/a/b.git",
    "file:../evil",
    "x@npm:evil",
    "left-pad@github:a/b",
    "left-pad@file:../evil",
    "--config=/tmp/evil.toml",
    "-g",
    "bun:sqlite",
    "",
  ])("%s is not one", (specifier) => {
    expect(registryPackage(specifier)).toBeUndefined();
  });
});

describe("explainFailure", () => {
  // What bun 1.4.3 printed for each of these.
  const direct = `bun add v1.4.3 (c6da4a4d3)
Resolving dependencies
Resolved, downloaded and extracted [2]

  FATAL: safe-chain-test
    via  › safe-chain-test
    MAL-2025-32615: known malware
    https://osv.dev/vulnerability/MAL-2025-32615

1 advisory (1 fatal)
Installation aborted due to fatal security advisories
`;
  const transitive = direct.replace(
    "via  › safe-chain-test",
    "via  › wrap-demo › safe-chain-test",
  );

  it("names the package and the MAL id", () => {
    const refusal = explainFailure(direct);
    expect(refusal.status).toBe("blocked");
    expect(refusal.reason).toBe(
      "known malware: safe-chain-test (MAL-2025-32615)",
    );
    expect(refusal.advice).toContain("Do not install it another way");
  });

  it("says what pulled a dependency in", () => {
    expect(explainFailure(transitive).reason).toBe(
      "known malware: safe-chain-test (MAL-2025-32615) via wrap-demo › safe-chain-test",
    );
  });

  it("reads through colors", () => {
    expect(
      explainFailure(direct.replace("FATAL", "\u001B[31mFATAL\u001B[0m"))
        .reason,
    ).toContain("MAL-2025-32615");
  });

  it("a version under the age is too new, not missing", () => {
    const refusal = explainFailure(
      `error: No version matching "@anthropic-ai/sdk" found for specifier "1.4.0" (blocked by minimum-release-age: 259200 seconds)
error: @anthropic-ai/sdk@1.4.0 failed to resolve
`,
    );
    expect(refusal.status).toBe("blocked");
    expect(refusal.reason).toBe(
      "too new: no version of @anthropic-ai/sdk matching 1.4.0 has been published for 3 days",
    );
  });

  it("an unreachable OSV is the check failing, not the package", () => {
    const refusal = explainFailure(
      `error: Security scanner failed: ECONNREFUSED: Unable to connect. Is the computer able to access the url?
error: security scanner failed: ScannerFailed
`,
    );
    expect(refusal.status).toBe("blocked");
    expect(refusal.reason).toContain(
      "could not check against OSV (ECONNREFUSED",
    );
    expect(refusal.advice).toContain("nothing is known against this package");
  });

  it("a missing scanner file is the same refusal", () => {
    const refusal = explainFailure(
      `error: Security scanner '/x.mjs' is configured in bunfig.toml but the file could not be found.
error: security scanner failed: SecurityScannerNotInDependencies
`,
    );
    expect(refusal.status).toBe("blocked");
    expect(refusal.reason).toContain("could not check against OSV");
  });

  it("anything else is bun's own error", () => {
    const refusal = explainFailure(
      `Resolved, downloaded and extracted [1]
error: GET https://registry.npmjs.org/nope - 404
`,
    );
    expect(refusal.status).toBe("failed");
    expect(refusal.reason).toBe(
      "bun add failed: GET https://registry.npmjs.org/nope - 404",
    );
  });
});

describe("a bare import that installs", () => {
  it("hands bun the guard and a package name", async () => {
    await fakeBun(placePackage("good"));
    expect(await importIn(newRealm(), "good")).toBe("good ran");

    const guard = join(dir, "home", ".eta", "package-guard");
    expect(calls()).toEqual([
      `add --config=${join(guard, "bunfig.toml")} --minimum-release-age=259200 good`,
    ]);
    expect(readFileSync(join(guard, "osv-scanner.mjs"), "utf8")).toBe(
      OSV_SCANNER,
    );
    expect(readFileSync(join(guard, "bunfig.toml"), "utf8")).toContain(
      `scanner = ${JSON.stringify(join(guard, "osv-scanner.mjs"))}`,
    );
  });

  it("puts an edited scanner back before the next install", async () => {
    await fakeBun(placePackage("good"));
    await importIn(newRealm(), "good");
    const scanner = join(
      dir,
      "home",
      ".eta",
      "package-guard",
      "osv-scanner.mjs",
    );
    await writeFile(
      scanner,
      "export const scanner = { version: '1', scan: () => [] };",
    );

    await fakeBun(placePackage("other"));
    await importIn(newRealm(), "other");
    expect(readFileSync(scanner, "utf8")).toBe(OSV_SCANNER);
  });

  it("installs the package, not a GitHub repo, for a subpath", async () => {
    await fakeBun(
      `${placePackage("lodash")}\necho 'export default "fp ran";' > node_modules/lodash/fp.js`,
    );
    expect(await importIn(newRealm(), "lodash/fp")).toBe("fp ran");
    expect(calls()[0]?.endsWith(" lodash")).toBe(true);
  });

  it("loads a pinned import by its name and records what came in", async () => {
    await fakeBun(`${placePackage("good")}\necho 'installed good@1.2.0'`);
    const realm = newRealm();
    expect(await importIn(realm, "good@latest")).toBe("good ran");
    expect(calls()[0]?.endsWith(" good@latest")).toBe(true);
    expect(realm.effects[0]?.detail).toContain("good@1.2.0 into");
  });

  it("a URL never reaches bun", async () => {
    await fakeBun(placePackage("good"));
    const realm = newRealm();
    const error = await failureOf(realm, "github:evil/repo");
    expect(error.message).toContain("only npm package names");
    expect(calls()).toEqual([]);
    expect(realm.effects.map((effect) => effect.status)).toEqual(["blocked"]);
  });

  it("refuses a bun that would ignore the checks", async () => {
    await fakeBun(placePackage("good"), "1.2.23");
    const realm = newRealm();
    const error = await failureOf(realm, "good");
    expect(error.message).toContain("bun 1.2.23 ignores the security checks");
    expect(calls()).toEqual([]);
    expect(realm.effects.map((effect) => effect.status)).toEqual(["blocked"]);
  });

  it("says so when there is no bun at all", async () => {
    process.env.PATH = join(dir, "empty");
    const realm = newRealm();
    const error = await failureOf(realm, "good");
    expect(error.message).toContain("bun could not run");
    expect(realm.effects.map((effect) => effect.status)).toEqual(["failed"]);
  });

  it("the host keeps running while bun does", async () => {
    await fakeBun(`sleep 0.4\n${placePackage("good")}`);
    let ticks = 0;
    const clock = setInterval(() => {
      ticks += 1;
    }, 20);
    await importIn(newRealm(), "good");
    clearInterval(clock);
    expect(ticks).toBeGreaterThan(5);
  });

  it("imports that link together install one at a time", async () => {
    await fakeBun(
      `name=$(echo "$*" | awk '{print $NF}')
if [ -e "$FAKE_BUN_LOG.busy" ]; then echo overlap >> "$FAKE_BUN_LOG"; fi
touch "$FAKE_BUN_LOG.busy"
sleep 0.15
rm "$FAKE_BUN_LOG.busy"
${placePackage("$name")}`,
    );
    const result = await newRealm().evaluate(
      `import a from "one";\nimport b from "two";\nimport c from "one";\nexport default [a, b, c];`,
      { identifier: join(root, "probe.js") },
    );
    expect(result.value).toEqual(["one ran", "two ran", "one ran"]);
    expect(calls().filter((call) => call === "overlap")).toEqual([]);
    expect(calls()).toHaveLength(2);
  });
});

describe("a bare import that does not install", () => {
  const blockedOutput = `cat >&2 <<'OUT'

  FATAL: bad-dep
    via  › top › bad-dep
    MAL-2026-1: known malware
    https://osv.dev/vulnerability/MAL-2026-1

Installation aborted due to fatal security advisories
OUT
exit 1`;

  it("does not load what a failed install left behind, now or on the next import", async () => {
    await fakeBun(`${placePackage("top")}\n${blockedOutput}`);
    await writeFile(join(root, "package.json"), `{"name":"mine"}`);

    const realm = newRealm();
    const first = await failureOf(realm, "top");
    expect(first.message).toContain("MAL-2026-1");
    expect(existsSync(join(root, "node_modules", "top"))).toBe(false);

    const second = await failureOf(newRealm(), "top");
    expect(second.message).toContain("MAL-2026-1");
    expect(calls()).toHaveLength(2);
  });

  it("a failed install puts the directory back", async () => {
    await fakeBun(placePackage("kept"));
    await importIn(newRealm(), "kept");
    await writeFile(join(root, "package.json"), `{"name":"mine"}\n`);
    await writeFile(join(root, "bun.lock"), `{}\n`);

    await fakeBun(
      `${placePackage("@scope/top")}
echo '{"name":"changed"}' > package.json
echo changed > bun.lock
mkdir -p node_modules/.bin; touch node_modules/.bin/top
${blockedOutput}`,
    );
    await failureOf(newRealm(), "@scope/top");

    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(
      `{"name":"mine"}\n`,
    );
    expect(readFileSync(join(root, "bun.lock"), "utf8")).toBe(`{}\n`);
    expect(existsSync(join(root, "node_modules", "@scope", "top"))).toBe(false);
    expect(existsSync(join(root, "node_modules", ".bin", "top"))).toBe(false);
    expect(existsSync(join(root, "node_modules", "kept"))).toBe(true);
  });

  it("a package.json bun made for a failed install goes too", async () => {
    await fakeBun(
      `echo '{"dependencies":{}}' > package.json\n${blockedOutput}`,
    );
    await failureOf(newRealm(), "top");
    expect(existsSync(join(root, "package.json"))).toBe(false);
  });

  it("an exit that is not 0 is a failure even with the package in place", async () => {
    await fakeBun(`${placePackage("good")}\nexit 3`);
    const realm = newRealm();
    await failureOf(realm, "good");
    expect(realm.effects.map((effect) => effect.status)).toEqual(["failed"]);
  });

  it("malware lands in the ledger as blocked, with the reason", async () => {
    await fakeBun(blockedOutput);
    const realm = newRealm();
    const error = await failureOf(realm, "top");
    expect(error.message).toContain(
      'cannot import "top": known malware: bad-dep (MAL-2026-1) via top › bad-dep',
    );
    expect(error.message).not.toContain("not mounted");
    expect(realm.effects).toHaveLength(1);
    expect(realm.effects[0]).toMatchObject({
      name: "packages.install",
      status: "blocked",
    });
    expect(realm.effects[0]?.detail).toContain("MAL-2026-1");
  });

  it("a process killed by a signal is a failure, not a success", async () => {
    await fakeBun(`${placePackage("good")}\nkill -TERM $$`);
    const realm = newRealm();
    const error = await failureOf(realm, "good");
    expect(error.message).toContain("did not finish");
    expect(existsSync(join(root, "node_modules", "good"))).toBe(false);
  });

  it("a package with nothing to load says so", async () => {
    await fakeBun(
      `mkdir -p node_modules/empty\necho '{}' > node_modules/empty/package.json`,
    );
    const error = await failureOf(newRealm(), "empty");
    expect(error.message).toContain("no such entry");
  });
});
