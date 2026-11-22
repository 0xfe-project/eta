import { expect, open, test } from "nsh/test";

// A sidebar group's right-click menu: renaming it, archiving it, and the name another group of
// its project already has.

async function sidebar() {
  const app = await open("./fixtures/group-actions.tsx", {
    platform: "macos",
    width: 1024,
    height: 700,
    locale: "en-US",
  });
  await app.waitFor("label:Pricing page");
  return app;
}

test("a group renamed from its menu shows its new name in the sidebar", async () => {
  const app = await sidebar();
  await app.rightClick("label:Pricing page");
  await app.press("label:Rename…");
  expect(app.enabled("label:Save")).toBe(false);
  await app.clear("label:Group name");
  await app.type("label:Group name", "Pricing v2");
  await app.press("label:Save");
  await app.waitFor("label:Pricing v2");
  expect(app.shows("label:Pricing page")).toBe(false);
  expect(app.shows("text:Rename group")).toBe(false);
});

test("an archived group leaves the sidebar", async () => {
  const app = await sidebar();
  await app.rightClick("label:Launch");
  await app.press("label:Archive…");
  expect(app.shows("text:Archive “Launch”?")).toBe(true);
  await app.press("label:Archive");
  await app.waitUntil(() => !app.shows("label:Launch"));
  expect(app.shows("label:Pricing page")).toBe(true);
});

test("the name of another group in the project is refused, one in another project is not", async () => {
  const app = await sidebar();
  await app.rightClick("label:Pricing page");
  await app.press("label:Rename…");
  await app.clear("label:Group name");
  await app.type("label:Group name", "Launch");
  await app.press("label:Save");
  await app.waitFor("text:A group with this name already exists.");
  expect(app.shows("label:Pricing page")).toBe(true);
  await app.clear("label:Group name");
  await app.type("label:Group name", "Docs");
  await app.press("label:Save");
  await app.waitFor("label:Docs >> nth=1");
  expect(app.shows("label:Pricing page")).toBe(false);
});
