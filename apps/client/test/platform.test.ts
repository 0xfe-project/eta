import { expect, open, test } from "nsh/test";
import { isWindows } from "../src/app/platform";

test("native apps take NSH's own platform", () => {
  expect(isWindows("windows")).toBe(true);
  for (const os of ["macos", "linux", "ios", "android"])
    expect(isWindows(os)).toBe(false);
});

test("a browser on Windows counts, from its client hints first", () => {
  expect(isWindows("web", { userAgentData: { platform: "Windows" } })).toBe(
    true,
  );
  expect(isWindows("web", { platform: "Win32" })).toBe(true);
  expect(
    isWindows("web", {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }),
  ).toBe(true);
});

test("browsers elsewhere do not", () => {
  const others = [
    { userAgentData: { platform: "macOS" } },
    { userAgentData: { platform: "Linux" } },
    { userAgentData: { platform: "Android" } },
    { platform: "MacIntel" },
    { platform: "Linux x86_64" },
    { platform: "iPhone" },
    {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
    },
    {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    },
    {
      userAgent:
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    },
    { userAgent: "Darwin" },
    {},
  ];
  for (const navigator of others)
    expect(isWindows("web", navigator)).toBe(false);
  expect(isWindows("web")).toBe(false);
});

test("the client hints win over a stale navigator.platform", () => {
  expect(
    isWindows("web", {
      userAgentData: { platform: "macOS" },
      platform: "Win32",
    }),
  ).toBe(false);
});

test("the wheel is taken over on Windows only", async () => {
  for (const platform of ["macos", "linux", "ios", "android", "web"] as const) {
    const app = await open("./fixtures/wheel-platform.tsx", { platform });
    expect(app.shows("text:wheel: native")).toBe(true);
  }
  const app = await open("./fixtures/wheel-platform.tsx", {
    platform: "windows",
  });
  expect(app.shows("text:wheel: glides")).toBe(true);
});
