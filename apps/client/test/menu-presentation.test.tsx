import type { Platform } from "nsh/test";
import { expect, open, test } from "nsh/test";
import { menuEngine, menuPresentation } from "../src/components/menu";

// A menu shows as the layout says, whatever the platform: the phone layout's is the sheet at
// the bottom (its grabber on top), the tablet's and the desktop's a popup at the trigger.
const fixture = "./fixtures/menu-presentation.tsx";
const platforms: Platform[] = ["ios", "android", "linux", "web"];
const layouts = [
  ["phone", 390, true],
  ["tablet", 1024, false],
  ["desktop", 1440, false],
] as const;

test("the layout alone says sheet or popup", () => {
  expect(menuPresentation("phone")).toBe("sheet");
  expect(menuPresentation("tablet")).toBe("popup");
  expect(menuPresentation("desktop")).toBe("popup");
});

test("the menu engine follows the requested presentation", () => {
  // A sheet is eta's own Sheet, so every platform gets the same height and framing.
  expect(menuEngine("sheet", false)).toBe("sheet");
  expect(menuEngine("popup", true)).toBe("menu");
  expect(menuEngine("popup", false)).toBe("popover");
  expect(menuEngine("sheet", true)).toBe("sheet");
});

for (const platform of platforms) {
  for (const [layout, width, sheet] of layouts) {
    test(`${platform}, ${layout} layout: the menus are ${sheet ? "a sheet" : "a popup"}`, async () => {
      const app = await open(fixture, {
        width,
        height: 800,
        locale: "en-US",
        platform,
      });
      await app.waitFor("label:Task actions");

      await app.press("label:Task actions");
      await app.waitFor("label:Archive");
      expect(app.shows("id:menu-grabber")).toBe(sheet);
      await app.press("label:Archive");
      await app.waitFor("text:Chose Archive");
      await app.waitUntil(() => !app.shows("label:Edit"));

      await app.press("label:More task actions");
      await app.waitFor("label:Copy link");
      expect(app.shows("id:menu-grabber")).toBe(sheet);
      await app.press("label:Copy link");
      await app.waitFor("text:Chose Copy link");
      await app.waitUntil(() => !app.shows("label:Copy link"));

      // The dropdown chooses in every layout too.
      await app.press("label:Channel");
      await app.waitFor("text:Pre-releases");
      expect(app.shows("id:menu-grabber")).toBe(sheet);
      await app.press("text:Pre-releases");
      await app.waitFor("text:Channel: pre");
      await app.waitUntil(() => !app.shows("text:Pre-releases"));
    });
  }
}
