/**
 * `/providers` against a real host with the real model gateway (CLIProxyAPI in a child process).
 * Only the providers it logs in to are fakes: Google's key check and OpenAI's device
 * authorization (`fake-upstreams.ts`).
 */
import type { Host } from "@eta/app/src/host";
import type { LlmConnection } from "@eta/client-contracts";
import type { HostRendered } from "../ext-support/render-with-host";
import { describe, expect, it } from "vitest";
import providers from "../../src/ext/providers";
import {
  BAD_KEY,
  fakeGoogle,
  fakeOpenAI,
  GOOD_KEY,
  USER_CODE,
} from "../ext-support/fake-upstreams";
import { recordCalls } from "../ext-support/host-wire";
import { LIST_KEYS } from "../ext-support/keys";
import { renderWithHost } from "../ext-support/render-with-host";
import { until } from "../support/temp";
import { KEYS } from "../ui-support/render";

const GATEWAY_MS = 60_000;
const SLOW = 120_000;

async function connections(host: Host): Promise<LlmConnection[]> {
  if (host.llm === undefined) throw new Error("the host has no gateway");
  return host.llm.gateway.connections();
}

/** Seeds a Google AI Studio key on the host's gateway before the interface connects. */
async function seedGoogleKey(host: Host): Promise<void> {
  if (host.llm === undefined) throw new Error("the host has no gateway");
  const login = await host.llm.gateway.loginStart("gemini");
  await host.llm.gateway.loginSubmit(login.id, GOOD_KEY);
}

async function openProviders(r: HostRendered): Promise<void> {
  await r.runCommand("/providers");
  // The connectors come with the gateway's first status read.
  await r.waitFor("Connect Google AI Studio", GATEWAY_MS);
}

/** The line the list marker is on. */
function markedLine(r: HostRendered): string {
  return (
    r
      .screen()
      .split("\n")
      .find((line) => line.includes("›")) ?? ""
  );
}

/** Moves the marker down until its line holds `text`. */
async function markLine(r: HostRendered, text: string): Promise<void> {
  await r.press(LIST_KEYS.home);
  for (let step = 0; step < 12 && !markedLine(r).includes(text); step++)
    await r.press(KEYS.down);
  expect(markedLine(r)).toContain(text);
}

describe("/providers without the gateway", () => {
  it("says the host is not running the model gateway and where the configured providers are changed", async () => {
    const r = await renderWithHost({ extensions: [providers] });
    await r.runCommand("/providers");
    await r.waitFor("This host is not running the model gateway");
    expect(r.screen()).toContain("--no-llm");
    expect(r.screen()).toContain("or the gateway did not");
    expect(r.screen()).toContain("/edit-host-config config.json");
    expect(r.screen()).toContain("Usable models: 0");
    expect(r.screen()).not.toContain("Connect ");
    // The gateway is not asked for, so the host never answers it missing.
    expect(r.wire.store.getState().missing).toEqual({});
    await r.press(KEYS.escape);
    await r.waitForGone("This host is not running the model gateway");
    await r.close();
  });
});

describe("/providers with the gateway", () => {
  it(
    "lists the connectors the gateway has, under the count of usable models",
    async () => {
      const r = await renderWithHost({
        extensions: [providers],
        host: { overrides: { llm: {} } },
      });
      await openProviders(r);
      const screen = r.screen();
      expect(screen).toContain("Usable models: 0");
      const order = [
        "Connect Codex",
        "Connect Grok",
        "Connect Google AI Studio",
      ];
      const at = order.map((text) => screen.indexOf(text));
      expect(at.every((index) => index >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      await r.close();
    },
    SLOW,
  );

  it(
    "takes an API key: a wrong one shows the error under the input, the right one adds the account",
    async () => {
      const google = fakeGoogle();
      const r = await renderWithHost({
        extensions: [providers],
        host: { overrides: { llm: { endpoints: { gemini: google.url } } } },
      });
      await openProviders(r);
      await markLine(r, "Connect Google AI Studio");
      await r.press(KEYS.enter);
      await r.waitFor("https://aistudio.google.com/apikey");

      await r.type(BAD_KEY);
      // Masked: the key itself never shows.
      expect(r.screen()).not.toContain(BAD_KEY);
      await r.press(KEYS.enter);
      await r.waitFor("The API key is invalid. Enter it again.", GATEWAY_MS);
      // Still on the input, which holds what was typed: correct it and send again.
      expect(r.screen()).toContain("https://aistudio.google.com/apikey");
      expect(await connections(r.host)).toEqual([]);
      // The input still holds the refused key: one Backspace leaves all but its last character.
      await r.press(KEYS.backspace);
      expect(r.screen()).toContain(`› ${"*".repeat(BAD_KEY.length - 1)}`);
      expect(r.screen()).not.toContain("*".repeat(BAD_KEY.length));
      for (let i = 1; i < BAD_KEY.length; i++) await r.press(KEYS.backspace);
      await r.type(GOOD_KEY);
      await r.press(KEYS.enter);

      await r.waitFor("Connected Google AI Studio", GATEWAY_MS);
      await r.waitFor("…0001");
      await r.waitForGone("https://aistudio.google.com/apikey");
      const [account] = await connections(r.host);
      expect(account).toMatchObject({ connector: "gemini", label: "…0001" });
      // The account's models are usable now, and the count follows.
      await r.waitFor(/Usable models: [1-9]/, GATEWAY_MS);
      await r.close();
    },
    SLOW,
  );

  it(
    "signs in with a device code: shows the address and the code, and lists the account when it succeeds",
    async () => {
      const openai = fakeOpenAI("ok");
      const r = await renderWithHost({
        extensions: [providers],
        host: {
          overrides: { llm: { endpoints: { codexIssuer: openai.url } } },
        },
      });
      await openProviders(r);
      await markLine(r, "Connect Codex");
      await r.press(KEYS.enter);
      await r.waitFor(USER_CODE, GATEWAY_MS);
      const screen = r.screen();
      expect(screen).toContain("https://auth.openai.com/codex/device");
      expect(screen).toContain(
        "Open the address in a browser and enter the code.",
      );
      expect(screen).toMatch(/Expires in \d+:\d\d/);

      await r.waitFor("Connected Codex", GATEWAY_MS);
      await r.waitForGone(USER_CODE);
      await r.waitFor("ada@example.com", GATEWAY_MS);
      expect(await connections(r.host)).toEqual([
        expect.objectContaining({
          connector: "codex",
          label: "ada@example.com",
        }),
      ]);
      await r.close();
    },
    SLOW,
  );

  it(
    "cancels a waiting device login on Esc: the host forgets it",
    async () => {
      const openai = fakeOpenAI("pending");
      const r = await renderWithHost({
        extensions: [providers],
        host: {
          overrides: { llm: { endpoints: { codexIssuer: openai.url } } },
        },
      });
      const calls = recordCalls(r.wire);
      await openProviders(r);
      await markLine(r, "Connect Codex");
      await r.press(KEYS.enter);
      await r.waitFor(USER_CODE, GATEWAY_MS);
      const started = calls.find((call) => call.action === "loginStart");
      const id = (started?.result as { login: { id: string } } | undefined)
        ?.login.id;
      expect(id).toBeDefined();

      await r.press(KEYS.escape);
      await r.waitForGone(USER_CODE);
      // Back on the list, not closed.
      expect(r.screen()).toContain("Connect Codex");
      await r.waitUntil(
        () =>
          calls.some(
            (call) =>
              call.action === "loginCancel" &&
              (call.args as { id: string }).id === id,
          ),
        "the login to be cancelled",
      );
      await expect(
        r.wire.call("llm", "loginPoll", { id }),
      ).rejects.toMatchObject({ problem: { code: "not_found" } });
      expect(await connections(r.host)).toEqual([]);
      await r.close();
    },
    SLOW,
  );

  it(
    "shows why a device login failed, and starts it again on Enter",
    async () => {
      const openai = fakeOpenAI("refused");
      const r = await renderWithHost({
        extensions: [providers],
        host: {
          overrides: { llm: { endpoints: { codexIssuer: openai.url } } },
        },
      });
      await openProviders(r);
      await markLine(r, "Connect Codex");
      await r.press(KEYS.enter);
      await r.waitFor("Login failed. Try again.", GATEWAY_MS);
      expect(r.screen()).toContain("Enter to try again");
      const asked = () =>
        openai.sent.filter(
          (path) => path === "/api/accounts/deviceauth/usercode",
        ).length;
      expect(asked()).toBe(1);
      await r.press(KEYS.enter);
      await r.waitUntil(() => asked() === 2, "a second login to start");
      await r.waitFor("Login failed. Try again.", GATEWAY_MS);
      await r.close();
    },
    SLOW,
  );

  it(
    "disables, enables and removes an account, and the host's account follows",
    async () => {
      const google = fakeGoogle();
      const r = await renderWithHost({
        extensions: [providers],
        host: { overrides: { llm: { endpoints: { gemini: google.url } } } },
        seed: seedGoogleKey,
      });
      await openProviders(r);
      await r.waitFor("…0001", GATEWAY_MS);
      const [account] = await connections(r.host);
      expect(account?.state).toBe("active");

      await markLine(r, "…0001");
      await r.press(KEYS.enter);
      await r.waitFor("Disable");
      // A working account needs no new sign-in.
      expect(r.screen()).not.toContain("Sign in again");
      expect(r.screen()).not.toContain("Enable");
      await markLine(r, "Disable");
      await r.press(KEYS.enter);
      await r.waitUntil(
        () => r.screen().includes("Disabled"),
        "the list to show the account disabled",
        GATEWAY_MS,
      );
      expect((await connections(r.host))[0]?.state).toBe("disabled");

      await markLine(r, "…0001");
      await r.press(KEYS.enter);
      await r.waitFor("Enable");
      await markLine(r, "Enable");
      await r.press(KEYS.enter);
      await r.waitForGone("Disabled", GATEWAY_MS);
      expect((await connections(r.host))[0]?.state).toBe("active");

      await markLine(r, "…0001");
      await r.press(KEYS.enter);
      await r.waitFor("Remove");
      await markLine(r, "Remove");
      await r.press(KEYS.enter);
      await r.waitFor("Remove …0001?");
      // Nothing is removed before the second Enter.
      expect(await connections(r.host)).toHaveLength(1);
      await r.press(KEYS.enter);
      await r.waitFor("Removed …0001", GATEWAY_MS);
      expect(await connections(r.host)).toEqual([]);
      await r.waitForGone(/…0001\s+Google AI Studio/);
      expect(r.screen()).toContain("Connect Google AI Studio");
      await r.close();
    },
    SLOW,
  );

  it(
    "offers a new sign-in for an account whose key stopped working",
    async () => {
      const google = fakeGoogle();
      const r = await renderWithHost({
        extensions: [providers],
        host: { overrides: { llm: { endpoints: { gemini: google.url } } } },
        seed: seedGoogleKey,
      });
      google.accepted.clear();
      await r.wire.call("llm", "refresh", {});
      await until(
        async () =>
          ["needs_login", "error"].includes(
            (await connections(r.host))[0]?.state ?? "",
          ),
        GATEWAY_MS,
        "the account to need a new sign-in",
      );

      await openProviders(r);
      await markLine(r, "…0001");
      await r.press(KEYS.enter);
      await r.waitFor("Sign in again");
      await markLine(r, "Sign in again");
      await r.press(KEYS.enter);
      // A new sign-in for this connector: its key input.
      await r.waitFor("https://aistudio.google.com/apikey");
      await r.close();
    },
    SLOW,
  );

  it(
    "shows the reason when an action on an account fails, and stays open",
    async () => {
      const google = fakeGoogle();
      const r = await renderWithHost({
        extensions: [providers],
        host: { overrides: { llm: { endpoints: { gemini: google.url } } } },
        seed: seedGoogleKey,
      });
      await openProviders(r);
      await r.waitFor("…0001", GATEWAY_MS);
      await markLine(r, "…0001");
      await r.press(KEYS.enter);
      await r.waitFor("Remove");
      // Gone behind the list's back: the host answers the removal with not_found.
      const [account] = await connections(r.host);
      await r.host.llm!.gateway.remove(account!.id);
      await markLine(r, "Remove");
      await r.press(KEYS.enter);
      await r.waitFor("Remove …0001?");
      await r.press(KEYS.enter);
      await r.waitFor("Not found.", GATEWAY_MS);
      expect(r.screen()).toContain("Remove …0001?");
      await r.close();
    },
    SLOW,
  );

  it(
    "acts once when Enter comes twice at once on an account's action or its removal",
    async () => {
      const google = fakeGoogle();
      const r = await renderWithHost({
        extensions: [providers],
        host: { overrides: { llm: { endpoints: { gemini: google.url } } } },
        seed: seedGoogleKey,
      });
      const calls = recordCalls(r.wire);
      const count = (action: string) =>
        calls.filter((call) => call.action === action).length;
      await openProviders(r);
      await r.waitFor("…0001", GATEWAY_MS);

      await markLine(r, "…0001");
      await r.press(KEYS.enter);
      await r.waitFor("Disable");
      await markLine(r, "Disable");
      await r.press(`${KEYS.enter}${KEYS.enter}`);
      await r.waitFor("Disabled", GATEWAY_MS);
      await r.settle(300);
      expect(count("setEnabled")).toBe(1);

      await markLine(r, "…0001");
      await r.press(KEYS.enter);
      await r.waitFor("Remove");
      await markLine(r, "Remove");
      await r.press(KEYS.enter);
      await r.waitFor("Remove …0001?");
      // Ink hands this layer's own `useInput` a two-Enter chunk as one input that is no Enter at
      // all, so here the two Enters are two reads with no render between them.
      await Promise.all([r.press(KEYS.enter), r.press(KEYS.enter)]);
      await r.waitFor("Removed …0001", GATEWAY_MS);
      await r.settle(300);
      expect(count("remove")).toBe(1);
      expect(r.screen()).not.toContain("Not found.");
      await r.close();
    },
    SLOW,
  );
});
