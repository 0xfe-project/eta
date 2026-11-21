import { expect, open, test } from "nsh/test";

// The screen's unsafe edges are simulated: the system UI through `open`'s
// `safeArea` (an iPhone's status bar and home indicator in portrait, its
// sides in landscape), the on-screen keyboard through a stand-in for NSH's
// `keyboardFrame`. The fixture measures where the page, or a panel opened
// over it, was laid out and says whether it reaches under any of them; the
// header and its buttons are laid out inside the page, the composer last in
// it. What it looks like on screen is shown in the PR with a real browser.

const fixture = "./fixtures/safe-area.tsx";
const portrait = { width: 393, height: 852, safeArea: { top: 59, bottom: 34 } };
const landscape = {
  width: 852,
  height: 393,
  safeArea: { left: 59, right: 59, bottom: 21 },
};
const keyboard = (height: number) => ({
  modules: { nsh: { keyboardFrame: { height, duration: 0 } } },
});

async function where(
  scenario: string,
  options: Record<string, unknown>,
  name: string,
) {
  const app = await open(fixture, {
    ...options,
    locale: "en-US",
    urlScheme: `eta://fixture/${scenario}`,
  });
  await app.waitFor(`text:/^${name}: /`);
  return app;
}

test("a phone's conversation header, with its buttons, sits below the status bar", async () => {
  const app = await where("conversation", portrait, "page");
  expect(app.shows("text:page: clear")).toBe(true);
  expect(app.shows("id:page >> label:Conversation info")).toBe(true);
});

test("in landscape the conversation and its Panel button keep off the sides", async () => {
  const app = await where("conversation", landscape, "page");
  expect(app.shows("text:page: clear")).toBe(true);
  expect(app.shows("id:page >> label:Panel")).toBe(true);
});

test("with the keyboard up, the composer sits on the keyboard, not under it", async () => {
  const app = await where(
    "conversation",
    { ...portrait, ...keyboard(336) },
    "page",
  );
  expect(app.shows("text:page: clear")).toBe(true);
  expect(app.shows("id:page >> id:conversation-composer")).toBe(true);
  expect(app.shows("id:page >> label:Conversation info")).toBe(true);
});

test("a side drawer over the screen keeps its header and close button off the sides", async () => {
  const app = await where("drawer", landscape, "panel");
  expect(app.shows("text:panel header: clear")).toBe(true);
  expect(app.shows("text:panel: clear")).toBe(true);
});

test("a phone sheet over the tab bar keeps its header below the status bar and above the keyboard", async () => {
  const app = await where("sheet", { ...portrait, ...keyboard(336) }, "panel");
  expect(app.shows("text:panel header: clear")).toBe(true);
  expect(app.shows("text:panel: clear")).toBe(true);
});
