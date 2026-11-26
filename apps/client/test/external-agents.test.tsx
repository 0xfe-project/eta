import type { App } from "nsh/test";
import { expect, open, test } from "nsh/test";

// Adding and editing external agents in Settings › External agents, over the scripted host of
// fixtures/external-agents.tsx (studio and gpu-box online, attic offline).

const sizes = [
  [1440, 900],
  [1024, 768],
  [390, 844],
] as const;

async function settings(width: number, height: number) {
  const app = await open("./fixtures/external-agents.tsx", {
    width,
    height,
    locale: "en-US",
  });
  await app.waitFor("text:Fake Agent");
  return app;
}

/** Opens the edit form of the agent named `label` from its row's menu. */
async function edit(app: App, label: string) {
  // The second view with its label is the row's ⋯ menu; the first is the row.
  await app.press(`label:${label} >> nth=1`);
  await app.press("label:Edit");
}

for (const [width, height] of sizes) {
  test(`an added agent is listed at ${width}`, async () => {
    const app = await settings(width, height);
    await app.press("label:Add agent");
    await app.type("label:Name", "Gemini CLI");
    // The id follows the name.
    expect(app.value("label:ID")).toBe("gemini-cli");
    await app.type("label:Command", "fake-acp");
    await app.type("label:Arguments", "--experimental-acp");
    await app.press("label:Test");
    await app.waitFor("text:Gemini CLI answered: Fake Agent 0.0.1");
    await app.press("label:Add");
    await app.waitUntil(() => !app.shows("label:Add external agent"));
    expect(app.texts()).toContain("Gemini CLI");
    expect(app.texts()).toContain("fake-acp --experimental-acp");
    expect(app.texts()).toContain("primary · 2 agents");
  });

  test(`an edited agent shows its new name at ${width}`, async () => {
    const app = await settings(width, height);
    await edit(app, "Fake Agent");
    expect(app.texts()).toContain("Edit Fake Agent");
    await app.clear("label:Name");
    await app.type("label:Name", "Fake Agent Pro");
    // An edit keeps its id unless it is changed by hand.
    expect(app.value("label:ID")).toBe("fake");
    await app.press("label:Save");
    await app.waitUntil(() => !app.shows("label:Edit Fake Agent"));
    expect(app.texts()).toContain("Fake Agent Pro");
    expect(app.texts()).not.toContain("Fake Agent");
  });
}

test("an edit can change the id, and the open detail follows it", async () => {
  const app = await settings(1440, 900);
  await app.press("label:Fake Agent >> nth=0");
  expect(app.texts()).toContain("acp.fake");
  await app.press("label:Edit");
  await app.clear("label:ID");
  await app.type("label:ID", "fake-two");
  await app.press("label:Save");
  await app.waitUntil(() => !app.shows("label:Edit Fake Agent"));
  expect(app.texts()).toContain("acp.fake-two");
});

test("an id the machine already has is refused in the form", async () => {
  const app = await settings(1440, 900);
  await app.press("label:Add agent");
  await app.type("label:Name", "Another");
  await app.clear("label:ID");
  await app.type("label:ID", "fake");
  await app.type("label:Command", "fake-acp");
  await app.press("label:Add");
  expect(app.texts()).toContain(
    "Another external agent on this machine already has this ID.",
  );
  expect(app.shows("label:Add external agent")).toBe(true);
  expect(app.texts().filter((text) => text === "Another")).toHaveLength(0);
});

test("empty fields and a bad env line say what they need", async () => {
  const app = await settings(1440, 900);
  await app.press("label:Add agent");
  await app.press("label:Add");
  const texts = app.texts();
  expect(texts).toContain("Give it a name.");
  expect(texts).toContain("Give it an ID.");
  expect(texts).toContain("Enter the command that starts it.");
  await app.type("label:Name", "Gemini CLI");
  await app.type("label:Command", "gemini");
  await app.type("label:Environment variables", "GEMINI_API_KEY");
  await app.press("label:Add");
  expect(app.texts()).toContain("Line 1: write it as KEY=VALUE.");
});

test("a failed test says why, and nothing is saved", async () => {
  const app = await settings(1440, 900);
  await app.press("label:Add agent");
  await app.type("label:Name", "Gemini CLI");
  await app.type("label:Command", "gemini");
  await app.press("label:Test");
  await app.waitFor("text:Gemini CLI: Not installed");
  expect(app.texts()).toContain("gemini is not installed");
});

test("an offline machine's agents can't be saved", async () => {
  const app = await settings(1440, 900);
  // Not offered as a place for a new agent.
  await app.press("label:Add agent");
  await app.press("label:Machine");
  expect(app.enabled("label:attic · Offline")).toBe(false);
  await app.press("label:Machine");
  await app.press("label:Cancel");
  // An agent the host listed before attic went offline opens, but can't be tested or saved.
  await edit(app, "Goose");
  expect(app.texts()).toContain(
    "attic is offline. Its external agents can be tested and changed once it's back online.",
  );
  expect(app.enabled("label:Save")).toBe(false);
  expect(app.enabled("label:Test")).toBe(false);
});

test("a removed agent leaves the list", async () => {
  const app = await settings(1440, 900);
  await app.press("label:Fake Agent >> nth=0");
  await app.press("label:Remove");
  expect(app.texts()).toContain("Remove Fake Agent from studio (primary)?");
  await app.press("label:Remove >> nth=1");
  await app.waitUntil(() => !app.texts().includes("Fake Agent"));
  expect(app.texts()).toContain("Claude Code");
});
