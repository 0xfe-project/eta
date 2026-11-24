import { expect, open, test } from "nsh/test";

test("Header, Empty, and keyboard-adjustable PaneHandle render and respond", async () => {
  const app = await open("./fixtures/ui-shell.tsx", {
    width: 600,
    height: 400,
    locale: "en-US",
    platform: "macos",
  });
  expect(app.shows("text:Workspace")).toBe(true);
  expect(app.shows("text:Ready")).toBe(true);
  expect(app.shows("text:Nothing yet")).toBe(true);
  expect(app.shows("text:Items will appear here.")).toBe(true);
  expect(app.shows("label:Resize sidebar")).toBe(true);
  expect(app.shows("text:backs:0 width:288")).toBe(true);

  await app.press("label:Back");
  expect(app.shows("text:backs:1 width:288")).toBe(true);

  expect(app.accessibility("label:Resize sidebar")).toMatchObject({
    role: "adjustable",
    label: "Resize sidebar",
  });

  await app.drag("label:Resize sidebar", { x: 32 });
  expect(app.shows("text:backs:1 width:320")).toBe(true);
});
