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

test("a card in the group has the connected mark and both buttons, and no 'From Composio' line", async () => {
  const app = await open("./fixtures/plugins-composio-actions-ok.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item");
  expect(app.count("id:composio-connected")).toBe(2);
  expect(app.count("label:Re-authenticate")).toBe(2);
  expect(app.count("label:Disconnect")).toBe(2);
  expect(app.shows("From Composio")).toBe(false);
  // Without the buttons (no word from the host) the mark is still there and the line is still gone.
  const plain = await open("./fixtures/plugins-composio-two.tsx", DESKTOP);
  await plain.waitFor("id:composio-connected-item");
  expect(plain.count("id:composio-connected")).toBe(2);
  expect(plain.shows("From Composio")).toBe(false);
});

test("on a phone the rows have no 'From Composio' line either, and keep the mark and the buttons", async () => {
  const app = await open("./fixtures/plugins-composio-phone.tsx", PHONE);
  await app.waitFor("id:composio-connected-item");
  expect(app.shows("From Composio")).toBe(false);
  expect(app.count("id:composio-connected")).toBe(2);
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

test("each connected toolkit has Re-authenticate and Disconnect; with the source off, or no word from the host, it has neither", async () => {
  const app = await open("./fixtures/plugins-composio-actions-ok.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item");
  expect(app.count("label:Re-authenticate")).toBe(2);
  expect(app.count("label:Disconnect")).toBe(2);
  const off = await open(
    "./fixtures/plugins-composio-actions-off.tsx",
    DESKTOP,
  );
  await off.waitFor("id:composio-connected-item");
  expect(off.count("label:Re-authenticate")).toBe(0);
  expect(off.count("label:Disconnect")).toBe(0);
  const plain = await open("./fixtures/plugins-composio-two.tsx", DESKTOP);
  await plain.waitFor("id:composio-connected-item");
  expect(plain.count("label:Disconnect")).toBe(0);
});

test("Re-authenticate on an item goes through composioLink for that toolkit and opens its address", async () => {
  const app = await open("./fixtures/plugins-composio-actions-ok.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item");
  await app.press("label:Re-authenticate >> nth=0");
  await app.waitFor(
    "text:called:composioLink:gmail opened:https://connect.composio.test/gmail",
  );
});

test("Disconnect on an item asks first; Cancel deletes nothing; confirming removes only that item at once", async () => {
  const app = await open(
    "./fixtures/plugins-composio-actions-stale.tsx",
    DESKTOP,
  );
  await app.waitFor("id:composio-connected-item");
  await app.press("label:Disconnect >> nth=0");
  expect(app.shows("label:Delete on Composio")).toBe(true);
  await app.press("label:Cancel");
  expect(app.shows("composioDisconnect")).toBe(false);
  expect(app.count("id:composio-connected-item")).toBe(2);
  await app.press("label:Disconnect >> nth=0");
  await app.press("label:Delete on Composio");
  await app.waitFor("text:called:composioDisconnect:gmail");
  await app.waitFor("id:composio-connected-item >> nth=1", { state: "gone" });
  expect(app.count("id:composio-connected-item")).toBe(1);
  expect(app.shows("ghost")).toBe(true);
});

test("a failed Disconnect on an item says so and keeps the item", async () => {
  const app = await open(
    "./fixtures/plugins-composio-actions-fails.tsx",
    DESKTOP,
  );
  await app.waitFor("id:composio-connected-item");
  await app.press("label:Disconnect >> nth=0");
  await app.press("label:Delete on Composio");
  await app.waitFor("text:Could not disconnect. Try again later.");
  expect(app.count("id:composio-connected-item")).toBe(2);
});
