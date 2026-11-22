import { expect, open, test } from "nsh/test";

// The agent editor's Runtime field and Settings › Runtimes over the scripted host of
// fixtures/runtimes.tsx: no real runtime or account is asked.

const sizes = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

for (const [width, height] of sizes) {
  test(`the picker says in a few words why a runtime cannot be picked at ${width}`, async () => {
    const app = await open("./fixtures/runtimes.tsx", {
      width,
      height,
      locale: "en-US",
      urlScheme: "eta://fixture/new",
    });
    await app.press("label:Runtime");
    const texts = app.texts();
    for (const [runtime, reason] of [
      ["Codex", "Not signed in"],
      ["OpenCode", "Probe timed out (30s)"],
      ["Pi", "Not installed"],
      ["Gemini CLI", "Probe failed"],
    ]) {
      expect(texts[texts.indexOf(runtime) + 1]).toBe(reason);
      expect(app.enabled(`label:${runtime}`)).toBe(false);
    }
    expect(app.enabled("label:Claude Code")).toBe(true);
    // The probe's own words are never an option's.
    expect(texts.join("\n")).not.toContain("timed out after 30000ms");
  });
}

test("Details opens each runtime's own words under the field", async () => {
  const app = await open("./fixtures/runtimes.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/new",
  });
  expect(app.texts().join("\n")).not.toContain("timed out after 30000ms");
  await app.press("label:Details");
  const words = app.texts().join("\n");
  expect(words).toContain(
    "oar: `opencode models --verbose` timed out after 30000ms",
  );
  expect(words).toContain("pi: command not found on PATH");
  expect(words).toContain(
    "spawn gemini --experimental-acp: exited with code 1",
  );
  await app.press("label:Details");
  expect(app.texts().join("\n")).not.toContain("timed out after 30000ms");
});

test("Retry asks the machine again with fresh: true", async () => {
  const app = await open("./fixtures/runtimes.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/new",
  });
  expect(app.texts()[0]).toBe("agents.runtimes {}");
  await app.press("label:Retry");
  await app.waitFor('text:agents.runtimes {}\nagents.runtimes {"fresh":true}');
  // The fresh answer replaces the list: OpenCode answered this time.
  await app.press("label:Runtime");
  expect(app.enabled("label:OpenCode")).toBe(true);
});

test("an agent on a runtime that is signed out says how to sign it in", async () => {
  const app = await open("./fixtures/runtimes.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
    urlScheme: "eta://fixture/editor",
  });
  expect(app.texts()).toContain(
    "Codex isn't signed in: run codex login in a terminal on its machine, then retry.",
  );
  await app.press("label:See it in Runtimes");
  expect(app.texts()[0]).toBe("open Runtimes");
});

for (const [width, height] of sizes) {
  test(`Settings › Runtimes lists every machine's runtimes at ${width}`, async () => {
    const app = await open("./fixtures/runtimes.tsx", {
      width,
      height,
      locale: "en-US",
    });
    const texts = app.texts();
    const after = (heading: string) => texts.slice(texts.indexOf(heading));
    expect(texts.indexOf("studio")).toBeLessThan(texts.indexOf("gpu-box"));
    expect(texts.indexOf("gpu-box")).toBeLessThan(texts.indexOf("attic"));
    expect(after("studio")).toContain("primary · 5 runtimes");
    expect(after("gpu-box")).toContain("2 runtimes");
    for (const runtime of [
      "Claude Code, Available",
      "Codex, Not signed in",
      "OpenCode, Probe timed out (30s)",
      "Pi, Not installed",
      "Gemini CLI, Probe failed",
    ])
      expect(app.count(`label:${runtime}`)).toBeGreaterThan(0);
    expect(app.count("label:Codex, Available")).toBe(1);
    expect(texts).toContain(
      "The runtimes on attic are listed here once it's back online.",
    );
    expect(texts).toContain("Built-in · v2.1.311");
    expect(texts).toContain("External agent");
  });
}

test("an open runtime shows its sign-in, plan usage, models and token usage", async () => {
  const app = await open("./fixtures/runtimes.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  await app.press("label:Claude Code, Available >> nth=0");
  await app.waitFor("text:Signed in · ada@example.com · max · claude.ai");
  const texts = app.texts();
  expect(texts).toContain("5h · 42% used");
  expect(texts).toContain("7d · 18% used");
  expect(texts).toContain(
    "Sonnet · sonnet · default · Thinking: low / medium / high",
  );
  expect(texts).toContain(
    "48.2k tokens in the last 7 days, every machine together",
  );
  expect(texts.at(0)).toContain('agents.runtimeAccount {"runtime":"claude"}');

  await app.press("label:Codex, Not signed in");
  await app.waitFor(
    "text:Not signed in. Run codex login in a terminal on studio to sign in.",
  );
  expect(app.texts()).toContain("Sign in again to read usage · not_logged_in");
});

test("Check again asks that machine with fresh: true", async () => {
  const app = await open("./fixtures/runtimes.tsx", {
    width: 1440,
    height: 900,
    locale: "en-US",
  });
  expect(app.count("label:OpenCode, Probe timed out (30s)")).toBe(1);
  await app.press("label:Check again >> nth=1");
  expect(app.texts()[0]).toContain(
    'agents.runtimes {"fresh":true,"machineId":"m-gpu"}',
  );
  await app.press("label:Check again >> nth=0");
  await app.waitFor("label:OpenCode, Available");
  expect(app.texts()[0]).toContain('agents.runtimes {"fresh":true}');
});
