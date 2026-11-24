import { expect, open, test } from "nsh/test";

const WINDOW = { width: 900, height: 700 };

/** Whether a press was turned down: the control is disabled. */
async function refused(press: Promise<unknown>) {
  try {
    await press;
    return false;
  } catch (error) {
    return String(error).includes("disabled");
  }
}

test("connected toolkits are listed after the installed plugins, each as its own choice", async () => {
  const app = await open("./fixtures/plugins-composio-agent-two.tsx", WINDOW);
  await app.waitFor("label:@composio/gmail");
  expect(app.shows("on-plugin")).toBe(true);
  expect(app.shows("label:@composio/ghost")).toBe(true);
  expect(app.shows("text:chosen:")).toBe(true);
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
  await expect(refused(app.press("label:@composio/ghost"))).resolves.toBe(true);
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
  // As on an installed plugin's row: on the line of the name, at the right end, above "Composio toolkit".
  const name = app.layout("text:@composio/gmail")!;
  const sub = app.layout("text:Composio toolkit")!;
  const off = app.layout("id:composio-plugin-off")!;
  expect(off.y < name.y + name.height && off.y + off.height > name.y).toBe(
    true,
  );
  expect(off.y + off.height).toBeLessThanOrEqual(sub.y + 1);
  expect(off.x).toBeGreaterThanOrEqual(name.x);
});

test("an agent on an external runtime can take a ready toolkit, and the row has no warning", async () => {
  const app = await open(
    "./fixtures/plugins-composio-agent-external.tsx",
    WINDOW,
  );
  await app.waitFor("label:@composio/gmail");
  expect(app.count("id:composio-plugin-external")).toBe(0);
  expect(app.shows("Not available to agents on an external runtime.")).toBe(
    false,
  );
  await app.press("label:@composio/gmail");
  await app.waitFor("text:chosen:@composio/gmail");
  await app.press("label:@composio/gmail");
  await app.waitFor("text:chosen:");
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
