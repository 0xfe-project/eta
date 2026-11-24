import { expect, open, test } from "nsh/test";

// ⌘C / Ctrl+C on text selected in a reply (#385). A headless run selects nothing (it draws no
// text), so these copies are checked on the real platforms: `nsh test --target macos`, where both
// copied nothing, and `--target linux`. A browser's own copy does not reach the test's clipboard,
// so the web is left out.

const fixture = () =>
  open("./fixtures/copy-around.tsx", { width: 700, height: 500 });
type App = Awaited<ReturnType<typeof fixture>>;

/** Selects the end of `text` (back from past its line's end); what the reply says it selected. */
async function selectEnd(app: App, text: string) {
  await app.drag(`text:${text}`, { x: -320, y: 0 });
  const selected = () =>
    app
      .texts()
      .find((line) => line.startsWith("selected: "))
      ?.slice("selected: ".length);
  await app.waitUntil(() => !!selected(), { timeout: 2000 }).catch(() => {});
  return selected();
}

test("⌘C copies the text selected in a reply while the composer has the focus", async () => {
  const app = await fixture();
  if (app.shows("text:platform: web")) return;
  await app.type("id:eta-editor", "draft");
  const selected = await selectEnd(app, "Ship the rollout on Monday.");
  if (!selected) return;
  await app.keyboard.press("mod+c");
  await app.waitUntil(() => app.clipboard() === selected);
  expect(app.clipboard()).toBe(selected);
});

test("⌘C copies the text selected in a reply inside a view that took the focus", async () => {
  const app = await fixture();
  if (app.shows("text:platform: web")) return;
  const selected = await selectEnd(app, "Keep the old flag until week 3.");
  if (!selected) return;
  await app.keyboard.press("mod+c");
  await app.waitUntil(() => app.clipboard() === selected);
  expect(app.clipboard()).toBe(selected);
});

test("⌘C in the composer copies its own selection as Markdown, after a reply's too", async () => {
  const app = await fixture();
  // Text selected in a reply first (not headless): what the composer selects after is copied.
  if (!app.shows("text:platform: web"))
    await selectEnd(app, "Ship the rollout on Monday.");
  await app.type("id:eta-editor", "ship **today**");
  await app.keyboard.press("mod+a");
  await app.keyboard.press("mod+c");
  await app.waitUntil(() => app.clipboard() === "ship **today**");
  await app.keyboard.press("mod+x");
  expect(app.clipboard()).toBe("ship **today**");
  expect(app.shows("text:ship today")).toBe(false);
});
