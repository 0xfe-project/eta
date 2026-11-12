/**
 * `/machines` against a real host: the `machines` target, an install code from `machines.enroll`,
 * a machine made pending by trading that code at the host's `POST /machines/enroll` (what a new
 * machine's daemon does), and approving and revoking it.
 */
import type { MachineView } from "@eta/client-contracts";
import type { HostObserver } from "../ext-support/host-observer";
import { MachineStore } from "@eta/app/src/machines/store";
import { Tailscale } from "@eta/app/src/machines/tailscale";
import { describe, expect, it } from "vitest";
import machines from "../../src/ext/machines";
import { enrollUrl } from "../../src/ext/machines/address";
import { observeHost } from "../ext-support/host-observer";
import { recordCalls, squash } from "../ext-support/record-calls";
import { renderWithHost } from "../ext-support/render-with-host";
import { baseUrl } from "../support/host";
import { KEYS } from "../ui-support/render";

const FINGERPRINT = "ab".repeat(32);
const WRONG_FINGERPRINT = "cd".repeat(32);

const list = (host: HostObserver) =>
  host.section<MachineView[]>("machines", "list") ?? [];
const machine = (host: HostObserver, name: string) =>
  list(host).find((entry) => entry.name === name);

type Rendered = Awaited<ReturnType<typeof renderWithHost>>;

/** Makes a machine pending the way a new machine's daemon does: a code, traded at the host. */
async function enrollPending(
  r: Rendered,
  host: HostObserver,
  name: string,
): Promise<void> {
  const { code } = (await host.client.call("machines", "enroll", {
    url: baseUrl(r.host),
  })) as { code: string };
  const response = await fetch(`${baseUrl(r.host)}/machines/enroll`, {
    method: "POST",
    body: JSON.stringify({
      code,
      fingerprint: FINGERPRINT,
      hostname: name,
      home: "/home/someone",
      os: "linux",
    }),
  });
  expect(response.status).toBe(200);
  await host.until(() => machine(host, name)?.status === "pending");
}

/** Tailscale on the host's machine, saying the host is on a tailnet as `box.tail.ts.net`. */
const onTailnet = new Tailscale({
  run: async () =>
    JSON.stringify({
      BackendState: "Running",
      Self: {
        ID: "n1",
        HostName: "box",
        DNSName: "box.tail.ts.net.",
        TailscaleIPs: ["127.0.0.1"],
        OS: "linux",
      },
    }),
});

/** Tailscale that fails when asked, so `machines.addresses` does. */
const brokenTailscale = {
  installed: true,
  status: async () => {
    throw new Error("tailscale is broken");
  },
} as unknown as Tailscale;

async function opened(pending: string[] = [], tailscale?: Tailscale) {
  const r = await renderWithHost({
    extensions: [machines],
    columns: 140,
    rows: 40,
    ...(tailscale === undefined ? {} : { host: { overrides: { tailscale } } }),
  });
  const host = await observeHost(r.host);
  await host.until(() => list(host).length > 0);
  for (const name of pending) await enrollPending(r, host, name);
  const calls = recordCalls(r.wire);
  await r.runCommand("/machines");
  await r.waitFor("Machines");
  return { r, host, calls };
}

/** Moves the marker down to the row of this machine and opens it. */
async function openMachine(r: Rendered, name: string) {
  for (let i = 0; i < 10 && !new RegExp(`› ${name}`).test(r.screen()); i += 1)
    await r.press(KEYS.down);
  expect(r.screen()).toMatch(new RegExp(`› ${name}`));
  await r.press(KEYS.enter);
  await r.waitFor("Kind: ");
}

describe("enrollUrl", () => {
  it.each([
    [
      "the tailnet address when the host has one",
      "http://100.64.0.1:8787",
      "http://127.0.0.1:8787",
      "http://100.64.0.1:8787",
    ],
    [
      "the tailnet address over a reachable connection too",
      "http://100.64.0.1:8787",
      "https://eta.example.com/ws",
      "http://100.64.0.1:8787",
    ],
    [
      "the connection's origin when it is not loopback",
      null,
      "https://eta.example.com:8443/some/path",
      "https://eta.example.com:8443",
    ],
    [
      "the connection's origin for a LAN address",
      null,
      "http://192.168.1.20:8787",
      "http://192.168.1.20:8787",
    ],
    ["nothing for 127.0.0.1", null, "http://127.0.0.1:8787", undefined],
  ])("is %s", (_, tailnet, connection, expected) => {
    expect(enrollUrl({ tailnet, connectionUrl: connection })).toBe(expected);
  });
});

describe("/machines", () => {
  it("lists the machines with their kind, status and system, and marks this host", async () => {
    const { r } = await opened(["laptop"]);
    await r.waitFor("laptop");
    const screen = r.screen();
    expect(screen).toMatch(/laptop\s+daemon · awaiting approval · linux/);
    expect(screen).toMatch(/primary · online.*this host/);
    expect(screen.match(/this host/g)).toHaveLength(1);
    expect(screen).toContain("a add");
  });

  it("adds a machine: shows an install code the host will take, the whole command and where it connects", async () => {
    const { r, calls } = await opened();
    await r.press("a");
    await r.waitFor("Install code:");
    const enroll = calls.find((call) => call.op === "machines.enroll")!;
    // A loopback connection and no tailnet: the host picks the address.
    expect(enroll.args).toEqual({});
    expect(calls.map((call) => call.op)).toContain("machines.addresses");
    const outcome = await enroll.outcome;
    if (!outcome.ok) throw new Error("enroll failed");
    const result = outcome.value as {
      code: string;
      url: string;
      command: string;
      expiresAt: number;
    };
    const screen = squash(r.screen());
    expect(screen).toContain(squash(`Install code: ${result.code}`));
    expect(screen).toContain(squash(result.command));
    expect(screen).toContain(squash(`It will connect to: ${result.url}`));
    expect(r.screen()).toMatch(/Expires: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(r.screen()).toContain("shows up in the list awaiting approval");
    expect(new MachineStore(r.host.db).codeIsGood(result.code)).toBe(true);
  });

  it("shows a new machine as it arrives", async () => {
    const { r, host } = await opened();
    await enrollPending(r, host, "desk");
    await r.waitFor(/desk\s+daemon · awaiting approval/);
  });

  it("refuses a wrong fingerprint in the host's words, and approves with the right one", async () => {
    const { r, host } = await opened(["laptop"]);
    await openMachine(r, "laptop");
    expect(r.screen()).toContain("Status: awaiting approval");
    expect(r.screen()).toContain("Approve");
    expect(r.screen()).toContain("Revoke");
    await r.press(KEYS.enter);
    await r.waitFor("Fingerprint shown on that machine's terminal");
    await r.press(KEYS.paste(WRONG_FINGERPRINT));
    await r.press(KEYS.enter);
    await r.waitFor("that is not the fingerprint this machine enrolled with");
    expect(machine(host, "laptop")?.status).toBe("pending");

    await r.press(KEYS.escape);
    await r.waitForGone("Fingerprint shown on that machine's terminal");
    await r.press(KEYS.enter);
    await r.waitFor("Fingerprint shown on that machine's terminal");
    await r.press(KEYS.paste(FINGERPRINT));
    await r.press(KEYS.enter);
    await host.until(() => machine(host, "laptop")?.status === "offline");
    await r.waitFor("Status: offline");
    expect(r.screen()).not.toContain("Approve");
  });

  it("revokes after asking once more", async () => {
    const { r, host, calls } = await opened(["laptop"]);
    await openMachine(r, "laptop");
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await r.waitFor("Revoke laptop?");
    expect(calls.filter((call) => call.op === "machines.revoke")).toEqual([]);
    await r.press(KEYS.enter);
    await host.until(() => machine(host, "laptop")?.status === "revoked");
    await r.waitFor("Status: revoked");
    await r.waitFor("Nothing to do for this machine.");
  });

  it("keeps the machine on Esc at the question", async () => {
    const { r, host, calls } = await opened(["laptop"]);
    await openMachine(r, "laptop");
    await r.press(KEYS.down);
    await r.press(KEYS.enter);
    await r.waitFor("Revoke laptop?");
    await r.press(KEYS.escape);
    await r.waitForGone("Revoke laptop?");
    await r.settle(200);
    expect(calls.filter((call) => call.op === "machines.revoke")).toEqual([]);
    expect(machine(host, "laptop")?.status).toBe("pending");
  });

  it("tells a new machine the host's tailnet address when it has one", async () => {
    const { r, calls } = await opened([], onTailnet);
    await r.press("a");
    await r.waitFor("Install code:");
    const port = new URL(baseUrl(r.host)).port;
    const tailnet = `http://box.tail.ts.net:${port}`;
    expect(calls.find((call) => call.op === "machines.enroll")!.args).toEqual({
      url: tailnet,
    });
    expect(squash(r.screen())).toContain(
      squash(`It will connect to: ${tailnet}`),
    );
  });

  it("shows why there is no install code when the host cannot say its addresses", async () => {
    const { r, calls } = await opened([], brokenTailscale);
    await r.press("a");
    await r.waitFor("tailscale is broken");
    expect(calls.filter((call) => call.op === "machines.enroll")).toEqual([]);
    expect(r.screen()).not.toContain("Install code:");
  });

  it("offers nothing for this host", async () => {
    const { r } = await opened();
    await r.press(KEYS.enter);
    await r.waitFor("Nothing to do for this machine.");
    expect(r.screen()).not.toContain("Revoke");
  });

  it("goes back from a machine and from the install code on Esc, and closes on Esc", async () => {
    const { r } = await opened();
    await r.press(KEYS.enter);
    await r.waitFor("Kind: ");
    await r.press(KEYS.escape);
    await r.waitForGone("Kind: ");
    await r.press("a");
    await r.waitFor("Install code:");
    await r.press(KEYS.escape);
    await r.waitForGone("Install code:");
    expect(r.screen()).toContain("Machines");
    await r.press(KEYS.escape);
    await r.waitForGone("Machines");
  });
});
