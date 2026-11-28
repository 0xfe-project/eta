import type { Platform } from "nsh/test";
import { expect, open, test } from "nsh/test";

const fixture = "./fixtures/ui-select.tsx";
const platforms: Platform[] = ["ios", "android", "web", "linux"];

test("LayoutSelect updates selection in desktop native mode and phone sheet fallback", async () => {
  const app = await open(fixture, {
    width: 600,
    height: 480,
  });
  expect(app.shows("text:desktop:alpha")).toBe(true);
  expect(app.shows("text:phone:alpha")).toBe(true);

  await app.press("label:Desktop select");
  await app.waitFor("text:Beta");
  await app.press("text:Beta");
  await app.waitFor("text:desktop:beta");

  await app.press("label:Phone select");
  await app.waitFor("label:Gamma");
  await app.press("label:Gamma");
  await app.waitFor("text:phone:gamma");
});

for (const platform of platforms) {
  test(`LayoutSelect renders phone sheet chrome, closes and selects on ${platform}`, async () => {
    const app = await open(fixture, {
      width: 393,
      height: 852,
      safeArea: { top: 59, bottom: 34 },
      locale: "en-US",
      platform,
    });

    await app.press("label:Phone select");
    await app.waitFor("label:Gamma");
    expect(app.shows("id:menu-grabber")).toBe(true);
    expect(app.shows("id:select-sheet-header")).toBe(true);
    expect(app.shows("id:select-sheet-header >> text:Phone select")).toBe(true);
    expect(app.shows("id:select-sheet-header >> label:Close")).toBe(true);

    await app.press("id:select-sheet-header >> label:Close");
    await app.waitUntil(() => !app.shows("id:menu-grabber"));
    expect(app.shows("text:phone:alpha")).toBe(true);

    await app.press("label:Phone select");
    await app.waitFor("label:Gamma");
    await app.press("label:Gamma");
    await app.waitFor("text:phone:gamma");
    await app.waitUntil(() => !app.shows("id:menu-grabber"));
  });
}

for (const platform of ["ios", "android"] as const) {
  test(`SkillSelect renders a phone sheet with header and selects on ${platform}`, async () => {
    const app = await open(fixture, {
      width: 393,
      height: 852,
      safeArea: { top: 59, bottom: 34 },
      locale: "en-US",
      platform,
    });

    await app.press("label:Phone skill");
    await app.waitFor("label:Linux Box");
    expect(app.shows("id:menu-grabber")).toBe(true);
    expect(app.shows("id:select-sheet-header")).toBe(true);

    await app.press("label:Linux Box");
    await app.waitFor("text:skill:linux-box");
    await app.waitUntil(() => !app.shows("id:menu-grabber"));
  });

  test(`ModelSelect renders a phone sheet with search on ${platform}`, async () => {
    const app = await open(fixture, {
      width: 393,
      height: 852,
      safeArea: { top: 59, bottom: 34 },
      locale: "en-US",
      platform,
    });

    await app.press("id:phone-model >> label:Model");
    await app.waitFor("label:GPT-5");
    expect(app.shows("label:Search models")).toBe(true);

    await app.type("label:Search models", "GPT");
    await app.waitUntil(() => !app.shows("label:Claude Sonnet"));
    expect(app.shows("label:GPT-5")).toBe(true);

    await app.press("label:GPT-5");
    await app.waitFor("text:phone-model:llm:gpt-5");
  });
}

test("ModelSelect keeps desktop popup behavior on linux", async () => {
  const app = await open(fixture, {
    width: 1440,
    height: 900,
    locale: "en-US",
    platform: "linux",
  });

  await app.press("id:desktop-model >> label:Model");
  await app.waitFor("label:GPT-5");
  // A popup, not the phone's sheet.
  expect(app.shows("id:menu-grabber")).toBe(false);
  expect(app.shows("label:Search models")).toBe(true);

  await app.press("label:GPT-5");
  await app.waitFor("text:desktop-model:llm:gpt-5");
});
