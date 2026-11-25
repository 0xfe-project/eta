import { expect, open, test } from "nsh/test";

const WINDOW = { width: 900, height: 700 };
const LATE = "./fixtures/plugins-composio-agent-late.tsx";
const OLD_HOST = "./fixtures/plugins-composio-agent-late-old-host.tsx";
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

// The host makes a toolkit's session after the page was opened, and says so by changing the
// `toolkits` section of its `plugins` target. The list follows that section.
test("a toolkit the host pushes after the list was shown is listed, without the list being shown again", async () => {
  const app = await open(LATE, WINDOW);
  await app.waitFor("text:on-plugin");
  expect(app.shows("label:@composio/gmail")).toBe(false);
  await app.press("label:host finishes sync");
  await settle();
  expect(app.shows("label:@composio/gmail")).toBe(true);
});

test("a list that is shown again has the toolkit the host pushed meanwhile", async () => {
  const app = await open(LATE, WINDOW);
  await app.waitFor("text:on-plugin");
  await app.press("label:host finishes sync");
  await settle();
  await app.press("label:hide list");
  await app.press("label:show list");
  await app.waitFor("label:@composio/gmail");
});

// An entry says which provider it comes from. The list keeps the ones it knows, and a provider it does
// not know is left out, not drawn as a broken card.
test("a toolkit of a provider the client does not know is not listed", async () => {
  const app = await open(LATE, WINDOW);
  await app.waitFor("text:on-plugin");
  await app.press("label:host lists two providers");
  await settle();
  expect(app.shows("label:@composio/gmail")).toBe(true);
  expect(app.shows("label:@nango/slack")).toBe(false);
});

// A host older than the section has nothing to follow: the list reads `composioPlugins` when it is
// shown, as it always did.
test("on a host without the section, the list asks when it is shown and not before", async () => {
  const app = await open(OLD_HOST, WINDOW);
  await app.waitFor("text:asked:1");
  expect(app.shows("label:@composio/gmail")).toBe(false);
  await app.press("label:host finishes sync");
  await settle();
  expect(app.shows("label:@composio/gmail")).toBe(false);
  expect(app.shows("text:asked:1")).toBe(true);
});

test("on a host without the section, a list that is shown again asks the host again, and then has the toolkit", async () => {
  const app = await open(OLD_HOST, WINDOW);
  await app.waitFor("text:asked:1");
  await app.press("label:host finishes sync");
  await settle();
  await app.press("label:hide list");
  await app.press("label:show list");
  await app.waitFor("label:@composio/gmail");
  expect(app.shows("text:asked:2")).toBe(true);
});
