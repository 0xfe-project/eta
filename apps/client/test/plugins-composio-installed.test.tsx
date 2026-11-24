import { expect, open, test } from "nsh/test";

const DESKTOP = { width: 1100, height: 700 };
const PHONE = { width: 420, height: 800 };
const isFaint = (app: {
  viewStyle: (selector: string) => { opacity: number } | null;
}) =>
  (app.viewStyle("id:composio-connected-item >> nth=0")?.opacity ?? 1) < 0.6;
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
  expect(app.shows("From Composio")).toBe(false);
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

test("a connected toolkit that checked out has a switch for every agent; one that did not has none and says so", async () => {
  const app = await open("./fixtures/plugins-composio-virtual.tsx", DESKTOP);
  await app.waitFor("id:composio-plugin-switch");
  expect(app.count("id:composio-plugin-switch")).toBe(1);
  expect(app.count("label:Enabled: @composio/gmail")).toBe(1);
  expect(app.count("id:composio-plugin-error")).toBe(1);
  // Re-authenticate and Disconnect stay on both.
  expect(app.count("label:Re-authenticate")).toBe(2);
  expect(app.count("label:Disconnect")).toBe(2);
});

test("the switch of a toolkit is the user's switch for every agent: it asks setEnabled for its plugin name and shows it off", async () => {
  const app = await open("./fixtures/plugins-composio-virtual.tsx", DESKTOP);
  await app.waitFor("id:composio-plugin-switch");
  // A card switched off is shown fainter; the words after the switch may be cut to nothing in it.
  const faint = () => isFaint(app);
  expect(faint()).toBe(false);
  await app.press("label:Enabled: @composio/gmail");
  await app.waitFor("text:called:setEnabled:@composio/gmail:false");
  await app.waitUntil(faint);
  await app.press("label:Enabled: @composio/gmail");
  await app.waitFor(
    "text:called:setEnabled:@composio/gmail:false called:setEnabled:@composio/gmail:true",
  );
  await app.waitUntil(() => !faint());
});

test("on a phone the rows have the switch too", async () => {
  const app = await open(
    "./fixtures/plugins-composio-virtual-phone.tsx",
    PHONE,
  );
  await app.waitFor("id:composio-plugin-switch");
  expect(app.count("id:composio-plugin-switch")).toBe(1);
  expect(app.count("id:composio-plugin-error")).toBe(1);
});

test("a host that does not list the toolkits as plugins: the cards show as before, without a switch", async () => {
  const app = await open("./fixtures/plugins-composio-actions-ok.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item");
  expect(app.count("id:composio-plugin-switch")).toBe(0);
  expect(app.count("id:composio-plugin-error")).toBe(0);
});

test("a card has one status badge at its top right: Connected, or Unavailable when its session did not check out", async () => {
  const app = await open("./fixtures/plugins-composio-virtual.tsx", DESKTOP);
  await app.waitFor("id:composio-plugin-switch");
  expect(app.count("id:composio-connected")).toBe(1);
  expect(app.count("id:composio-plugin-error")).toBe(1);
  expect(app.count("text:Unavailable")).toBe(1);
});

test("the bottom row of a card stays one line, the switch and both buttons, also when the toolkit is off", async () => {
  const app = await open("./fixtures/plugins-composio-virtual.tsx", DESKTOP);
  await app.waitFor("id:composio-plugin-switch");
  const oneLine = () => {
    const toggle = app.layout("label:Enabled: @composio/gmail")!;
    const reauth = app.layout("label:Re-authenticate >> nth=0")!;
    const leave = app.layout("label:Disconnect >> nth=0")!;
    const overlaps = (a: typeof toggle, b: typeof toggle) =>
      a.y < b.y + b.height && a.y + a.height > b.y;
    return overlaps(toggle, reauth) && overlaps(reauth, leave);
  };
  expect(oneLine()).toBe(true);
  await app.press("label:Enabled: @composio/gmail");
  await app.waitUntil(() => isFaint(app));
  expect(oneLine()).toBe(true);
});

test("an added toolkit is in the same group: the Added mark and one Remove, with neither Re-authenticate nor Disconnect", async () => {
  const app = await open("./fixtures/plugins-composio-added.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item");
  expect(app.count("id:composio-connected-item")).toBe(3);
  expect(app.count("id:composio-added")).toBe(1);
  // The two connected ones: gmail is Connected, ghost's session did not check out.
  expect(app.count("id:composio-connected")).toBe(1);
  expect(app.count("id:composio-plugin-error")).toBe(1);
  expect(app.count("label:Remove")).toBe(1);
  // Only the two connected ones have the sign-in buttons.
  expect(app.count("label:Re-authenticate")).toBe(2);
  expect(app.count("label:Disconnect")).toBe(2);
  expect(app.shows("Added")).toBe(true);
  // The group counts what is added as well, and no longer says "connected".
  expect(app.shows("In Composio (3)")).toBe(true);
});

test("Remove on an added toolkit asks nothing and opens nothing: its card goes at once", async () => {
  const app = await open("./fixtures/plugins-composio-added.tsx", DESKTOP);
  await app.waitFor("id:composio-connected-item >> nth=2");
  await app.press("label:Remove");
  await app.waitFor("id:composio-connected-item >> nth=2", { state: "gone" });
  expect(app.count("id:composio-connected-item")).toBe(2);
  expect(app.shows("label:Delete on Composio")).toBe(false);
  // The log holds the one call: no link, no address.
  expect(app.shows("text:called:composioRemove:hackernews")).toBe(true);
});

test("on a phone an added toolkit is a row with the Added mark and Remove", async () => {
  const app = await open("./fixtures/plugins-composio-added-phone.tsx", PHONE);
  await app.waitFor("id:composio-connected-item >> nth=2");
  expect(app.count("id:composio-added")).toBe(1);
  expect(app.count("label:Remove")).toBe(1);
  expect(app.count("label:Disconnect")).toBe(2);
});

// The group is taken away and brought back as the tab changes or the window crosses a width; the host
// is asked again each time, and until it answers the group must not be empty.
const REMOUNT = "./fixtures/plugins-composio-remount.tsx";

test("a group that is shown again has its cards and its switches in the first frame, before the host answers", async () => {
  const app = await open(REMOUNT, DESKTOP);
  await app.waitFor("text:Gmail");
  await app.waitFor("id:composio-plugin-switch");
  await app.press("label:mode held");
  await app.press("label:hide group");
  expect(app.count("id:composio-connected-group")).toBe(0);
  await app.press("label:show group");
  expect(app.shows("Gmail")).toBe(true);
  expect(app.shows("Hacker News")).toBe(true);
  expect(app.count("id:composio-plugin-switch")).toBe(1);
});

test("a group that is shown again keeps its cards when the host cannot be asked", async () => {
  const app = await open(REMOUNT, DESKTOP);
  await app.waitFor("text:Gmail");
  await app.press("label:mode fails");
  await app.press("label:hide group");
  await app.press("label:show group");
  await app.waitFor("text:answers:2");
  expect(app.shows("Gmail")).toBe(true);
});

test("a group that is shown again loses the connected toolkits when there is no key any more", async () => {
  const app = await open(REMOUNT, DESKTOP);
  await app.waitFor("text:Gmail");
  await app.press("label:mode needs key");
  await app.press("label:hide group");
  await app.press("label:show group");
  await app.waitFor("text:toolkits:2");
  expect(app.shows("Gmail")).toBe(false);
});

test("an added toolkit that was removed is not brought back by the cards kept", async () => {
  const app = await open(REMOUNT, DESKTOP);
  await app.waitFor("text:Hacker News");
  await app.press("label:Remove");
  expect(app.shows("Hacker News")).toBe(false);
  await app.press("label:mode held");
  await app.press("label:hide group");
  await app.press("label:show group");
  expect(app.shows("Hacker News")).toBe(false);
  expect(app.shows("Gmail")).toBe(true);
});
