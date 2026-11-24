import { expect, open, test } from "nsh/test";

// What the reader sees of a message on its way: at the end of the transcript while it goes (or in
// the queue above the box when every agent it goes to is answering), the host's own row in its
// place once taken, and a failed one where it was with Retry, Edit and Discard.

const input = "id:eta-editor";
const fixture = (width = 1280) =>
  open("./fixtures/outbox.tsx", {
    platform: "macos",
    width,
    height: 800,
    locale: "en-US",
    clock: { time: 1000 },
  });
type App = Awaited<ReturnType<typeof fixture>>;

async function send(app: App, text: string) {
  await app.type(input, text);
  await app.keyboard.press("enter");
}
/** How many times the words are on screen, the box left out. */
const copies = (app: App, text: string) =>
  app.texts().filter((shown) => shown === text).length;
const inTranscript = (app: App, text: string) =>
  app.shows(`label:Sending: ${text}`);
const queuedOnTheWay = (app: App, text: string) =>
  app.shows(`label:Sending, to wait in the queue: ${text}`);

test("a message shows at the end while it goes and becomes the host's, once", async () => {
  const app = await fixture();
  await app.press("label:Hold sends");
  await send(app, "hello there");
  await app.waitFor("label:Sending: hello there");
  expect(app.shows("text:Sending…")).toBe(true);
  expect(app.shows("label:Queued messages")).toBe(false);
  await app.press("label:Answer");
  await app.waitUntil(() => !inTranscript(app, "hello there"));
  expect(app.shows("text:Sending…")).toBe(false);
  expect(copies(app, "hello there")).toBe(1);
});

test("someone else's message that lands first keeps the host's order", async () => {
  const app = await fixture();
  await app.press("label:Hold sends");
  await send(app, "mine");
  await app.waitFor("label:Sending: mine");
  await app.press("label:Someone speaks");
  await app.press("label:Answer");
  await app.waitUntil(() => !inTranscript(app, "mine"));
  expect(copies(app, "mine")).toBe(1);
  const texts = app.texts();
  expect(texts.indexOf("Bo was first")).toBeLessThan(texts.indexOf("mine"));
});

test("with every recipient answering it goes straight to the queue, never the transcript", async () => {
  const app = await fixture();
  await app.press("label:Ada starts");
  await app.press("label:Hold sends");
  await send(app, "after you");
  await app.waitFor("label:Sending, to wait in the queue: after you");
  expect(app.shows("text:Sending · will queue, waits for Ada to finish")).toBe(
    true,
  );
  expect(inTranscript(app, "after you")).toBe(false);
  await app.press("label:Answer");
  await app.waitFor("text:Queued · waits for Ada to finish");
  expect(queuedOnTheWay(app, "after you")).toBe(false);
  expect(app.shows("label:Queued message: after you")).toBe(true);
  expect(copies(app, "after you")).toBe(1);
});

test("guessed queued, but the host sent it: it moves into the transcript", async () => {
  const app = await fixture();
  await app.press("label:Ada starts");
  // Ada finished on the host before the client heard.
  await app.press("label:Ada ends unseen");
  await app.press("label:Hold sends");
  await send(app, "just in time");
  await app.waitFor("label:Sending, to wait in the queue: just in time");
  await app.press("label:Answer");
  await app.waitUntil(() => !queuedOnTheWay(app, "just in time"));
  expect(app.shows("label:Queued message: just in time")).toBe(false);
  expect(app.shows("label:Queued messages")).toBe(false);
  expect(copies(app, "just in time")).toBe(1);
});

test("guessed sent, but the host held it: it moves into the queue", async () => {
  const app = await fixture();
  // Ada started on the host before the client heard.
  await app.press("label:Ada starts unseen");
  await app.press("label:Hold sends");
  await send(app, "too late");
  await app.waitFor("label:Sending: too late");
  await app.press("label:Answer");
  await app.waitFor("label:Queued message: too late");
  expect(inTranscript(app, "too late")).toBe(false);
  expect(copies(app, "too late")).toBe(1);
});

test("a failed send stays in the transcript and can be retried", async () => {
  const app = await fixture();
  await app.press("label:Fail sends");
  await send(app, "try again");
  await app.waitFor("label:Not sent: try again");
  expect(app.shows("text:Not sent: the host went away")).toBe(true);
  expect(app.shows("label:Queued messages")).toBe(false);
  await app.press("label:Heal sends");
  await app.press("label:Retry");
  await app.waitUntil(
    () =>
      !app.shows("label:Not sent: try again") &&
      !inTranscript(app, "try again"),
  );
  expect(copies(app, "try again")).toBe(1);
});

test("a failed send goes back to the box to edit, or is discarded", async () => {
  const app = await fixture();
  await app.press("label:Fail sends");
  await send(app, "rewrite me");
  await app.waitFor("label:Not sent: rewrite me");
  await app.press("label:Edit");
  expect(app.shows("label:Not sent: rewrite me")).toBe(false);
  expect(app.texts().join("\n")).toContain("rewrite me");
  await app.keyboard.press("enter");
  await app.waitFor("label:Not sent: rewrite me");
  await app.press("label:Discard");
  expect(app.shows("label:Not sent: rewrite me")).toBe(false);
  expect(app.texts().join("\n")).not.toContain("rewrite me");
});

test("on a phone the failed message keeps Retry, Edit and Discard under it", async () => {
  const app = await fixture(390);
  await app.press("label:Fail sends");
  await send(app, "from the phone");
  await app.waitFor("label:Not sent: from the phone");
  for (const action of ["Retry", "Edit", "Discard"])
    expect(app.shows(`label:${action}`)).toBe(true);
});

test("a message sent while the connection is down goes once it is back", async () => {
  const app = await fixture();
  await app.press("label:Disconnect");
  await send(app, "when you can");
  await app.waitFor("label:Sending: when you can");
  await app.press("label:Reconnect");
  await app.waitUntil(() => !inTranscript(app, "when you can"));
  expect(copies(app, "when you can")).toBe(1);
});
