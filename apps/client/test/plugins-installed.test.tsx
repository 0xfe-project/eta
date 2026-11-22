import { expect, open, test } from "nsh/test";

test("each installed plugin card shows its own Enabled switch, and an off one says so", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 700 });
  expect(app.shows("on-plugin")).toBe(true);
  expect(app.shows("off-plugin")).toBe(true);
  expect(app.shows("Enabled")).toBe(true);
  expect(app.shows("Off for all agents")).toBe(true);
});

test("the Settings button of a card opens its servers and headers, with the Authorization default", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await app.press("label:Settings >> nth=0");
  expect(app.shows("Settings · remote-plugin")).toBe(true);
  expect(app.shows("MCP servers")).toBe(true);
  expect(app.shows("Request headers")).toBe(true);
  expect(app.shows("Add Authorization (Bearer token)")).toBe(true);
  expect(app.shows("Add custom header")).toBe(true);
  expect(app.shows("Save headers")).toBe(true);
});

test("a click on the card body opens the same panel; the switch does not", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await app.press("label:Enabled >> nth=1");
  expect(app.shows("Settings · ")).toBe(false);
  await app.press("label:remote-plugin");
  expect(app.shows("Settings · remote-plugin")).toBe(true);
});

test("a host too old to send headers says so instead of hiding the editor", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await app.press("label:old-host-plugin");
  expect(app.shows("This host is too old for request headers. Update the host to set them.")).toBe(true);
});

test("each server offers a Test connection button, and nothing is tested until it is pressed", async () => {
  const app = await open("./fixtures/plugins-installed.tsx", { width: 1100, height: 800 });
  await app.press("label:remote-plugin");
  expect(app.shows("Test connection")).toBe(true);
  expect(app.shows("Connected")).toBe(false);
  expect(app.shows("Failed")).toBe(false);
});
