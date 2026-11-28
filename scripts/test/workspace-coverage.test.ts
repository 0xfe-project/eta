import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");

const NON_WORKSPACE_DIRS: Record<string, string> = {
  "packages/TOBEREFR": "Parked pre-ESM plugins; see packages/TOBEREFR/TODO.md",
};

const REQUIRED_SCRIPTS = ["typecheck", "lint", "test"] as const;
type RequiredScript = (typeof REQUIRED_SCRIPTS)[number];

const SCRIPT_EXEMPTIONS: Record<RequiredScript, Record<string, string>> = {
  typecheck: {},
  lint: {},
  test: {
    "packages/eta-plugin-sdk":
      "Type-only contract definitions (no runtime exports); verified by typecheck",
  },
};

const ESLINT_EXEMPTIONS: Record<string, string> = {};

const CANONICAL_TURBO_TASKS = [
  "build",
  "typecheck",
  "lint",
  "//#lint:repo",
  "//#typecheck:scripts",
  "test",
  "//#test:scripts",
  "//#knip",
] as const;

const IGNORED_DIRS = new Set([
  ".git",
  ".nsh",
  ".turbo",
  ".venv",
  "dist",
  "fixtures",
  "node_modules",
  "out",
]);

const TEST_FILE_PATTERN = /\.(?:test|spec)\.[^.]+$|^test_.*\.py$|_test\.py$/;
const TS_FILE_PATTERN = /\.(?:ts|tsx|mts|cts)$/;

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

function walkFiles(
  dir: string,
  predicate: (rel: string) => boolean,
  prefix = "",
): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const nextRel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (NON_WORKSPACE_DIRS[nextRel]) continue;
      found.push(...walkFiles(join(dir, entry.name), predicate, nextRel));
    } else if (entry.isFile()) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (predicate(rel)) found.push(rel);
    }
  }
  return found;
}

function listWorkspaces(): Array<{
  dir: string;
  pkg: PackageJson;
}> {
  const workspaces: Array<{ dir: string; pkg: PackageJson }> = [];
  for (const parent of ["apps", "packages"] as const) {
    const parentAbs = join(ROOT, parent);
    for (const entry of readdirSync(parentAbs, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory()) continue;
      const rel = `${parent}/${entry.name}`;
      const pkgPath = join(parentAbs, entry.name, "package.json");
      if (!existsSync(pkgPath)) continue;
      workspaces.push({ dir: rel, pkg: readJson<PackageJson>(pkgPath) });
    }
  }
  return workspaces;
}

function extractTurboCommandTasks(command: string): string[] {
  for (const segment of command.split("&&")) {
    const tokens = segment.trim().split(/\s+/);
    if (tokens[0] === "turbo" && tokens[1] === "run") {
      return tokens
        .slice(2)
        .filter((token) => token.length > 0 && !token.startsWith("-"));
    }
  }
  return [];
}

describe("workspace check coverage contract", () => {
  it("tracks all non-workspace directories under apps/ and packages/ without stale exemptions", () => {
    const missingPkg: string[] = [];
    for (const parent of ["apps", "packages"] as const) {
      for (const entry of readdirSync(join(ROOT, parent), {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory()) continue;
        const rel = `${parent}/${entry.name}`;
        if (!existsSync(join(ROOT, parent, entry.name, "package.json"))) {
          missingPkg.push(rel);
        }
      }
    }

    for (const dir of missingPkg) {
      expect(NON_WORKSPACE_DIRS[dir]?.trim().length ?? 0).toBeGreaterThan(0);
    }
    for (const [dir, reason] of Object.entries(NON_WORKSPACE_DIRS)) {
      expect(reason.trim().length).toBeGreaterThan(0);
      expect(existsSync(join(ROOT, dir))).toBe(true);
      expect(existsSync(join(ROOT, dir, "package.json"))).toBe(false);
    }
  });

  it("ensures every workspace has typecheck, lint, and test (or a non-stale documented exemption)", () => {
    const workspaces = listWorkspaces();
    const byDir = new Map(workspaces.map((w) => [w.dir, w.pkg]));

    for (const { dir, pkg } of workspaces) {
      const scripts = pkg.scripts ?? {};
      for (const script of REQUIRED_SCRIPTS) {
        if (!scripts[script]) {
          const reason = SCRIPT_EXEMPTIONS[script][dir];
          expect(
            reason?.trim().length ?? 0,
            `${dir} (${pkg.name ?? "unnamed"}) is missing scripts.${script} without an exemption`,
          ).toBeGreaterThan(0);
        }
      }
    }

    for (const script of REQUIRED_SCRIPTS) {
      for (const [dir, reason] of Object.entries(SCRIPT_EXEMPTIONS[script])) {
        expect(reason.trim().length).toBeGreaterThan(0);
        const pkg = byDir.get(dir);
        expect(
          pkg,
          `stale ${script} exemption for missing workspace ${dir}`,
        ).toBeDefined();
        expect(
          pkg?.scripts?.[script],
          `stale ${script} exemption for ${dir}: script now exists`,
        ).toBeUndefined();
      }
    }

    expect(
      walkFiles(
        join(ROOT, "packages/eta-plugin-sdk"),
        (rel) => TEST_FILE_PATTERN.test(basename(rel)),
        "packages/eta-plugin-sdk",
      ),
    ).toEqual([]);
  });

  it("ensures every TypeScript workspace runs eslint in its lint script", () => {
    const workspaces = listWorkspaces();
    const byDir = new Map(workspaces.map((w) => [w.dir, w.pkg]));

    for (const { dir, pkg } of workspaces) {
      const absDir = join(ROOT, dir);
      const isTs =
        existsSync(join(absDir, "tsconfig.json")) ||
        walkFiles(absDir, (rel) => TS_FILE_PATTERN.test(rel), dir).length > 0;
      if (!isTs) continue;
      const lint = pkg.scripts?.lint ?? "";
      if (!/\beslint\b/.test(lint)) {
        const reason = ESLINT_EXEMPTIONS[dir];
        expect(
          reason?.trim().length ?? 0,
          `${dir} is TypeScript but scripts.lint (${JSON.stringify(lint)}) skips eslint`,
        ).toBeGreaterThan(0);
      }
    }

    for (const [dir, reason] of Object.entries(ESLINT_EXEMPTIONS)) {
      expect(reason.trim().length).toBeGreaterThan(0);
      const pkg = byDir.get(dir);
      expect(pkg).toBeDefined();
      expect(/\beslint\b/.test(pkg?.scripts?.lint ?? "")).toBe(false);
    }
  });

  it("ensures every test directory under apps/, packages/, and scripts/ is executed by Turbo", () => {
    const workspaces = new Map(listWorkspaces().map((w) => [w.dir, w.pkg]));

    for (const parent of ["apps", "packages"] as const) {
      const testFiles = walkFiles(
        join(ROOT, parent),
        (rel) => TEST_FILE_PATTERN.test(basename(rel)),
        parent,
      );
      expect(testFiles.length).toBeGreaterThan(0);
      for (const file of testFiles) {
        const wsDir = file.split("/").slice(0, 2).join("/");
        const pkg = workspaces.get(wsDir);
        expect(
          pkg?.scripts?.test,
          `test file ${file} belongs to ${wsDir} which lacks scripts.test`,
        ).toBeTruthy();
      }
    }

    const scriptTests = walkFiles(
      join(ROOT, "scripts"),
      (rel) => TEST_FILE_PATTERN.test(basename(rel)),
      "scripts",
    );
    expect(scriptTests.length).toBeGreaterThan(0);

    const rootPkg = readJson<PackageJson>(join(ROOT, "package.json"));
    const testScriptsCmd = rootPkg.scripts?.["test:scripts"] ?? "";
    expect(testScriptsCmd).toMatch(/\bvitest\b/);
    expect(testScriptsCmd).toMatch(/\bscripts\b/);
  });

  it("keeps turbo.json, root package.json, and ci.yml in sync on the canonical task list", () => {
    const turbo = JSON.parse(
      stripJsonComments(readFileSync(join(ROOT, "turbo.json"), "utf8")),
    ) as { tasks?: Record<string, unknown> };
    const rootPkg = readJson<PackageJson>(join(ROOT, "package.json"));
    const ci = Bun.YAML.parse(
      readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
    ) as { env?: { TURBO_TASKS?: string } };

    for (const task of CANONICAL_TURBO_TASKS) {
      expect(
        turbo.tasks?.[task],
        `turbo.json missing task ${task}`,
      ).toBeDefined();
    }

    const expectedSorted = [...CANONICAL_TURBO_TASKS].sort();
    const checkTasks = extractTurboCommandTasks(rootPkg.scripts?.check ?? "");
    const affectedTasks = extractTurboCommandTasks(
      rootPkg.scripts?.["check:affected"] ?? "",
    );
    const ciTasks = (ci.env?.TURBO_TASKS ?? "").trim().split(/\s+/);

    expect([...checkTasks].sort()).toEqual(expectedSorted);
    expect([...affectedTasks].sort()).toEqual(expectedSorted);
    expect([...ciTasks].sort()).toEqual(expectedSorted);
    expect(new Set(ciTasks).size).toBe(ciTasks.length);
  });
});
