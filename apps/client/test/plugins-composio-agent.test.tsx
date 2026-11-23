import { expect, open, test } from "nsh/test";

const WINDOW = { width: 900, height: 700 };

test("connected toolkits are listed after the installed plugins, each as its own choice", async () => {
  const app = await open("./fixtures/plugins-composio-agent-two.tsx", WINDOW);
  await app.waitFor("label:@composio/gmail");
  expect(app.shows("on-plugin")).toBe(true);
  expect(app.shows("label:@composio/ghost")).toBe(true);
  expect(app.shows("chosen:")).toBe(true);
});

test("ticking a ready toolkit adds it to the agent's plugins, and ticking it again removes it", async () => {
  const app = await open("./fixtures/plugins-composio-agent-two.tsx", WINDOW);
  await app.waitFor("label:@composio/gmail");
  await app.press("label:@composio/gmail");
  await app.waitFor("text:chosen:@composio/gmail");
  await app.press("label:@composio/gmail");
  await app.waitFor("text:chosen:");
  expect(app.shows("text:chosen:@composio/gmail")).toBe(false);
});

test("a toolkit that did not check out cannot be ticked, and says why", async () => {
  const app = await open("./fixtures/plugins-composio-agent-two.tsx", WINDOW);
  await app.waitFor("label:@composio/ghost");
  expect(app.count("id:composio-plugin-error")).toBe(1);
  await app.press("label:@composio/ghost");
  expect(app.shows("text:chosen:@composio/ghost")).toBe(false);
});

test("a toolkit the agent has, and that no longer checks out, can still be unticked", async () => {
  const app = await open(
    "./fixtures/plugins-composio-agent-chosen.tsx",
    WINDOW,
  );
  await app.waitFor("text:chosen:@composio/ghost");
  await app.press("label:@composio/ghost");
  await app.waitFor("text:chosen:");
  expect(app.shows("text:chosen:@composio/ghost")).toBe(false);
});

test("a toolkit switched off for every agent says so", async () => {
  const app = await open("./fixtures/plugins-composio-agent-off.tsx", WINDOW);
  await app.waitFor("label:@composio/gmail");
  expect(app.count("id:composio-plugin-off")).toBe(1);
});

test("an agent on an external runtime cannot take a toolkit, and the row says why", async () => {
  const app = await open(
    "./fixtures/plugins-composio-agent-external.tsx",
    WINDOW,
  );
  await app.waitFor("label:@composio/gmail");
  expect(app.count("id:composio-plugin-external")).toBe(1);
  // A toolkit already in its list can be taken out; one that is not cannot be put in.
  await app.press("label:@composio/gmail");
  await app.waitFor("text:chosen:");
  expect(app.shows("text:chosen:@composio/gmail")).toBe(false);
  await app.press("label:@composio/gmail");
  expect(app.shows("text:chosen:@composio/gmail")).toBe(false);
});

test("no connected toolkit, or a host that does not know the call: only the installed plugins", async () => {
  const none = await open("./fixtures/plugins-composio-agent-none.tsx", WINDOW);
  await none.waitFor("text:on-plugin");
  expect(none.count("id:composio-plugin-error")).toBe(0);
  const unknown = await open(
    "./fixtures/plugins-composio-agent-unknown.tsx",
    WINDOW,
  );
  await unknown.waitFor("text:on-plugin");
  expect(unknown.shows("@composio")).toBe(false);
});
