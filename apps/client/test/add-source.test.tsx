import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

// Adding a model source, as a user goes through it: pick a source, connect (a key, an address, a
// sign-in), pick the models, and what the host is asked to save. The fixture's host is scripted
// (see fixtures/add-source.tsx); its calls are listed on the page.

const fixture = "./fixtures/add-source.tsx";
const sizes = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

async function settings(width = 1440, height = 900, ending = "") {
  const app = await open(fixture, {
    width,
    height,
    locale: "en-US",
    ...(ending ? { urlScheme: `eta://fixture/${ending}` } : {}),
  });
  await app.waitFor("label:Add Eta Token Plan");
  return app;
}

/** The host calls so far, `target.action args`. */
const calls = (app: App) =>
  app.texts().filter((text) => /^(?:providers|llm)\.\w+ /.test(text));
const called = (app: App, action: string) =>
  calls(app).filter((call) => call.startsWith(`${action} `));

async function addSource(app: App, source: string) {
  await app.press("label:Add source");
  await app.press(`label:${source}`);
}

for (const [width, height] of sizes) {
  test(`a key source at ${width}: key, models, saved with the ticked ones`, async () => {
    const app = await settings(width, height);
    await app.press("label:Add Eta Token Plan");
    expect(app.shows("label:Eta Token Plan API key")).toBe(true);
    expect(app.texts()).toContain("Get a key");
    expect(app.enabled("label:Connect")).toBe(false);

    await app.type("label:Eta Token Plan API key", "sk-good");
    await app.press("label:Connect");
    await app.waitFor("text:2 selected");
    // Current models start ticked, the deprecated one not; one the client cannot speak is shown.
    expect(app.texts()).toContain("Not supported yet (Anthropic protocol)");
    await app.press("label:Alpha Small");
    expect(app.texts()).toContain("1 selected");

    await app.press("label:Done");
    const [save] = called(app, "providers.save");
    expect(save).toContain('"id":"eta-token-plan"');
    expect(save).toContain('"name":"Eta Token Plan"');
    expect(save).toContain('"apiKey":"sk-good"');
    expect(save).toContain('"alpha-large"');
    expect(save).not.toContain('"alpha-small"');
    expect(save).not.toContain('"alpha-old"');
    expect(called(app, "providers.check")).toEqual([
      'providers.check {"id":"eta-token-plan"}',
    ]);
    expect(app.shows("label:Done")).toBe(false);
  });
}

test("a refused key stays on Connect with the reason, and saves nothing", async () => {
  const app = await settings();
  await addSource(app, "DeepSeek");
  await app.type("label:DeepSeek API key", "sk-wrong");
  await app.press("label:Connect");
  await app.waitFor("text:Invalid key: the provider refused it.");
  expect(app.shows("label:DeepSeek API key")).toBe(true);
  expect(app.value("label:DeepSeek API key")).toBe("sk-wrong");
  expect(called(app, "providers.save")).toEqual([]);
});

test("Back returns a step and Cancel leaves without saving", async () => {
  const app = await settings();
  await addSource(app, "OpenRouter");
  await app.press("label:Back");
  expect(app.shows("label:Google AI Studio")).toBe(true);
  await app.press("label:Moonshot (China)");
  await app.type("label:Moonshot (China) API key", "sk-good");
  await app.press("label:Connect");
  await app.waitFor("text:2 selected");
  await app.press("label:Back");
  expect(app.value("label:Moonshot (China) API key")).toBe("sk-good");
  await app.press("label:Cancel");
  expect(app.shows("label:Moonshot (China) API key")).toBe(false);
  expect(called(app, "providers.save")).toEqual([]);
});

test("Command Code names its key page and what its plans can use", async () => {
  const app = await settings();
  await addSource(app, "Command Code");
  expect(app.texts()).toContain("Create a key in Studio");
  expect(app.texts().join(" ")).toContain("The Go plan has no API access");
});

test("a custom endpoint: its address, its protocol, an optional key", async () => {
  const app = await settings();
  await addSource(app, "OpenAI-compatible API");
  expect(app.enabled("label:Connect")).toBe(false);
  await app.type("label:URL", "http://down/v1");
  await app.press("label:Connect");
  await app.waitFor(
    "text:Could not reach the model API. Check the URL and the network.",
  );

  await app.clear("label:URL");
  await app.type("label:URL", "https://llm.example.com/v1");
  await app.press("label:Protocol");
  await app.press("label:Responses");
  await app.press("label:Connect");
  await app.waitFor("text:2 selected");
  expect(called(app, "providers.discover").at(-1)).toContain(
    '"kind":"openai-responses"',
  );
  await app.press("label:Done");
  const [save] = called(app, "providers.save");
  expect(save).toContain('"name":"llm.example.com"');
  expect(save).toContain('"kind":"openai-responses"');
  expect(save).not.toContain("apiKey");
});

test("local models start at Ollama's address and are named for it", async () => {
  const app = await settings();
  await addSource(app, "Local models");
  expect(app.value("label:URL")).toBe("http://127.0.0.1:11434/v1");
  await app.press("label:Connect");
  await app.waitFor("text:2 selected");
  await app.press("label:Done");
  expect(called(app, "providers.save")[0]).toContain('"name":"Ollama"');
});

for (const [width, height] of sizes) {
  test(`a subscription at ${width}: the code, polling until approved, the account's models`, async () => {
    const app = await settings(width, height, "approve");
    const backs = app.count("label:Back");
    await addSource(app, "Codex");
    await app.waitFor("text:Codex is connected, with 2 models.");
    expect(called(app, "llm.loginStart")).toEqual([
      'llm.loginStart {"connector":"codex"}',
    ]);
    expect(called(app, "llm.loginPoll").length).toBeGreaterThan(0);
    expect(app.texts()).toContain("GPT-5.4 mini");
    // Nothing to go back to: the account is linked.
    expect(app.count("label:Back")).toBe(backs);
    await app.press("label:Done");
    expect(app.shows("text:Codex is connected, with 2 models.")).toBe(false);
    expect(called(app, "llm.loginCancel")).toEqual([]);
  });
}

test("a subscription sign-in shows its code while it waits, and Cancel ends it", async () => {
  const app = await settings();
  await addSource(app, "Grok");
  await app.waitFor("label:Code ABCD-1234");
  expect(app.texts().join(" ")).toContain("Waiting for authorization");
  await app.waitUntil(() => called(app, "llm.loginPoll").length > 0);
  await app.press("label:Cancel");
  expect(called(app, "llm.loginCancel")).toEqual([
    'llm.loginCancel {"id":"login-xai"}',
  ]);
  expect(app.shows("label:Code ABCD-1234")).toBe(false);
});

test("a refused sign-in says so, and Retry starts a new code", async () => {
  const app = await settings(1440, 900, "deny");
  await addSource(app, "Codex");
  await app.waitFor("text:Login failed. Try again.");
  expect(app.shows("label:Code ABCD-1234")).toBe(false);
  await app.press("label:Retry");
  expect(called(app, "llm.loginStart")).toHaveLength(2);
});

test("a gateway key is checked with the provider before it is kept", async () => {
  const app = await settings();
  await addSource(app, "Google AI Studio");
  await app.type("label:Google AI Studio API key", "bad-key");
  await app.press("label:Connect");
  await app.waitFor("text:The API key is invalid. Enter it again.");
  await app.clear("label:Google AI Studio API key");
  await app.type("label:Google AI Studio API key", "good-key");
  await app.press("label:Connect");
  await app.waitFor("text:Google AI Studio is connected, with 0 models.");
  expect(called(app, "llm.loginSubmit").at(-1)).toContain(
    '"apiKey":"good-key"',
  );
});
