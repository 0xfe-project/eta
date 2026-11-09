/**
 * The keeper of git's and gh's GitHub login on a machine: what it writes, what it sets for the
 * sessions' shells, and what it does when GitHub is disconnected or the primary cannot be asked.
 */
import type { GitHubCredentials } from "@eta/client-contracts";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubKeeper } from "../src/github";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function keeper(answers: (GitHubCredentials | null | undefined)[]) {
  const dir = await mkdtemp(join(tmpdir(), "eta-keeper-"));
  dirs.push(dir);
  const github = join(dir, "github");
  const asks: number[] = [];
  const now = 1_000_000_000_000;
  const made = new GitHubKeeper({
    dir: github,
    now: () => now,
    credentials: async () => {
      asks.push(asks.length);
      return answers[Math.min(asks.length - 1, answers.length - 1)];
    },
    warn: () => undefined,
  });
  return { dir: github, keeper: made, asks, now };
}

const bot: GitHubCredentials = {
  token: "ghs_bot",
  expiresAt: 1_000_000_000 + 3600,
  identity: { name: "eta[bot]", email: "1+eta[bot]@users.noreply.github.com" },
};

describe("the GitHub login on a machine", () => {
  it("writes the token where gh and git look, and sets the shells' environment", async () => {
    const { dir, keeper: k, now } = await keeper([bot]);
    expect(k.env).toEqual({});
    const next = await k.refresh();
    expect(await readFile(join(dir, "token"), "utf8")).toBe("ghs_bot");
    expect(await readFile(join(dir, "login"), "utf8")).toBe("eta[bot]");
    expect(await readFile(join(dir, "gh", "hosts.yml"), "utf8")).toBe(
      "github.com:\n    oauth_token: ghs_bot\n    user: eta[bot]\n    git_protocol: https\n",
    );
    expect(await readFile(join(dir, "git", "github.inc"), "utf8")).toBe(
      "[user]\n\tname = eta[bot]\n\temail = 1+eta[bot]@users.noreply.github.com\n",
    );
    // Private: the token is a secret.
    if (process.platform !== "win32") {
      expect((await stat(join(dir, "token"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "gh"))).mode & 0o777).toBe(0o700);
    }
    expect(k.env.GH_CONFIG_DIR).toBe(join(dir, "gh"));
    expect(k.env.GIT_CONFIG_COUNT).toBe("3");
    expect(k.env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(k.env.GIT_CONFIG_VALUE_0).toBe("");
    expect(k.env.GIT_CONFIG_VALUE_1).toContain(`cat '${dir}'/token`);
    expect(k.env.GIT_CONFIG_KEY_2).toBe("include.path");
    expect(k.env.GIT_CONFIG_VALUE_2).toBe(join(dir, "git", "github.inc"));
    // Asked again five minutes before it expires.
    expect(next).toBe(1_000_000_000 + 3600 - now / 1000 - 300);
  });

  it("is the user's once they authorized the App", async () => {
    const { dir, keeper: k } = await keeper([
      { ...bot, token: "ghu_user", user: "akarachen" },
    ]);
    await k.refresh();
    expect(await readFile(join(dir, "login"), "utf8")).toBe("akarachen");
    expect(await readFile(join(dir, "gh", "hosts.yml"), "utf8")).toContain(
      "user: akarachen",
    );
  });

  it("asks again soon when the token is about to expire, never in under a minute", async () => {
    const { keeper: k } = await keeper([
      { ...bot, expiresAt: 1_000_000_000 + 10 },
    ]);
    expect(await k.refresh()).toBe(60);
  });

  it("leaves the machine's own logins alone while GitHub is not connected, and when it is disconnected", async () => {
    const { dir, keeper: k } = await keeper([null, bot, null]);
    expect(await k.refresh()).toBe(60);
    expect(k.env).toEqual({});
    expect(existsSync(join(dir, "token"))).toBe(false);
    await k.refresh();
    expect(k.env.GH_CONFIG_DIR).toBeDefined();
    await k.refresh();
    expect(k.env).toEqual({});
    expect(existsSync(join(dir, "token"))).toBe(false);
    expect(existsSync(join(dir, "gh"))).toBe(false);
    expect(existsSync(join(dir, "git"))).toBe(false);
  });

  it("keeps what it has while the primary cannot be asked", async () => {
    const { dir, keeper: k } = await keeper([bot, undefined]);
    await k.refresh();
    expect(await k.refresh()).toBe(60);
    expect(await readFile(join(dir, "token"), "utf8")).toBe("ghs_bot");
    expect(k.env.GH_CONFIG_DIR).toBeDefined();
  });

  it("asks once at a time", async () => {
    const { keeper: k, asks } = await keeper([bot]);
    await Promise.all([k.refresh(), k.refresh(), k.refresh()]);
    expect(asks).toHaveLength(1);
  });

  it("leaves the commit author alone without an identity", async () => {
    const { dir, keeper: k } = await keeper([{ ...bot, identity: null }]);
    await k.refresh();
    expect(k.env.GIT_CONFIG_COUNT).toBe("2");
    expect(existsSync(join(dir, "git", "github.inc"))).toBe(false);
    expect(await readFile(join(dir, "login"), "utf8")).toBe("x-access-token");
  });
});
