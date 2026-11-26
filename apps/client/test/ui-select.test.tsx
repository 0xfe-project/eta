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
  test(`LayoutSelect renders phone sheet chrome and clears bottom safe area on ${platform}`, async () => {
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

    const gamma = app.layout("label:Gamma");
    expect(gamma).not.toBeNull();
    expect(gamma!.height).toBeGreaterThanOrEqual(52);
    expect(gamma!.y + gamma!.height).toBe(852 - 34 - 8);

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

test("phone sheet does not double-pad when safeArea.bottom is 0", async () => {
  const app = await open(fixture, {
    width: 393,
    height: 852,
    safeArea: { top: 0, bottom: 0 },
    locale: "en-US",
    platform: "android",
  });

  await app.press("label:Phone select");
  await app.waitFor("label:Gamma");
  const gamma = app.layout("label:Gamma");
  expect(gamma).not.toBeNull();
  expect(gamma!.y + gamma!.height).toBe(852 - 8);
});

for (const platform of ["ios", "android"] as const) {
  test(`SkillSelect renders 52pt phone sheet rows with header on ${platform}`, async () => {
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

    const row = app.layout("label:Linux Box");
    expect(row).not.toBeNull();
    expect(row!.height).toBeGreaterThanOrEqual(52);
    expect(row!.y + row!.height).toBe(852 - 34 - 8);

    await app.press("label:Linux Box");
    await app.waitFor("text:skill:linux-box");
    await app.waitUntil(() => !app.shows("id:menu-grabber"));
  });

  test(`ModelSelect renders styled phone sheet with safe-area padding and search on ${platform}`, async () => {
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

    const option = app.layout("label:GPT-5");
    expect(option).not.toBeNull();
    expect(option!.width).toBe(393);
    expect(option!.height).toBeGreaterThanOrEqual(52);
    expect(option!.y + option!.height).toBeLessThanOrEqual(852 - 34);

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
  const option = app.layout("label:GPT-5");
  expect(option).not.toBeNull();
  expect(option!.width).toBeGreaterThanOrEqual(336);
  expect(option!.height).toBe(28);

  await app.press("label:GPT-5");
  await app.waitFor("text:desktop-model:llm:gpt-5");
});
