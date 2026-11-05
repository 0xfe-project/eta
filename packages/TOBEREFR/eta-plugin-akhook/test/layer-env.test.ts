/**
 * A host layer that brings its own variables and rule id prefix: the environment of its rules'
 * commands, and nobody else's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { lifecycleHooks } from "../src/session";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const cwd = () => {
  const dir = mkdtempSync(join(tmpdir(), "akhook-layer-"));
  dirs.push(dir);
  return dir;
};

const TEXT = `version: 1
rules:
  - id: recall
    on: prompt_submit
    run:
      argv: [sh, -c, 'printf "{\\"context\\": \\"%s|%s\\"}" "$LAYER_SECRET" "$ALSO"']
`;

describe("a layer with env and an id prefix", () => {
  it("prefixes the ids and puts the env on the commands of its rules", () => {
    const loaded = loadConfig({
      cwd: cwd(),
      project: false,
      userConfigPath: join(cwd(), "none.yml"),
      additional: [
        {
          name: "layer:x",
          text: TEXT,
          env: { LAYER_SECRET: "s" },
          idPrefix: "x/",
        },
      ],
    });
    expect(loaded.rules.map((rule) => rule.id)).toEqual(["x/recall"]);
    expect(loaded.rules[0]!.run!.env).toEqual({ LAYER_SECRET: "s" });
  });

  it("runs the command with the variables, and only that layer's commands get them", async () => {
    const dir = cwd();
    const hooks = lifecycleHooks({
      userConfigPath: join(dir, "none.yml"),
      fallbackRoot: dir,
    });
    const withEnv = await hooks.beforeRun(
      {
        cwd: dir,
        extra: [
          {
            name: "a",
            text: TEXT,
            env: { LAYER_SECRET: "hush", ALSO: "yes" },
          },
        ],
      },
      "hi",
    );
    expect(withEnv).toBe("hush|yes");
    // Another layer of the same text, without the variables: it sees nothing of them.
    const without = await hooks.beforeRun(
      { cwd: dir, extra: [{ name: "b", text: TEXT }] },
      "hi",
    );
    expect(without).toBe("|");
  });
});
