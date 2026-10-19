/**
 * The GitHub App in a running host: the `github` target, GitHub's returns to the host (exempt from
 * the token gate, and only for what the host started), the tools an agent has, the pull requests
 * a task delivered, git and gh on the host's machine and on a daemon's, and the akhook rule that
 * sends `gh pr create` to the tool.
 */
import type { GitHubStatus, TaskPullView } from "@eta/client-contracts";
import type { HostOptions } from "../src/host";
import type { Client } from "./support/client";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalEnvironment } from "@eta/execution-node";
import { afterEach, describe, expect, it } from "vitest";
import { connect, until } from "./support/client";
import { FakeGitHub } from "./support/github";
import { tempDir, testHost } from "./support/host";
import { call, gate, say, scriptedModels } from "./support/models";
import { remoteWorld } from "./support/remote";
import { world } from "./support/world";

const ORIGIN = "https://eta.example.com";
const TOKEN = "t".repeat(24);

const fakes: FakeGitHub[] = [];
function fakeGitHub(): FakeGitHub {
  const fake = new FakeGitHub();
  fakes.push(fake);
  return fake;
}
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
});

const tuning = (fake: FakeGitHub) => ({
  endpoints: { api: fake.url, oauth: fake.url },
});

/** A host behind the token gate, with a fake GitHub, and a client that holds the token. */
async function gated(fake: FakeGitHub) {
  const tokenFile = join(await tempDir("eta-token-"), "token");
  await writeFile(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const host = await testHost({
    tokenFile,
    publicUrl: ORIGIN,
    github: tuning(fake),
  });
  const base = `http://127.0.0.1:${host.port}`;
  const client = await connect(`ws://127.0.0.1:${host.port}/ws`, {
    authorization: `Bearer ${TOKEN}`,
  });
  await client.hello();
  client.subscribe("github");
  await until(() => client.section("github", "state") !== undefined);
  return { host, base, client };
}

const state = (client: Client) =>
  client.section<GitHubStatus>("github", "state")!;

/** Where a redirect from the host points, without following it. */
async function returnTo(url: string, init: RequestInit = {}) {
  const response = await fetch(url, { ...init, redirect: "manual" });
  return {
    status: response.status,
    location: response.headers.get("location"),
  };
}

/** The wizard's creation, then GitHub's return, as the browser does them. */
async function createApp(
  client: Client,
  base: string,
  code: "new-app" | "installed-app",
) {
  const form = (await client.call("github", "createApp", {
    name: "eta test",
    origin: "http://ignored.example",
  })) as { action: string; manifest: string };
  const stateParam = new URL(form.action).searchParams.get("state")!;
  const manifest = JSON.parse(form.manifest) as { redirect_url: string };
  // The browser is sent to the redirect URL the manifest named, which is the host's.
  expect(manifest.redirect_url).toBe(`${ORIGIN}/github/manifest/callback`);
  return await returnTo(
    `${base}/github/manifest/callback?code=${code}&state=${stateParam}`,
  );
}

describe("gitHub's returns to the host", () => {
  it("create the App from the state the host made, with no token", async () => {
    const fake = fakeGitHub();
    const { client, base } = await gated(fake);
    expect(state(client).state).toBe("not_connected");

    const back = await createApp(client, base, "installed-app");
    expect(back.status).toBe(303);
    expect(back.location).toBe("/?settings=connections&github=created");
    await until(() => state(client).app !== null);
    const status = (await client.call("github", "refresh", {
      fresh: true,
    })) as GitHubStatus;
    expect(status.state).toBe("ready");
    expect(status.installations.map((inst) => inst.account).sort()).toEqual([
      "acme",
      "akarachen",
    ]);
    await until(() => state(client).state === "ready");
  });

  it("do nothing for a state the host did not make", async () => {
    const fake = fakeGitHub();
    const { client, base } = await gated(fake);
    const forged = await returnTo(
      `${base}/github/manifest/callback?code=installed-app&state=forged`,
    );
    expect(forged.location).toContain("github_error=");
    const missing = await returnTo(`${base}/github/manifest/callback`);
    expect(missing.location).toContain("github_error=");
    expect(
      ((await client.call("github", "refresh", {})) as GitHubStatus).state,
    ).toBe("not_connected");

    // Nor does an authorization without an App, or with a state of nobody's.
    const unrelated = await returnTo(
      `${base}/github/authorization/callback?code=x&state=forged`,
    );
    expect(unrelated.location).toContain("github_error=");
    expect(fake.requests.filter((r) => r.includes("access_token"))).toEqual([]);
  });

  it("let the user authorize the App through the wizard, and say so when declined", async () => {
    const fake = fakeGitHub();
    const { client, base } = await gated(fake);
    await createApp(client, base, "installed-app");

    const declined = await returnTo(
      `${base}/github/authorization/callback?error=access_denied&error_description=denied&state=x`,
    );
    expect(declined.location).toContain("github_error=");

    const { url } = (await client.call("github", "authorize", {
      origin: "http://ignored.example",
    })) as { url: string };
    const redirect = new URL(fake.authorizeAs(url, "akarachen"));
    // The redirect GitHub sends the browser to is the host's configured address.
    expect(redirect.origin).toBe(ORIGIN);
    const back = await returnTo(
      `${base}${redirect.pathname}${redirect.search}`,
    );
    expect(back.location).toBe("/?settings=connections&github=authorized");
    await until(() => state(client).user?.login === "akarachen");

    // The state is spent: the same return again does nothing more.
    const again = await returnTo(
      `${base}${redirect.pathname}${redirect.search}`,
    );
    expect(again.location).toContain("github_error=");
  });

  it("are taken right after an installation, and tell the page what GitHub did", async () => {
    const fake = fakeGitHub();
    const { client, base } = await gated(fake);
    await createApp(client, base, "installed-app");
    const installed = await returnTo(
      `${base}/github/authorization/callback?installation_id=100&setup_action=install`,
    );
    expect(installed.location).toBe(
      "/?settings=connections&setup_action=install",
    );
    const authorized = await returnTo(
      `${base}/github/authorization/callback?code=${fake.codeFor("akarachen")}&setup_action=install`,
    );
    expect(authorized.location).toBe(
      "/?settings=connections&github=authorized",
    );
    await until(() => state(client).user?.login === "akarachen");
  });

  it("are the only things past the token gate: exact paths, GET only", async () => {
    const fake = fakeGitHub();
    const { base } = await gated(fake);
    for (const path of [
      "/github/manifest/callback",
      "/github/authorization/callback",
    ]) {
      expect(
        (await fetch(`${base}${path}`, { redirect: "manual" })).status,
      ).toBe(303);
      expect((await fetch(`${base}${path}`, { method: "POST" })).status).toBe(
        401,
      );
      expect((await fetch(`${base}${path}/x`)).status).toBe(401);
    }
    expect((await fetch(`${base}/github/webhook`)).status).toBe(401);
    expect((await fetch(`${base}/github`)).status).toBe(401);
  });
});

describe("the github target", () => {
  it("connects, authorizes and disconnects, and keeps the secrets to itself", async () => {
    const fake = fakeGitHub();
    const { client, base, host } = await gated(fake);
    await createApp(client, base, "installed-app");
    const { url } = (await client.call("github", "authorize", {
      origin: ORIGIN,
    })) as { url: string };
    const redirect = new URL(fake.authorizeAs(url, "akarachen"));
    await returnTo(`${base}${redirect.pathname}${redirect.search}`);
    await until(() => state(client).user !== null);

    // What went over the wire has no key, no secret and no token.
    const frames = JSON.stringify(client.frames);
    expect(frames).not.toContain("PRIVATE KEY");
    expect(frames).not.toContain("secret-axp-test");
    expect(frames).not.toContain("ghu_");
    expect(frames).not.toContain("ghs_");
    expect(
      host.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM github_app")
        .get()?.n,
    ).toBe(1);

    await client.call("github", "unauthorize", {});
    await until(() => state(client).user === null);
    await client.call("github", "disconnect", {});
    await until(() => state(client).state === "not_connected");
    expect(
      host.db
        .query<{ n: number }, []>("SELECT count(*) AS n FROM github_app")
        .get()?.n,
    ).toBe(0);
  });

  it("refuses a second App and a bad name, with the original's words", async () => {
    const fake = fakeGitHub();
    const { client, base } = await gated(fake);
    await expect(
      client.call("github", "createApp", { name: "", origin: ORIGIN }),
    ).rejects.toThrow();
    await createApp(client, base, "new-app");
    await expect(
      client.call("github", "createApp", { name: "again", origin: ORIGIN }),
    ).rejects.toThrow("已经连接了一个 GitHub App");
  });

  it("is not there without a way to say where the browser is", async () => {
    const fake = fakeGitHub();
    const host = await testHost({ github: tuning(fake) });
    const client = await connect(`ws://127.0.0.1:${host.port}/ws`);
    await client.hello();
    await expect(
      client.call("github", "createApp", {
        name: "eta",
        origin: "javascript:x",
      }),
    ).rejects.toThrow("--public-url");
  });
});

/** A connected App on a host whose agents run a scripted model; the token to push with. */
async function connectedWorld(
  fake: FakeGitHub,
  models?: Partial<HostOptions>["models"],
) {
  const w = await world({
    ...(models === undefined ? {} : { models }),
    publicUrl: ORIGIN,
    github: tuning(fake),
  });
  w.client.subscribe("github");
  await until(() => w.client.section("github", "state") !== undefined);
  const base = `http://127.0.0.1:${w.host.port}`;
  await createApp(w.client, base, "installed-app");
  await w.client.call("github", "refresh", { fresh: true });
  await until(() => state(w.client).state === "ready");
  const token = fake.issuedTokens()[0]!.token;
  return { w, base, token };
}

describe("the tools", () => {
  it("are offered to every session, open a pull request and link it to the task of the conversation", async () => {
    const fake = fakeGitHub();
    const calls = [
      call("create_task", { title: "Ship it", status: "in_progress" }),
      call("open_pull_request", {
        repository: "akarachen/axp",
        head: "feature",
        title: "Add feature",
        body: "Why",
      }),
      call("draft_issue", {
        repository: "akarachen/axp",
        title: "Bug",
        body: "坏了",
      }),
    ];
    const results: string[] = [];
    const { models, requests } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") results.push(request.last);
      return calls[results.length] ?? say("done");
    });
    const { w, token } = await connectedWorld(fake, models);
    fake.push(token, "akarachen/axp", "feature");
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);

    const sent = await w.send(group.id, "ship");
    const reply = await w.settled(group.id, sent.replies[0]!.id);
    expect(reply.text).toBe("done");
    expect(requests[0]!.tools).toEqual(
      expect.arrayContaining(["open_pull_request", "draft_issue"]),
    );

    const pull = JSON.parse(results[1]!) as Record<string, unknown>;
    expect(pull).toEqual({
      url: "https://github.com/akarachen/axp/pull/1",
      number: 1,
      created: true,
      author: "axp-test[bot]",
    });
    const draft = JSON.parse(results[2]!) as { url: string };
    expect(draft.url).toBe(
      "https://github.com/akarachen/axp/issues/new?body=%E5%9D%8F%E4%BA%86&title=Bug",
    );

    // The pull request is the task's: it shows on the target, beside the board.
    await until(
      () =>
        (w.client.section<TaskPullView[]>("github", "pulls") ?? []).length ===
        1,
    );
    const pulls = w.client.section<TaskPullView[]>("github", "pulls")!;
    expect(pulls[0]).toMatchObject({
      url: "https://github.com/akarachen/axp/pull/1",
      title: "Add feature",
      number: 1,
    });
    const task = w.host.db
      .query<{ id: string }, []>("SELECT id FROM task WHERE title = 'Ship it'")
      .get()!;
    expect(pulls[0]!.taskId).toBe(task.id);
    // Asking again for the same branch is the same pull request, linked once.
    const read = (await w.client.call("github", "pull", {
      url: pulls[0]!.url,
    })) as { state: string; merge: string; headSha: string };
    expect(read).toMatchObject({ state: "open", merge: "ready" });
    const merged = (await w.client.call("github", "merge", {
      url: pulls[0]!.url,
      headSha: read.headSha,
    })) as { state: string };
    expect(merged.state).toBe("merged");
  });

  it("link the pull request a task run opens to the run's own task, not to the conversation's latest one", async () => {
    const fake = fakeGitHub();
    const hold = gate();
    const { models } = scriptedModels(async (request) => {
      if (!request.system.includes("In this task you are")) return say("ok");
      if (request.lastRole === "toolResult") return say("finished");
      // The conversation has another task, made after this one: the later touched of the two.
      await hold.opened;
      return /task #1\b/.test(request.transcript[0] ?? "")
        ? call("open_pull_request", {
            repository: "akarachen/axp",
            head: "feature",
            title: "Run's pull request",
          })
        : call("finish_task", { summary: "Done." });
    });
    const { w, token } = await connectedWorld(fake, models);
    fake.push(token, "akarachen/axp", "feature");
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const run = w.host.product.board.create(
      {
        title: "Run me",
        description: "d",
        status: "todo",
        conversationId: group.id,
        workspace: "local",
      },
      { kind: "agent", agentId: ada.id },
    );
    const other = w.host.product.board.create(
      {
        title: "Another",
        description: "d",
        status: "in_progress",
        conversationId: group.id,
        workspace: "local",
      },
      { kind: "agent", agentId: ada.id },
    );
    // By the conversation alone it would be the other one, which was touched last.
    expect(
      w.host.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM task WHERE conversation_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
        )
        .get(group.id)?.id,
    ).toBe(other.id);
    hold.open();
    await until(
      () =>
        (w.client.section<TaskPullView[]>("github", "pulls") ?? []).length ===
        1,
    );
    expect(
      w.client.section<TaskPullView[]>("github", "pulls")![0],
    ).toMatchObject({ taskId: run.id, title: "Run's pull request" });
  });

  it("explain how to connect when GitHub is not connected, and still draft an issue", async () => {
    const calls = [
      call("open_pull_request", { repository: "a/b", head: "x", title: "t" }),
      call("draft_issue", { repository: "a/b", title: "Bug" }),
    ];
    const results: string[] = [];
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") results.push(request.last);
      return calls[results.length] ?? say("done");
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "go");
    await w.settled(group.id, sent.replies[0]!.id);
    expect(results[0]).toContain("设置 → 连接");
    expect(results[1]).toContain("https://github.com/a/b/issues/new?title=Bug");
  });
});

describe("the akhook rule", () => {
  it("sends gh pr create to open_pull_request, whether or not GitHub is connected", async () => {
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") return say(`saw: ${request.last}`);
      return call("bash", { command: "gh pr create --title x --body y" });
    });
    const w = await world({ models });
    const ada = await w.agent("Ada");
    const project = await w.project({ stewardId: ada.id });
    const group = await w.group(project.id, [ada.id]);
    await w.watch(group.id);
    const sent = await w.send(group.id, "open a pr");
    const done = await w.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("gh-pr-create");
    expect(done.text).toContain("推送分支后用 open_pull_request 工具开 PR。");
  });

  it("holds on a daemon's sessions too, and neither a project's file nor the user's can lift it", async () => {
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") return say(`saw: ${request.last}`);
      return call("bash", { command: "gh pr create --fill" });
    });
    const r = await remoteWorld({ models });
    // A project file that tries to switch the rule off.
    await writeFile(
      join(r.dir, ".akhook.yml"),
      "version: 1\ndisabled_rules: [gh-pr-create]\n",
    );
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "open a pr");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("gh-pr-create");
    expect(done.text).toContain("open_pull_request");
  });
});

/** Everything under a directory, as `path → text`. */
async function filesUnder(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.set(path, await readFile(path, "utf8").catch(() => ""));
    }
  };
  if (existsSync(root)) await walk(root);
  return files;
}

describe("git and gh on a machine", () => {
  it("are logged in as the App on the host, and as the user once they authorized it", async () => {
    const fake = fakeGitHub();
    const { w, base } = await connectedWorld(fake, undefined);
    const dir = join(w.host.dataDir, "github");
    await until(() => existsSync(join(dir, "token")));
    const bot = (await readFile(join(dir, "token"), "utf8")).trim();
    expect(bot.startsWith("ghs_")).toBe(true);
    // The files are written one after another, and a refresh may be in between.
    await until(async () =>
      (await readFile(join(dir, "gh", "hosts.yml"), "utf8")).includes(
        `oauth_token: ${(await readFile(join(dir, "token"), "utf8")).trim()}`,
      ),
    );
    expect(await readFile(join(dir, "login"), "utf8")).toBe("axp-test[bot]");
    expect(await readFile(join(dir, "git", "github.inc"), "utf8")).toContain(
      "name = axp-test[bot]",
    );

    // A shell of a session on this machine sees it: gh's config directory, git's credentials.
    const env = createLocalEnvironment(dir, w.host.product.shellEnv)!;
    const shell = async (command: string): Promise<string> => {
      const result = await env.exec(command);
      if (!result.ok) throw new Error(String(result.error));
      return result.value.stdout;
    };
    expect(await shell("printenv GH_CONFIG_DIR")).toContain(join(dir, "gh"));
    const filled = await shell(
      "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
    );
    expect(filled).toContain("username=axp-test[bot]");
    expect(filled).toContain(
      `password=${(await readFile(join(dir, "token"), "utf8")).trim()}`,
    );

    const { url } = (await w.client.call("github", "authorize", {
      origin: ORIGIN,
    })) as { url: string };
    const redirect = new URL(fake.authorizeAs(url, "akarachen"));
    await returnTo(`${base}${redirect.pathname}${redirect.search}`);
    await until(async () =>
      (await readFile(join(dir, "token"), "utf8")).startsWith("ghu_"),
    );
    const user = (await readFile(join(dir, "token"), "utf8")).trim();
    expect(user.startsWith("ghu_")).toBe(true);
    expect(await readFile(join(dir, "login"), "utf8")).toBe("akarachen");
    expect(await readFile(join(dir, "gh", "hosts.yml"), "utf8")).toContain(
      "user: akarachen",
    );
    expect(await shell("printenv GIT_CONFIG_COUNT")).toBe("3\n");

    // Disconnecting leaves the machine's own logins as they were.
    await w.client.call("github", "disconnect", {});
    await until(() => !existsSync(join(dir, "token")));
    expect(w.host.product.shellEnv.GH_CONFIG_DIR).toBeUndefined();
    expect(existsSync(join(dir, "gh"))).toBe(false);
  });

  it("are logged in on a daemon too, with the token relayed and no App secret kept there", async () => {
    const fake = fakeGitHub();
    const r = await remoteWorld({ publicUrl: ORIGIN, github: tuning(fake) });
    r.client.subscribe("github");
    await until(() => r.client.section("github", "state") !== undefined);
    const base = `http://127.0.0.1:${r.host.port}`;
    // The daemon is on the link before GitHub is connected.
    const dir = join(r.daemon.dataDir, "github");
    expect(existsSync(join(dir, "token"))).toBe(false);

    await createApp(r.client, base, "installed-app");
    await r.client.call("github", "refresh", { fresh: true });
    // Connecting reaches the daemon at once, not at its next hourly look.
    await until(() => existsSync(join(dir, "token")));
    const token = (await readFile(join(dir, "token"), "utf8")).trim();
    expect(token.startsWith("ghs_")).toBe(true);
    expect(await readFile(join(dir, "login"), "utf8")).toBe("axp-test[bot]");

    // Authorizing the App switches the daemon to the user.
    const { url } = (await r.client.call("github", "authorize", {
      origin: ORIGIN,
    })) as { url: string };
    const redirect = new URL(fake.authorizeAs(url, "akarachen"));
    await returnTo(`${base}${redirect.pathname}${redirect.search}`);
    await until(async () =>
      (await readFile(join(dir, "token"), "utf8")).startsWith("ghu_"),
    );
    expect(await readFile(join(dir, "login"), "utf8")).toBe("akarachen");

    // Nothing the daemon holds is the App's: no key, no client secret, no refresh token.
    const held = [...(await filesUnder(r.daemon.dataDir)).values()].join("\n");
    expect(held).not.toContain("PRIVATE KEY");
    expect(held).not.toContain("secret-axp-test");
    expect(held).not.toContain("ghr_");
    expect(held).toContain("ghu_");
    r.traffic.in.concat(r.traffic.out).forEach((frame) => {
      expect(frame).not.toContain("PRIVATE KEY");
      expect(frame).not.toContain("secret-axp-test");
    });

    // And disconnecting takes the login away from the daemon.
    await r.client.call("github", "disconnect", {});
    await until(() => !existsSync(join(dir, "token")));
  });

  it("run the daemon's shell with the login", async () => {
    const fake = fakeGitHub();
    const { models } = scriptedModels((request) => {
      if (request.lastRole === "toolResult") return say(`saw: ${request.last}`);
      return call("bash", {
        command:
          "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill",
      });
    });
    const r = await remoteWorld({
      models,
      publicUrl: ORIGIN,
      github: tuning(fake),
    });
    const base = `http://127.0.0.1:${r.host.port}`;
    await createApp(r.client, base, "installed-app");
    const dir = join(r.daemon.dataDir, "github");
    await until(() => existsSync(join(dir, "token")));
    const token = (await readFile(join(dir, "token"), "utf8")).trim();
    const { group } = await r.agents("Ada");
    const sent = await r.send(group.id, "who am I on github?");
    const done = await r.settled(group.id, sent.replies[0]!.id);
    expect(done.text).toContain("username=axp-test[bot]");
    expect(done.text).toContain(`password=${token}`);
  });
});
