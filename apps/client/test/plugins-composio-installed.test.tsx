import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1100, height: 700 };
const PHONE = { width: 420, height: 800 };
const TABLET = { width: 900, height: 700 };

test("connected toolkits are a group after the plugins: one card each, named from the kept list or by their slug", async () => {
  const app = await open("./fixtures/plugins-composio-two.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item");
  expect(app.count("id:composio-connected-group")).toBe(1);
  expect(app.count("id:composio-connected-item")).toBe(2);
  expect(app.count("id:composio-connected")).toBe(2);
  expect(app.shows("Gmail")).toBe(true);
  expect(app.shows("ghost")).toBe(true);
  // The plugins are still there, and nothing was asked of Composio's list over the network.
  expect(app.shows("on-plugin")).toBe(true);
  expect(app.shows("off-plugin")).toBe(true);
  expect(app.shows("asked-the-network")).toBe(false);
});

test("only the connected toolkits are asked for by name, not the whole list", async () => {
  const app = await open("./fixtures/plugins-composio-two.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item");
  expect(app.shows("text:asked:gmail,ghost")).toBe(true);
  expect(app.shows("asked-the-network")).toBe(false);
});

test("the mark of a connected card is at its bottom right, on the source's line", async () => {
  const app = await open("./fixtures/plugins-composio-two.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item");
  const card = app.layout("id:composio-connected-item >> nth=0")!;
  const mark = app.layout("id:composio-connected >> nth=0")!;
  const from = app.layout("text:From Composio >> nth=0")!;
  expect(
    Math.abs(card.x + card.width - 13 - (mark.x + mark.width)),
  ).toBeLessThan(2);
  expect(
    Math.abs(card.y + card.height - 13 - (mark.y + mark.height)),
  ).toBeLessThan(2);
  expect(
    Math.abs(from.y + from.height / 2 - (mark.y + mark.height / 2)),
  ).toBeLessThan(3);
});

test("no connected toolkit: no group, and the plugins show as before", async () => {
  const app = await open("./fixtures/plugins-composio-none.tsx", DESKTOP);
  await app.waitFor("text:on-plugin");
  expect(app.count("id:composio-connected-group")).toBe(0);
  expect(app.count("id:composio-connected-item")).toBe(0);
});

test("when Composio cannot be asked: no group, no error, the plugins show as before", async () => {
  const app = await open("./fixtures/plugins-composio-fails.tsx", DESKTOP);
  await app.waitFor("text:on-plugin");
  expect(app.count("id:composio-connected-group")).toBe(0);
  expect(app.shows("Composio is down")).toBe(false);
  expect(app.shows("off-plugin")).toBe(true);
});

test("on a phone the group is rows, one per connected toolkit", async () => {
  const app = await open("./fixtures/plugins-composio-phone.tsx", PHONE);
  await app.waitFor("id:composio-connected-item");
  expect(app.count("id:composio-connected-item")).toBe(2);
  expect(app.count("id:composio-connected")).toBe(2);
  expect(app.shows("on-plugin")).toBe(true);
});

test("on a tablet the group is rows under the plugin list", async () => {
  const app = await open("./fixtures/plugins-composio-tablet.tsx", TABLET);
  await app.waitFor("id:composio-connected-item");
  expect(app.count("id:composio-connected-item")).toBe(2);
  expect(app.shows("on-plugin")).toBe(true);
});
