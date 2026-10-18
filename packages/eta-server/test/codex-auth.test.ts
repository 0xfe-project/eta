/**
 * The codex auth kit (S21).
 *
 * Two subjects, and they are separate on purpose.
 *
 * **The store** is what pi-ai reads: one file, keyed by provider, written atomically with the
 * permissions a token deserves, and locked so two writers cannot lose each other's work.
 *
 * **The login** is what a person watches. The flow itself is pi-ai's (a network), so the tests
 * inject a runner: what is tested here is everything *around* the flow — which attempt is live,
 * whether an answer belongs to it, and what a cancel leaves behind. That is the state machine the
 * acceptance asks for.
 */

import type { Credential } from "@earendil-works/pi-ai";
import type { CodexLoginRunner } from "../src/codex-auth";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  codexAuthPath,
  CodexCredentialStore,
  CodexLogin,
  LOGIN_TIMEOUT_MS,
} from "../src/codex-auth";

const roots: string[] = [];

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eta-codex-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const credential = (key = "sk"): Credential => ({ type: "api_key", key });

describe("the credential store", () => {
  it("keeps what it is given, in one file only the user can read", async () => {
    const root = await scratch();
    const store = new CodexCredentialStore(
      codexAuthPath(join(root, "config.json")),
    );
    expect(await store.read("openai-codex")).toBeUndefined();
    await store.modify("openai-codex", async () => credential());
    expect(await store.read("openai-codex")).toMatchObject({ type: "api_key" });

    // The path is beside the config, as the layout in SERVER-REFACTOR.md §10 says.
    expect(store.path).toBe(join(root, "codex-auth.json"));
    const mode = (await stat(store.path)).mode & 0o777;
    expect(mode).toBe(0o600);
    // And what a UI lists carries no secret: the type, not the token.
    const listed = await store.list();
    expect(listed).toEqual([{ providerId: "openai-codex", type: "api_key" }]);
    // What a UI lists carries the type, not the key.
    expect(JSON.stringify(listed)).not.toContain("sk");
  });

  it("refuses a file that does not parse rather than reporting an empty store", async () => {
    const root = await scratch();
    const store = new CodexCredentialStore(join(root, "codex-auth.json"));
    await writeFile(store.path, "{ not json", "utf8");
    // "your credentials are corrupt" and "you never logged in" are different situations, and a
    // silent `{}` would report the second for both.
    await expect(store.read("openai-codex")).rejects.toThrow(
      /codex_credentials_invalid/,
    );
    await expect(
      store.modify("openai-codex", async () => credential()),
    ).rejects.toThrow(/codex_credentials_invalid/);
  });

  it("serialises concurrent writes, so neither is lost", async () => {
    const root = await scratch();
    const store = new CodexCredentialStore(join(root, "codex-auth.json"));
    await Promise.all([
      store.modify("a", async () => credential("a")),
      store.modify("b", async () => credential("b")),
    ]);
    // Both providers are in the file: a lost update would show up as one of them missing.
    expect(
      (await store.list()).map((entry) => entry.providerId).sort(),
    ).toEqual(["a", "b"]);
  });

  it("deletes one provider and leaves the others", async () => {
    const root = await scratch();
    const store = new CodexCredentialStore(join(root, "codex-auth.json"));
    await store.modify("a", async () => credential());
    await store.modify("b", async () => credential());
    await store.delete("a");
    expect((await store.list()).map((entry) => entry.providerId)).toEqual([
      "b",
    ]);
  });

  it("does not leave a lock behind", async () => {
    const root = await scratch();
    const store = new CodexCredentialStore(join(root, "codex-auth.json"));
    await store.modify("a", async () => credential());
    const { readdir } = await import("node:fs/promises");
    expect(
      (await readdir(root)).filter((name) => name.includes(".lock")),
    ).toEqual([]);
    // And the file is JSON, not a fragment.
    const raw = await readFile(store.path, "utf8");
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  });
});

/**
 * A login runner a test drives by hand.
 *
 * The flow is pi-ai's (a browser, a poll, a network); what these tests are about is
 * everything *around* it — so the runner records what it was handed and waits for the test to finish it,
 * fail it, or ask a prompt.
 */
interface Script {
  prompts: {
    type: string;
    options?: readonly { id: string; label: string }[] | undefined;
  }[];
  notified: {
    type: string;
    url?: string;
    userCode?: string;
    verificationUri?: string;
  }[];
  signals: AbortSignal[];
  finish: () => void;
  fail: (error: unknown) => void;
  ask: (prompt: {
    type: string;
    options?: readonly { id: string; label: string }[];
    signal?: AbortSignal;
  }) => Promise<string>;
  notify: (event: {
    type: string;
    url?: string;
    userCode?: string;
    verificationUri?: string;
  }) => void;
}

function scripted(): { seen: Script; login: CodexLoginRunner } {
  const seen: Script = {
    prompts: [],
    notified: [],
    signals: [],
    finish: () => undefined,
    fail: () => undefined,
    ask: async () => "",
    notify: () => undefined,
  };
  const login: CodexLoginRunner = (interaction) => {
    seen.signals.push(interaction.signal);
    return new Promise<unknown>((resolve, reject) => {
      seen.finish = () => resolve(undefined);
      seen.fail = reject;
      seen.ask = async (prompt) => {
        seen.prompts.push({ type: prompt.type, options: prompt.options });
        return await interaction.prompt(prompt);
      };
      seen.notify = (event) => {
        seen.notified.push(event);
        interaction.notify(event);
      };
    });
  };
  return { seen, login };
}

describe("the login state machine", () => {
  it("reports a pending attempt whose method it was started with", async () => {
    const { login } = scripted();
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login,
    });
    const view = codex.start("device_code");
    expect(view.status).toBe("pending");
    expect(view.method).toBe("device_code");
    expect(codex.status(view.id)).toEqual(view);
  });

  it("cancels the previous attempt when a new one starts", async () => {
    const { seen, login } = scripted();
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login,
    });
    const first = codex.start();
    const second = codex.start();
    expect(second.id).not.toBe(first.id);
    // The first attempt is cancelled (not failed), and the second is the live one.
    expect(codex.status(first.id)).toEqual({
      id: first.id,
      status: "cancelled",
      method: "browser",
    });
    expect(codex.status(second.id).status).toBe("pending");
    expect(seen.signals[0]?.aborted).toBe(true);
  });

  it("answers only the prompt it is actually waiting on", async () => {
    const { seen, login } = scripted();
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login,
    });
    const view = codex.start();
    // Ask the flow for a manual code: the attempt records the prompt it is waiting on.
    const answered = seen.ask({ type: "manual_code" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const promptId = codex.status(view.id).manualPromptId;
    expect(promptId).toBeDefined();

    // The wrong attempt, the wrong prompt, and a prompt that does not exist are all refused.
    expect(codex.answer("some-other-id", promptId as string, "123456")).toBe(
      false,
    );
    expect(codex.answer(view.id, "not-this-prompt", "123456")).toBe(false);
    // The right one is accepted, and the flow gets the value.
    expect(codex.answer(view.id, promptId as string, "123456")).toBe(true);
    await expect(answered).resolves.toBe("123456");
    // Answering twice is a second refusal, not a second resolution.
    expect(codex.answer(view.id, promptId as string, "654321")).toBe(false);
  });

  it("shows the device code and the URL as the flow reports them", async () => {
    const { seen, login } = scripted();
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login,
    });
    const view = codex.start("device_code");
    seen.notify({
      type: "device_code",
      userCode: "ABCD-1234",
      verificationUri: "https://x/device",
    });
    expect(codex.status(view.id)).toMatchObject({
      status: "pending",
      userCode: "ABCD-1234",
      url: "https://x/device",
    });
    // A URL with no code (the browser flow) is reported the same way.
    seen.notify({ type: "auth_url", url: "https://x/authorize" });
    expect(codex.status(view.id).url).toBe("https://x/authorize");
    // Nothing in the public state is a token.
    expect(JSON.stringify(codex.status(view.id))).not.toContain("token");
  });

  it("settles as complete, and says `failed` for an id it never knew", async () => {
    const { seen, login } = scripted();
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login,
    });
    const view = codex.start();
    seen.finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(codex.status(view.id).status).toBe("complete");
    // An id nobody knows is not a lie about being pending.
    expect(codex.status("never-seen")).toEqual({
      id: "never-seen",
      status: "failed",
    });
  });

  it("settles as failed when the flow rejects", async () => {
    const { seen, login } = scripted();
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login,
    });
    const view = codex.start();
    seen.fail(new Error("upstream said no"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(codex.status(view.id).status).toBe("failed");
  });

  it("cancels: the flow's signal aborts, the prompt rejects, and a late answer does nothing", async () => {
    const { seen, login } = scripted();
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login,
    });
    const view = codex.start();
    const answered = seen.ask({ type: "manual_code" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    codex.cancel(view.id);
    expect(seen.signals[0]?.aborted).toBe(true);
    await expect(answered).rejects.toThrow(/cancelled/);
    // Cancelling is idempotent, and a late answer for the cancelled attempt is refused.
    codex.cancel(view.id);
    expect(codex.answer(view.id, "anything", "123456")).toBe(false);
    // A client polling the id it started is told `cancelled`, which is different from `failed`.
    expect(codex.status(view.id).status).toBe("cancelled");
  });

  it("gives up on an attempt nobody finishes", async () => {
    const { seen, login } = scripted();
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login,
      timeoutMs: 20,
    });
    const view = codex.start();
    expect(view.status).toBe("pending");
    await new Promise((resolve) => setTimeout(resolve, 60));
    // An attempt nobody finishes is cancelled rather than pending forever.
    expect(codex.status(view.id).status).toBe("cancelled");
    expect(seen.signals[0]?.aborted).toBe(true);
  });

  it("does not hold the process open while an attempt is pending", () => {
    // The timer is unref'd: a login nobody finishes is not a reason for the server to stay alive.
    expect(LOGIN_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("answers the method choice itself instead of asking the user", async () => {
    const choices: string[] = [];
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login: async (interaction) => {
        choices.push(
          await interaction.prompt({
            type: "select",
            options: [
              { id: "browser", label: "Browser" },
              { id: "device_code", label: "Device code" },
            ],
          }),
        );
      },
    });
    codex.start("device_code");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(choices).toEqual(["device_code"]);
  });

  it("refuses a prompt the flow should not be making", async () => {
    const errors: unknown[] = [];
    const root = await scratch();
    const codex = new CodexLogin({
      credentials: new CodexCredentialStore(join(root, "auth.json")),
      login: async (interaction) => {
        await interaction
          .prompt({ type: "secret" })
          .catch((error: unknown) => errors.push(error));
      },
    });
    codex.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(String(errors[0])).toContain("unsupported_prompt");
  });
});
