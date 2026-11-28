import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  defaultClientTestJobs,
  isCiEnvironment,
  resolveNshClientArgs,
} from "../nsh-client-args";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
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
      while (i < text.length && text[i] !== "\n") i += 1;
      if (i < text.length) out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        i += 1;
      }
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

describe("nsh-client argument resolution", () => {
  it("treats unset, empty, 0, and false CI values as local", () => {
    for (const env of [
      {},
      { CI: "" },
      { CI: "   " },
      { CI: "0" },
      { CI: "false" },
      { CI: "FALSE" },
    ]) {
      expect(isCiEnvironment(env)).toBe(false);
      expect(defaultClientTestJobs(env)).toBe(2);
      expect(resolveNshClientArgs(["test"], env)).toEqual(["test", "-j", "2"]);
    }
  });

  it("defaults to -j 1 when CI is truthy", () => {
    for (const env of [{ CI: "1" }, { CI: "true" }, { CI: "TRUE" }]) {
      expect(isCiEnvironment(env)).toBe(true);
      expect(defaultClientTestJobs(env)).toBe(1);
      expect(resolveNshClientArgs(["test"], env)).toEqual(["test", "-j", "1"]);
    }
  });

  it("places the default -j flag immediately after test, before paths and --", () => {
    expect(
      resolveNshClientArgs(["test", "test/add-source.test.tsx"], { CI: "1" }),
    ).toEqual(["test", "-j", "1", "test/add-source.test.tsx"]);

    expect(
      resolveNshClientArgs(["test", "--", "test/add-source.test.tsx"], {
        CI: "1",
      }),
    ).toEqual(["test", "-j", "1", "--", "test/add-source.test.tsx"]);
  });

  it("respects explicit -j and --jobs flags in both CI and local environments", () => {
    for (const args of [
      ["test", "-j", "4"],
      ["test", "-j4"],
      ["test", "--jobs", "3"],
      ["test", "--jobs=3"],
    ]) {
      expect(resolveNshClientArgs(args, { CI: "1" })).toEqual(args);
      expect(resolveNshClientArgs(args, {})).toEqual(args);
    }

    expect(resolveNshClientArgs(["test", "-j", "2"], { CI: "1" })).toEqual([
      "test",
      "-j",
      "2",
    ]);
    expect(resolveNshClientArgs(["test", "-j", "1"], {})).toEqual([
      "test",
      "-j",
      "1",
    ]);
  });

  it("does not inject -j for test help invocations", () => {
    for (const args of [
      ["test", "--help"],
      ["test", "-h"],
    ]) {
      expect(resolveNshClientArgs(args, { CI: "1" })).toEqual(args);
      expect(resolveNshClientArgs(args, {})).toEqual(args);
    }
  });

  it("passes non-test subcommands through unchanged in both local and CI environments", () => {
    for (const args of [
      ["check"],
      ["package", "App.tsx", "--target", "web"],
      ["run", "App.tsx"],
      ["update-manifest"],
    ]) {
      expect(resolveNshClientArgs(args, { CI: "1" })).toEqual(args);
      expect(resolveNshClientArgs(args, {})).toEqual(args);
    }
  });

  it("wires CI passthrough and nsh-client-args.ts inputs in apps/client/turbo.json", () => {
    const turbo = JSON.parse(
      stripJsonComments(
        readFileSync(join(root, "apps", "client", "turbo.json"), "utf8"),
      ),
    ) as {
      tasks: {
        typecheck: { inputs?: string[] };
        test: { inputs?: string[]; passThroughEnv?: string[] };
      };
    };

    expect(turbo.tasks.test.passThroughEnv).toContain("CI");
    expect(turbo.tasks.typecheck.inputs).toContain(
      "$TURBO_ROOT$/scripts/nsh-client-args.ts",
    );
    expect(turbo.tasks.test.inputs).toContain(
      "$TURBO_ROOT$/scripts/nsh-client-args.ts",
    );
  });

  // Static source assertion rather than spawning `scripts/nsh-client.ts`: the
  // entrypoint spawns the real `nsh` binary and unconditionally writes staged
  // assets and icons into `apps/client/assets/` and `apps/client/.nsh/icons/`.
  it("wires scripts/nsh-client.ts through resolveNshClientArgs into run(nsh, command)", () => {
    const source = readFileSync(join(root, "scripts", "nsh-client.ts"), "utf8");

    expect(source).toMatch(
      /import\s*\{[^}]*\bresolveNshClientArgs\b[^}]*\}\s*from\s*["']\.\/nsh-client-args["']/,
    );
    expect(source).toMatch(
      /const\s+args\s*=\s*resolveNshClientArgs\(\s*process\.argv\.slice\(2\)\s*,\s*process\.env(?:\s*,)?\s*\)/,
    );
    expect(source).toMatch(
      /(?:const|let)\s+command\s*=[^;]*\bargs\b[^;]*;[\s\S]*await\s+run\(\s*nsh\s*,\s*command\s*\)/,
    );
  });
});
