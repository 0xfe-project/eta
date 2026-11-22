import { expect, open, test } from "nsh/test";

const OPEN = { width: 1000, height: 800 };

test("toolkits are listed with their source and sign-in type", async () => {
  const app = await open("./fixtures/composio-ready.tsx", OPEN);
  expect(app.shows("Gmail")).toBe(true);
  expect(app.shows("Exa")).toBe(true);
  expect(app.shows("From Composio")).toBe(true);
  expect(app.shows("OAuth")).toBe(true);
});

test("without a key the source says it needs one, and the other sources still show", async () => {
  const app = await open("./fixtures/composio-needs-key.tsx", OPEN);
  expect(app.shows("Composio needs an API key")).toBe(true);
  expect(app.shows("Set one in Settings → Plugins to list its toolkits. The other sources are not affected.")).toBe(true);
  expect(app.shows("The catalog could not be read")).toBe(false);
  expect(app.shows("From A")).toBe(true);
});

test("a rejected key shows that source's own reason", async () => {
  const app = await open("./fixtures/composio-key-rejected.tsx", OPEN);
  expect(app.shows("Composio rejected the API key")).toBe(true);
  expect(app.shows("Composio needs an API key")).toBe(false);
  expect(app.shows("From A")).toBe(true);
});

test("the detail tells the two sign-in types apart, and never says Installed", async () => {
  const app = await open("./fixtures/composio-ready.tsx", OPEN);
  await app.press("label:Exa");
  expect(app.shows("API key type: on Composio's page you paste your own key for this app.")).toBe(true);
  expect(app.shows("Installed")).toBe(false);
  const oauth = await open("./fixtures/composio-ready.tsx", OPEN);
  await oauth.press("label:Gmail");
  expect(oauth.shows("OAuth type: you are sent to the app's authorization page to sign in and allow access.")).toBe(true);
  const none = await open("./fixtures/composio-ready.tsx", OPEN);
  await none.press("label:Hacker News");
  expect(none.shows("This toolkit needs no sign-in, so there is nothing to authorize. Connect still opens Composio's page for it.")).toBe(true);
});

test("Connect calls composioLink and opens the address it returns, with no confirmation", async () => {
  const app = await open("./fixtures/composio-ready.tsx", OPEN);
  await app.press("label:Gmail");
  await app.press("label:Connect");
  await app.waitFor("text:called:composioLink:gmail opened:https://connect.composio.test/gmail");
  expect(app.shows("Connect Gmail?")).toBe(false);
});

test("a refused link says why in the detail and opens nothing", async () => {
  const app = await open("./fixtures/composio-link-fails.tsx", OPEN);
  await app.press("label:Gmail");
  await app.press("label:Connect");
  await app.waitFor("text:Composio refused the link");
  // The log holds the call alone: nothing was opened.
  expect(app.shows("text:called:composioLink:gmail")).toBe(true);
});
