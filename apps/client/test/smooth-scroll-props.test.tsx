import { expect, open, test } from "nsh/test";

// A SmoothScroll follows the props it is given as they change, as a Scroll
// does: a menu's maxHeight that is set once the menu is placed, a margin that
// follows the layout, a height. On Windows it is another tree (the wheel
// view inside), so both are opened.

const fixture = "./fixtures/smooth-scroll-props.tsx";

for (const platform of ["linux", "windows"] as const) {
  test(`its style follows the signals it reads (${platform})`, async () => {
    const app = await open(fixture, { platform, width: 800, height: 800 });
    await app.waitFor("text:/^box: /");
    expect(app.shows("text:box: top 47 height 1000")).toBe(true);

    await app.press("text:room 200");
    await app.waitFor("text:box: top 47 height 200");

    await app.press("text:room 120");
    await app.waitFor("text:box: top 47 height 120");

    await app.press("text:tablet");
    await app.waitFor("text:box: top 48 height 120");

    await app.press("text:height 90");
    await app.waitFor("text:box: top 48 height 90");
  });
}
