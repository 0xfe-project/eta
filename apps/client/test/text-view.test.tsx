import { expect, open, test } from "nsh/test";

// A text shown (`TextSystem.View`, nsh TextView) with the view half of its plugins: the blocks the
// editor makes come back as the same blocks, and a plugin's two halves both take effect.

test("a shown text has its mentions, folded pastes and files as blocks, as the editor has", async () => {
  const app = await open("./fixtures/text-compare.tsx", {
    width: 1280,
    height: 1400,
    locale: "en-US",
  });
  await app.waitFor("label:View");
  // Once in the editor, once where it is shown.
  await app.waitUntil(() => app.count("label:Mention Ada") === 2);
  expect(app.count("label:Pasted · 24 lines")).toBe(1);
  expect(app.count("label:File notes.pdf")).toBe(2);
  expect(app.count("label:Copy code")).toBe(1);
});

test("a plugin's editor half and view half both take effect", async () => {
  const app = await open("./fixtures/text-view.tsx", {
    width: 600,
    height: 400,
    locale: "en-US",
  });
  await app.waitFor("label:Ticket 12");
  expect(app.shows("text:editors: 1")).toBe(true);
});
