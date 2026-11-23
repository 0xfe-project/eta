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
      "This toolkit needs no sign-in, so there is nothing to authorize. Connect still opens Composio's page for it.",
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
