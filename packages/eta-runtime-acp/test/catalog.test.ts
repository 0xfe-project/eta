/**
 * What a look at an agent leaves behind. The look runs the agent in a scratch directory and removes
 * it after; what these pin: a directory that cannot be removed does not change the answer or lose
 * it, and on Windows no process of the agent's tree outlives the look.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpRuntimes } from "../src/index";
import { configFile, fakeAgent, until } from "./support";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const { rmSync: removeForReal } =
  await vi.importActual<typeof import("node:fs")>("node:fs");

const LAUNCHER = fileURLToPath(new URL("./tree-launcher.ts", import.meta.url));

afterEach(() => {
  vi.mocked(rmSync).mockImplementation(removeForReal);
});

const started = (agent: ReturnType<typeof fakeAgent>) =>
  agent.log().filter((entry) => entry.method === "started");

describe("a scratch directory that cannot be removed", () => {
  it("still lists the agent as it is, and keeps the answer", async () => {
    const stuck: string[] = [];
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (!String(path).includes("eta-acp-probe-"))
        return removeForReal(path, options);
      stuck.push(String(path));
      throw Object.assign(
        new Error(`EBUSY: resource busy or locked, rm '${String(path)}'`),
        { code: "EBUSY" },
      );
    });
    const agent = fakeAgent("good");
    const warnings: string[] = [];
    const runtimes = createAcpRuntimes({
      configPath: configFile([agent.config]),
      warn: (message) => warnings.push(message),
    });
    try {
      const list = await runtimes.catalog.list();
      expect(list.map((info) => [info.id, info.status, info.version])).toEqual([
        ["acp.good", "available", "0.0.1"],
      ]);
      expect(list[0]!.models.map((model) => model.id)).toEqual([
        "model-a",
        "model-b",
      ]);
      expect(stuck).toHaveLength(1);
      expect(warnings.length).toBeLessThanOrEqual(1);
      // Kept: a second listing starts no process.
      await runtimes.catalog.list();
      expect(started(agent)).toHaveLength(1);
      expect(runtimes.catalog.stale()).toBe(false);
    } finally {
      for (const path of stuck)
        removeForReal(path, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(process.platform !== "win32")(
  "an agent that has a child holding the directory",
  () => {
    it("is listed, and nothing of its tree is left alive", async () => {
      const agent = fakeAgent("tree", { args: [LAUNCHER] });
      const warnings: string[] = [];
      const runtimes = createAcpRuntimes({
        configPath: configFile([agent.config]),
        warn: (message) => warnings.push(message),
      });
      const holder = (): number =>
        Number(readFileSync(join(agent.dir, "holder.pid"), "utf8"));
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      try {
        const list = await runtimes.catalog.list();
        expect(warnings).toEqual([]);
        expect(list.map((info) => [info.id, info.status])).toEqual([
          ["acp.tree", "available"],
        ]);
        const pid = holder();
        await until(() => !alive(pid), "the agent's child to be gone", 5_000);
      } finally {
        // Whatever is left of it, so a failure here does not leave processes running.
        const left = (() => {
          try {
            return holder();
          } catch {
            return undefined;
          }
        })();
        if (left !== undefined)
          spawnSync("taskkill", ["/pid", String(left), "/T", "/F"]);
        const where = started(agent)[0]?.cwd;
        if (typeof where === "string")
          removeForReal(where, { recursive: true, force: true });
      }
    }, 30_000);
  },
);
