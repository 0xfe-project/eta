import assert from "node:assert/strict";
// eslint-disable-next-line test/no-import-node-test -- The extension can be tested without Eta workspace dependencies.
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { stylesheet } from "../src/adapter.js";
import { exportTheme, importTheme } from "../src/theme-package.js";
import {
  defaultTheme,
  imageLimit,
  normalizeTheme,
  resolveColors,
  showWallpaper,
  sitePattern,
  webOrigin,
} from "../src/theme.js";

const gif =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const jpeg = "data:image/jpeg;base64,/9j/2Q==";

test("fills missing colors from the selected base and clamps component values", () => {
  const theme = normalizeTheme({
    version: 1,
    base: "light",
    colors: { canvas: "#A2B3C4", ink: "var(--untrusted)", accent: "#f1f1f1" },
    wallpaper: { file: "../../image.gif", overlayOpacity: 16 },
    components: { composer: { radius: -5, backgroundOpacity: 3 } },
  });
  assert.deepEqual(theme.colors, { canvas: "#a2b3c4" });
  assert.equal(resolveColors(theme).ink, "#111111");
  assert.equal(theme.wallpaper.file, undefined);
  assert.equal(theme.wallpaper.overlayOpacity, 1);
  assert.deepEqual(theme.components.composer, {
    radius: 0,
    backgroundOpacity: 1,
  });
});

test("round-trips theme ZIPs without changing GIF bytes", () => {
  const theme = defaultTheme();
  theme.wallpaper.file = "wallpaper.gif";
  theme.components.card.radius = 21;
  const imported = importTheme(exportTheme({ theme, image: gif }));
  assert.equal(imported.image, gif);
  assert.deepEqual(imported.theme, theme);
  assert.equal(imported.imageName, "wallpaper.gif");
});

test("accepts standalone JSON and rejects mismatched or oversized wallpaper files", () => {
  const manifest = { version: 1, name: "Ink" };
  const theme = importTheme(strToU8(JSON.stringify(manifest)));
  assert.equal(theme.image, null);
  assert.equal(theme.theme.name, "Ink");
  const headers = strToU8(
    JSON.stringify({ ...manifest, wallpaper: { file: "wallpaper.gif" } }),
  );
  assert.throws(() => importTheme(zipSync({ "theme.json": headers })), /缺少/);
  assert.throws(
    () =>
      importTheme(
        zipSync({
          "theme.json": headers,
          "wallpaper.gif": new Uint8Array(imageLimit + 1),
        }),
      ),
    /缺少/,
  );
  assert.throws(
    () =>
      importTheme(
        zipSync({
          "theme.json": headers,
          "wallpaper.gif": Uint8Array.of(255, 216, 255),
        }),
      ),
    /不匹配/,
  );
});

test("changes colors and wallpaper without layout rules and respects reduced animation", () => {
  const theme = defaultTheme();
  const regular = stylesheet(theme, gif, "rgb(255, 255, 255)", false);
  assert.match(regular, /background-image:linear-gradient/);
  assert.match(regular, /conversation-composer/);
  assert.match(regular, /--eta-canvas:#111c2b/);
  assert.doesNotMatch(
    stylesheet(theme, gif, "rgb(255, 255, 255)", true),
    /data:image/,
  );
  assert.equal(showWallpaper(jpeg, true), true);
});

test("keeps exact site origins without retaining credentials or query parameters", () => {
  const origin = webOrigin(
    "https://person:password@local.test:8787/tasks?token=example",
  );
  assert.equal(origin, "https://local.test:8787");
  assert.equal(sitePattern(origin), "https://local.test/*");
  assert.equal(webOrigin("file:///tmp/eta.html"), null);
});
