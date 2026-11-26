import type { PaletteId } from "../src/components/palettes";
import { expect, open, test } from "nsh/test";
import { palette } from "../src/components/theme";

const fixture = "./fixtures/steward-menu.tsx";
const rgba = (hex: string) => `${hex.toLowerCase()}ff`;

for (const paletteId of [
  "default",
  "catppuccin",
] as const satisfies readonly PaletteId[])
  for (const scheme of ["light", "dark"] as const)
    test(`steward picker hovers without fill and shifts label from muted to ink (${paletteId}/${scheme})`, async () => {
      const c = palette(scheme, paletteId);
      const app = await open(fixture, {
        platform: "macos",
        width: 1280,
        height: 800,
        locale: "en-US",
        colorScheme: scheme,
        storage: { palette: paletteId },
      });
      await app.waitFor("label:Steward");

      expect(
        app.viewStyle("label:Steward")?.backgroundColor ?? null,
      ).toBeNull();
      expect(app.spanStyle("label:Steward >> text:Ada").color).toBe(
        rgba(c.muted),
      );

      await app.hover("label:Steward");
      expect(
        app.viewStyle("label:Steward")?.backgroundColor ?? null,
      ).toBeNull();
      expect(app.spanStyle("label:Steward >> text:Ada").color).toBe(
        rgba(c.ink),
      );

      await app.hover("text:Website redesign");
      expect(
        app.viewStyle("label:Steward")?.backgroundColor ?? null,
      ).toBeNull();
      expect(app.spanStyle("label:Steward >> text:Ada").color).toBe(
        rgba(c.muted),
      );
    });

test("steward picker opens, switches steward, stays visible with no steward, and omits saving/saved indicators", async () => {
  const c = palette("light", "default");
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 800,
    locale: "en-US",
    colorScheme: "light",
  });
  await app.waitFor("label:Steward");

  await app.press("label:Steward");
  await app.waitFor("label:No steward");
  expect(app.spanStyle("label:Steward >> text:Ada").color).toBe(rgba(c.ink));

  await app.press("label:Ben >> nth=1");
  await app.waitFor("label:Steward >> text:Ben");
  expect(app.texts()).not.toContain("Saved");
  expect(app.texts()).not.toContain("Saving…");

  await app.press("label:Steward");
  await app.waitFor("label:No steward");
  await app.press("label:No steward");
  await app.waitFor("label:Steward >> text:Steward");
  expect(app.shows("label:Steward")).toBe(true);
});

test("steward picker stays visible when opened with no steward chosen", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 800,
    locale: "en-US",
    storage: { steward: "none" },
  });
  await app.waitFor("label:Steward");
  expect(app.shows("label:Steward >> text:Steward")).toBe(true);
  await app.hover("label:Steward");
  expect(app.viewStyle("label:Steward")?.backgroundColor ?? null).toBeNull();
  expect(app.spanStyle("label:Steward >> text:Steward").color).toBe(
    rgba(palette("light", "default").ink),
  );
});

test("steward picker rolls back and offers retry when setSteward fails", async () => {
  const app = await open(fixture, {
    platform: "macos",
    width: 1280,
    height: 800,
    locale: "en-US",
    storage: { failSteward: "true" },
  });
  await app.waitFor("label:Steward");
  await app.press("label:Steward");
  await app.waitFor("label:No steward");
  await app.press("label:Ben >> nth=1");
  await app.waitFor("label:Retry");
  expect(app.shows("id:toast")).toBe(true);
  expect(app.shows("label:Steward >> text:Ada")).toBe(true);
});
