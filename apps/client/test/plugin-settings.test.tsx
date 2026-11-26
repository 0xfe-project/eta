import { expect, open, test } from "nsh/test";

const URL_FIELD = "label:Catalog address (http or https)";
const PROXY_FIELD = "label:Proxy prefix (http or https)";
const OPEN = { width: 900, height: 800 };

test("the sources are listed, with the address under a name", async () => {
  const app = await open("./fixtures/plugin-settings.tsx", OPEN);
  expect(app.shows("Cursor")).toBe(true);
  expect(app.shows("text:https://cursor.test/marketplace.json")).toBe(true);
  expect(app.shows("text:https://plain.test/marketplace.json")).toBe(true);
});

test("every source has a switch", async () => {
  const app = await open("./fixtures/plugin-settings.tsx", OPEN);
  await app.press("label:Use Cursor");
  await app.press("label:Use https://plain.test/marketplace.json");
  expect(app.shows("Cursor")).toBe(true);
});

test("an address that is not http(s) is refused", async () => {
  const app = await open("./fixtures/plugin-settings.tsx", OPEN);
  await app.type(URL_FIELD, "ftp://nope.test/x.json");
  await app.press("label:Add source");
  expect(app.shows("Enter an http or https address.")).toBe(true);
});

test("an address that is in the list already is refused", async () => {
  const app = await open("./fixtures/plugin-settings.tsx", OPEN);
  await app.type(URL_FIELD, "https://plain.test/marketplace.json");
  await app.press("label:Add source");
  expect(app.shows("That address is in the list already.")).toBe(true);
});

test("a source is added with its name, and removed; an emptied list says so", async () => {
  const app = await open("./fixtures/plugin-settings.tsx", OPEN);
  await app.type("label:Name (optional)", "Mine");
  await app.type(URL_FIELD, "https://mine.test/marketplace.json");
  await app.press("label:Add source");
  expect(app.shows("Mine")).toBe(true);
  expect(app.shows("text:https://mine.test/marketplace.json")).toBe(true);
  await app.press("label:Remove source Mine");
  expect(app.shows("text:https://mine.test/marketplace.json")).toBe(false);
  await app.press("label:Remove source Cursor");
  await app.press("label:Remove source https://plain.test/marketplace.json");
  expect(app.shows("No plugin sources yet")).toBe(true);
});

test("a proxy prefix that is not http(s) is refused", async () => {
  const app = await open("./fixtures/plugin-settings.tsx", OPEN);
  expect(app.shows("GitHub proxy")).toBe(true);
  await app.type(PROXY_FIELD, "proxy.test");
  await app.press("label:Save proxy");
  expect(app.shows("Enter an http or https address, or leave it empty.")).toBe(
    true,
  );
});

test("a proxy prefix is saved, and nothing is refused", async () => {
  const app = await open("./fixtures/plugin-settings.tsx", OPEN);
  await app.type(PROXY_FIELD, "https://proxy.test");
  await app.press("label:Save proxy");
  expect(app.shows("Enter an http or https address, or leave it empty.")).toBe(
    false,
  );
});

/** The empty state is drawn inside a scrolling column, so it has to take the height of what it says: the form under it starts below its text. */
for (const [name, size] of [
  ["desktop", OPEN],
  ["phone", { width: 390, height: 800 }],
] as const) {
  test(`no sources: the empty state is as tall as its text and the form starts below it (${name})`, async () => {
    const app = await open("./fixtures/plugin-settings.tsx", size);
    await app.press("label:Remove source Cursor");
    await app.press("label:Remove source https://plain.test/marketplace.json");
    const title = app.layout("text:No plugin sources yet")!;
    const form = app.layout("label:Name (optional)")!;
    expect(title).toBeDefined();
    expect(form).toBeDefined();
    expect(title.y + title.height).toBeLessThanOrEqual(form.y);
    const hint = app.layout(
      "text:Add the address of a marketplace.json to browse its plugins.",
    )!;
    expect(hint).toBeDefined();
    expect(hint.y + hint.height).toBeLessThanOrEqual(form.y);
  });
}

const KEY_FIELD = "label:Composio API key";

test("the Composio source has a switch but no Remove, and no key is set at first", async () => {
  const app = await open("./fixtures/plugin-settings-composio.tsx", OPEN);
  expect(app.shows("label:Use Composio")).toBe(true);
  expect(app.shows("label:Remove source Composio")).toBe(false);
  expect(app.shows("No key is set")).toBe(true);
});

test("a saved key shows only that it is set, and can be replaced or cleared", async () => {
  const app = await open("./fixtures/plugin-settings-composio.tsx", OPEN);
  await app.type(KEY_FIELD, "ak_secret_value");
  await app.press("label:Save key");
  await app.waitFor("text:A key is set");
  expect(app.shows("ak_secret_value")).toBe(false);
  expect(app.shows("label:Replace key")).toBe(true);
  await app.press("label:Clear key");
  await app.waitFor("text:No key is set");
});

test("saving an empty key asks for one", async () => {
  const app = await open("./fixtures/plugin-settings-composio.tsx", OPEN);
  await app.press("label:Save key");
  expect(app.shows("Enter a key first.")).toBe(true);
});

test("the Composio switch is off and cannot be used until a key is set, and says why", async () => {
  const app = await open("./fixtures/plugin-settings-composio.tsx", OPEN);
  await app.waitFor("text:No key is set");
  expect(app.enabled("label:Use Composio")).toBe(false);
  expect(app.shows("Enter an API key first.")).toBe(true);
  await app.type(KEY_FIELD, "ak_secret_value");
  await app.press("label:Save key");
  await app.waitFor("text:A key is set");
  expect(app.enabled("label:Use Composio")).toBe(true);
  expect(app.shows("Enter an API key first.")).toBe(false);
  await app.press("label:Clear key");
  await app.waitFor("text:No key is set");
  expect(app.enabled("label:Use Composio")).toBe(false);
  expect(app.shows("Enter an API key first.")).toBe(true);
});

// The page asks the host for its sources when it opens; until the answer comes it knows nothing, which is not "no sources".
test("before the host has answered, the page does not say there are no sources, nor show an empty proxy", async () => {
  const app = await open("./fixtures/plugin-settings-held.tsx", OPEN);
  expect(app.shows("Plugin sources")).toBe(true);
  expect(app.shows("No plugin sources yet")).toBe(false);
  expect(app.count(PROXY_FIELD)).toBe(0);
});

test("once the host has answered with sources, they are listed and the proxy field is there", async () => {
  const app = await open("./fixtures/plugin-settings-held.tsx", OPEN);
  await app.press("label:answer with sources");
  await app.waitFor("text:Cursor");
  expect(app.shows("No plugin sources yet")).toBe(false);
  expect(app.count(PROXY_FIELD)).toBe(1);
});

test("once the host has answered with no sources, the page says so", async () => {
  const app = await open("./fixtures/plugin-settings-held.tsx", OPEN);
  await app.press("label:answer with none");
  await app.waitFor("text:No plugin sources yet");
  expect(app.count(PROXY_FIELD)).toBe(1);
});

// The source is listed before the host has said whether it holds a key; until it does, the page knows nothing about the key either.
test("before the host has said whether a key is set, the page does not say one is needed, and the switch is not held off for it", async () => {
  const app = await open("./fixtures/plugin-settings-composio-held.tsx", OPEN);
  await app.waitFor("label:Use Composio");
  expect(app.shows("Enter an API key first.")).toBe(false);
  expect(app.shows("No key is set")).toBe(false);
  expect(app.shows("A key is set")).toBe(false);
  expect(app.enabled("label:Use Composio")).toBe(true);
});

test("once the host says no key is set, the page asks for one and the switch is held off", async () => {
  const app = await open("./fixtures/plugin-settings-composio-held.tsx", OPEN);
  await app.waitFor("label:Use Composio");
  await app.press("label:answer with no key");
  await app.waitFor("text:No key is set");
  expect(app.shows("Enter an API key first.")).toBe(true);
  expect(app.enabled("label:Use Composio")).toBe(false);
});

test("once the host says a key is set, the page says so and the switch can be used", async () => {
  const app = await open("./fixtures/plugin-settings-composio-held.tsx", OPEN);
  await app.waitFor("label:Use Composio");
  await app.press("label:answer with a key");
  await app.waitFor("text:A key is set");
  expect(app.shows("Enter an API key first.")).toBe(false);
  expect(app.enabled("label:Use Composio")).toBe(true);
});
