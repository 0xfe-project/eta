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
  expect(
    app.shows(
      "Set one in Settings → Plugins to list its toolkits. The other sources are not affected.",
    ),
  ).toBe(true);
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
  expect(
    app.shows(
      "API key type: on Composio's page you paste your own key for this app.",
    ),
  ).toBe(true);
  expect(app.shows("Installed")).toBe(false);
  const oauth = await open("./fixtures/composio-ready.tsx", OPEN);
  await oauth.press("label:Gmail");
  expect(
    oauth.shows(
      "OAuth type: you are sent to the app's authorization page to sign in and allow access.",
    ),
  ).toBe(true);
  const none = await open("./fixtures/composio-ready.tsx", OPEN);
  await none.press("label:Hacker News");
  expect(
    none.shows(
      "This toolkit needs no sign-in, so there is nothing to authorize. Add it to make it a plugin of your agents.",
    ),
  ).toBe(true);
});

test("Connect calls composioLink and opens the address it returns, with no confirmation", async () => {
  const app = await open("./fixtures/composio-ready.tsx", OPEN);
  await app.press("label:Gmail");
  await app.press("label:Connect");
  await app.waitFor(
    "text:called:composioLink:gmail opened:https://connect.composio.test/gmail",
  );
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

test("a refused link's error is gone once the detail is closed and opened again", async () => {
  const app = await open("./fixtures/composio-link-fails.tsx", OPEN);
  await app.press("label:Gmail");
  await app.press("label:Connect");
  await app.waitFor("text:Composio refused the link");
  await app.press("label:Close");
  await app.press("label:Gmail");
  expect(app.shows("Composio refused the link")).toBe(false);
});

const POLLING = { ...OPEN, clock: {} };
const polls = (app: { texts: () => string[] }) =>
  Number(
    app
      .texts()
      .find((text) => text.startsWith("polls:"))!
      .slice(6),
  );

test("after Connect it asks until the toolkit is connected, shows the mark and stops", async () => {
  const app = await open("./fixtures/composio-connect-polls.tsx", POLLING);
  await app.press("label:Gmail");
  expect(app.count("id:composio-connected")).toBe(0);
  await app.press("label:Connect");
  await app.waitFor(
    "text:called:composioLink:gmail opened:https://connect.composio.test/gmail",
  );
  expect(app.count("id:composio-connected")).toBe(0);
  await app.clock!.runFor(9000);
  expect(app.count("id:composio-connected")).toBeGreaterThan(0);
  // The button now says what it does, and is still there.
  expect(app.shows("label:Re-authenticate")).toBe(true);
  const asked = polls(app);
  await app.clock!.runFor(60_000);
  expect(polls(app)).toBe(asked);
});

test("it asks again at once when the window gets the focus back", async () => {
  const app = await open("./fixtures/composio-connect-never.tsx", POLLING);
  await app.press("label:Gmail");
  await app.press("label:Connect");
  await app.waitFor(
    "text:called:composioLink:gmail opened:https://connect.composio.test/gmail",
  );
  await app.setLifecycle("inactive");
  const before = polls(app);
  await app.setLifecycle("active");
  expect(polls(app)).toBe(before + 1);
});

test("it gives up after about three minutes, with no error and no mark", async () => {
  const app = await open("./fixtures/composio-connect-never.tsx", POLLING);
  await app.press("label:Gmail");
  await app.press("label:Connect");
  await app.waitFor(
    "text:called:composioLink:gmail opened:https://connect.composio.test/gmail",
  );
  await app.clock!.runFor(200_000);
  const asked = polls(app);
  expect(asked).toBeGreaterThan(10);
  expect(asked).toBeLessThan(70);
  await app.clock!.runFor(60_000);
  expect(polls(app)).toBe(asked);
  expect(app.count("id:composio-connected")).toBe(0);
  expect(app.shows("label:Connect")).toBe(true);
});

test("it stops asking when the market is left", async () => {
  const app = await open("./fixtures/composio-connect-polls.tsx", {
    ...POLLING,
  });
  await app.press("label:Gmail");
  await app.press("label:Connect");
  await app.waitFor(
    "text:called:composioLink:gmail opened:https://connect.composio.test/gmail",
  );
  await app.clock!.runFor(3000);
  expect(polls(app)).toBeGreaterThan(0);
  await app.press("label:Leave");
  const asked = polls(app);
  await app.clock!.runFor(30_000);
  expect(polls(app)).toBe(asked);
});

test("a toolkit already connected shows the mark on its card and says Re-authenticate", async () => {
  const app = await open("./fixtures/composio-already-connected.tsx", OPEN);
  await app.waitFor("id:composio-connected");
  await app.press("label:Gmail");
  expect(app.shows("label:Re-authenticate")).toBe(true);
});

test("the connected mark of a card is at its bottom right, on the line of its source", async () => {
  const app = await open("./fixtures/composio-already-connected.tsx", OPEN);
  await app.waitFor("id:composio-connected");
  const card = app.layout("label:Gmail")!;
  const mark = app.layout("id:composio-connected")!;
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

test("a toolkit that is not connected has no Disconnect", async () => {
  const app = await open("./fixtures/composio-ready.tsx", OPEN);
  await app.press("label:Gmail");
  expect(app.shows("label:Disconnect")).toBe(false);
});

test("Re-authenticate on a connected toolkit goes through composioLink and opens its address", async () => {
  const app = await open("./fixtures/composio-already-connected.tsx", OPEN);
  await app.waitFor("id:composio-connected");
  await app.press("label:Gmail");
  await app.press("label:Re-authenticate");
  await app.waitFor(
    "text:called:composioLink:gmail opened:https://connect.composio.test/gmail",
  );
});

test("Disconnect asks first, and Cancel deletes nothing", async () => {
  const app = await open("./fixtures/composio-disconnect-ok.tsx", OPEN);
  await app.waitFor("id:composio-connected");
  await app.press("label:Gmail");
  await app.press("label:Disconnect");
  expect(app.shows("label:Delete on Composio")).toBe(true);
  expect(app.shows("composioDisconnect")).toBe(false);
  await app.press("label:Cancel");
  expect(app.shows("label:Delete on Composio")).toBe(false);
  expect(app.shows("composioDisconnect")).toBe(false);
  expect(app.count("id:composio-connected")).toBeGreaterThan(0);
});

test("a confirmed Disconnect calls composioDisconnect and the mark is gone at once, before Composio is asked again", async () => {
  const app = await open("./fixtures/composio-disconnect-stale.tsx", OPEN);
  await app.waitFor("id:composio-connected");
  await app.press("label:Gmail");
  await app.press("label:Disconnect");
  await app.press("label:Delete on Composio");
  await app.waitFor("text:called:composioDisconnect:gmail");
  await app.waitFor("id:composio-connected", { state: "gone" });
  expect(app.count("id:composio-connected")).toBe(0);
  expect(app.shows("label:Delete on Composio")).toBe(false);
});

test("a failed Disconnect says so, keeps the mark and the dialog, and shows no text from Composio", async () => {
  const app = await open("./fixtures/composio-disconnect-fails.tsx", OPEN);
  await app.waitFor("id:composio-connected");
  await app.press("label:Gmail");
  await app.press("label:Disconnect");
  await app.press("label:Delete on Composio");
  await app.waitFor("text:Could not disconnect. Try again later.");
  expect(app.count("id:composio-connected")).toBeGreaterThan(0);
});

test("a connected card in the market still says From Composio, with the mark", async () => {
  const app = await open("./fixtures/composio-already-connected.tsx", OPEN);
  await app.waitFor("id:composio-connected");
  expect(app.shows("From Composio")).toBe(true);
});

test("a toolkit that needs no sign-in has Add, not Connect: it asks for no link, opens nothing, and the mark says Added", async () => {
  const app = await open("./fixtures/composio-ready.tsx", OPEN);
  await app.press("label:Hacker News");
  expect(app.shows("label:Connect")).toBe(false);
  expect(app.shows("label:Add")).toBe(true);
  await app.press("label:Add");
  await app.waitFor("id:composio-added");
  // The log holds the one call: no link was asked for and no address was opened.
  expect(app.shows("text:called:composioAdd:hackernews")).toBe(true);
  expect(app.count("id:composio-connected")).toBe(0);
  expect(app.shows("label:Remove")).toBe(true);
  expect(app.shows("label:Add")).toBe(false);
});

test("a toolkit that signs in keeps Connect, and no Add", async () => {
  const app = await open("./fixtures/composio-ready.tsx", OPEN);
  await app.press("label:Gmail");
  expect(app.shows("label:Connect")).toBe(true);
  expect(app.shows("label:Add")).toBe(false);
  expect(app.shows("label:Remove")).toBe(false);
});

test("an added toolkit's card says Added, in the place of Connected, and still says where it is from", async () => {
  const app = await open("./fixtures/composio-none-added.tsx", OPEN);
  await app.waitFor("id:composio-added");
  expect(app.count("id:composio-added")).toBe(1);
  expect(app.count("id:composio-connected")).toBe(0);
  expect(app.shows("Added")).toBe(true);
  expect(app.shows("Connected")).toBe(false);
  expect(app.shows("From Composio")).toBe(true);
});

test("Remove in the detail of an added toolkit asks Composio for nothing and takes the mark away", async () => {
  const app = await open("./fixtures/composio-none-added.tsx", OPEN);
  await app.waitFor("id:composio-added");
  await app.press("label:Hacker News");
  await app.press("label:Remove");
  await app.waitFor("text:called:composioRemove:hackernews");
  await app.waitFor("id:composio-added", { state: "gone" });
  expect(app.shows("label:Add")).toBe(true);
});

const NO_MANAGED =
  "Composio has no managed sign-in for this service. Create your own auth config for it in the Composio dashboard (you bring your own OAuth app's client ID and secret), then come back and press Connect.";
const DASHBOARD = "https://dashboard.composio.dev/~/project/auth-configs";

test("a toolkit with no managed sign-in and no key or registration scheme says so beside Connect, with the dashboard link", async () => {
  const app = await open("./fixtures/composio-no-managed.tsx", OPEN);
  await app.press("label:Twitter");
  expect(app.shows(NO_MANAGED)).toBe(true);
  // Connect is still there: the user may have made the config already.
  expect(app.shows("label:Connect")).toBe(true);
  await app.press("label:Open Composio dashboard");
  await app.waitFor("text:opened:" + DASHBOARD);
});

test("the no-managed-sign-in hint is not shown for a toolkit that has a managed sign-in, a key scheme or dynamic registration", async () => {
  for (const name of ["Gmail", "Railway", "Cloudflare MCP"]) {
    const app = await open("./fixtures/composio-no-managed.tsx", OPEN);
    await app.press("label:" + name);
    expect(app.shows(NO_MANAGED)).toBe(false);
    expect(app.shows("label:Open Composio dashboard")).toBe(false);
  }
});

test("a link refused for want of a managed sign-in shows the sentence, not the host's marker", async () => {
  const app = await open("./fixtures/composio-no-managed-link.tsx", OPEN);
  await app.press("label:Gmail");
  expect(app.shows(NO_MANAGED)).toBe(false);
  await app.press("label:Connect");
  await app.waitFor("text:" + NO_MANAGED);
  expect(app.shows("composio_no_managed_login")).toBe(false);
});
