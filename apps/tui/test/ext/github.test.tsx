/**
 * `/github` against a real host: without the optional `github` plugin, and with it pointed at the
 * fake GitHub of the host's own tests. The App is created the way a browser does it: the host's
 * form, then GitHub's return to the host's callback with the code the fake knows.
 */
import type { GitHubStatus } from "@eta/client-contracts";
import type { HostObserver } from "../ext-support/host-observer";
import { afterEach, describe, expect, it } from "vitest";
import { FakeGitHub } from "../../../eta/test/support/github";
import github from "../../src/ext/github";
import { observeHost } from "../ext-support/host-observer";
import { recordCalls, squash } from "../ext-support/record-calls";
import { renderWithHost } from "../ext-support/render-with-host";
import { baseUrl } from "../support/host";
import { KEYS } from "../ui-support/render";

/** The App `installed-app` makes in the fake (`INSTALLED_APP` in its file, not exported). */
const INSTALLED_APP_ID = 78;

const fakes: FakeGitHub[] = [];
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
});

const status = (host: HostObserver) =>
  host.section<GitHubStatus>("github", "state");

/**
 * A host with GitHub on and, unless `app` is undefined, an App created on it: `new-app` is
 * installed nowhere, `installed-app` is installed on two accounts. `/github` is open.
 */
async function opened(app?: "new-app" | "installed-app") {
  const fake = new FakeGitHub();
  fakes.push(fake);
  const r = await renderWithHost({
    extensions: [github],
    host: {
      overrides: { github: { endpoints: { api: fake.url, oauth: fake.url } } },
    },
    columns: 160,
    rows: 40,
  });
  const host = await observeHost(r.host);
  await host.until(() => status(host) !== undefined);
  if (app !== undefined) {
    const form = (await host.client.call("github", "createApp", {
      name: "eta test",
      origin: baseUrl(r.host),
    })) as { action: string };
    const state = new URL(form.action).searchParams.get("state")!;
    const back = await fetch(
      `${baseUrl(r.host)}/github/manifest/callback?code=${app}&state=${state}`,
      { redirect: "manual" },
    );
    expect(back.status).toBe(303);
    await host.until(() => status(host)?.app != null);
  }
  const calls = recordCalls(r.wire);
  await r.runCommand("/github");
  await r.waitFor("Status:");
  return { r, host, calls, fake };
}

describe("/github", () => {
  it("says the host does not have GitHub on, and how to turn it on", async () => {
    const r = await renderWithHost({ extensions: [github], columns: 160 });
    await r.runCommand("/github");
    await r.waitFor("This host does not have GitHub turned on");
    expect(r.screen()).toContain("--github");
    expect(r.screen()).toContain("ETA_GITHUB=1");
    expect(r.screen()).not.toContain("version");
    await r.press(KEYS.escape);
    await r.waitForGone("This host does not have GitHub turned on");
  });

  it("sends the user to the desktop to create the App when there is none", async () => {
    const { r } = await opened();
    await r.waitFor("Status: not connected");
    expect(r.screen()).toContain("submitting a form in a browser");
    expect(r.screen()).toContain("desktop app");
    expect(r.screen()).toContain("r refresh");
  });

  it("gives the install address for an App installed nowhere, and checks again on r", async () => {
    const { r, host, calls } = await opened("new-app");
    await r.waitFor("Status: not installed");
    // Nothing has asked GitHub since the App was made.
    expect(status(host)?.checked).toBe(false);
    expect(r.screen()).toContain("Not confirmed with GitHub yet");
    expect(r.screen()).toContain("App: axp-new");
    const installUrl = status(host)!.app!.installUrl;
    expect(squash(r.screen())).toContain(installUrl);
    expect(r.screen()).toContain("then press r");

    await r.press("r");
    await r.waitForGone("Not confirmed with GitHub yet");
    expect(calls.filter((call) => call.op === "github.refresh")).toEqual([
      expect.objectContaining({ args: { fresh: true } }),
    ]);
    expect(status(host)?.checked).toBe(true);
    expect(r.screen()).toContain("Status: not installed");
  });

  it("shows where a ready App is installed and who authorized it, and offers to authorize", async () => {
    const { r } = await opened("installed-app");
    await r.press("r");
    await r.waitFor("Status: ready");
    const screen = r.screen();
    expect(screen).toMatch(/App: axp-test, owned by \S+/);
    expect(screen).toContain("akarachen: 2 repositories");
    expect(screen).toContain("acme: all repositories");
    expect(screen).toContain("Authorized by: nobody yet");
    expect(screen).toContain("Press a to authorize");
    expect(screen).toContain("a authorize");
  });

  it("gives the authorization address from the connection's origin", async () => {
    const { r, calls } = await opened("installed-app");
    await r.press("r");
    await r.waitFor("Press a to authorize");
    await r.press("a");
    await r.waitFor("must be able to reach this host");
    const authorize = calls.find((call) => call.op === "github.authorize")!;
    expect(authorize.args).toEqual({ origin: baseUrl(r.host) });
    const outcome = await authorize.outcome;
    if (!outcome.ok) throw new Error("authorize failed");
    const { url } = outcome.value as { url: string };
    expect(squash(r.screen())).toContain(url);
    expect(r.screen()).toContain(baseUrl(r.host));
  });

  it("shows what GitHub refused when the App was deleted there", async () => {
    const { r, host, fake } = await opened("installed-app");
    await r.press("r");
    await r.waitFor("Status: ready");
    expect(status(host)!.app!.name).toBe("axp-test");
    // The fake's installed App; GitHub answers 401 for an App deleted on its side.
    fake.deleteApp(INSTALLED_APP_ID);
    await r.press("r");
    await r.waitFor("Status: error");
    const error = status(host)!.error;
    expect(error).not.toBeNull();
    expect(squash(r.screen())).toContain(squash(`Error: ${error!.message}`));
    expect(r.screen()).toContain("Press r to try again");
    expect(r.screen()).not.toContain("a authorize");
  });

  it("offers no authorization before the App is ready", async () => {
    const { r, calls } = await opened("new-app");
    await r.waitFor("Status: not installed");
    expect(r.screen()).not.toContain("a authorize");
    await r.press("a");
    await r.settle(200);
    expect(calls.filter((call) => call.op === "github.authorize")).toEqual([]);
  });
});
