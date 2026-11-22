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
  expect(app.shows("No plugin sources")).toBe(true);
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
