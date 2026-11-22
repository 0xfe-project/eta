import { expect, open, test } from "nsh/test";

test("the wheel is taken over by the native Windows app only", async () => {
  for (const platform of ["macos", "linux", "ios", "android", "web"] as const) {
    const app = await open("./fixtures/wheel-platform.tsx", { platform });
    expect(app.shows("text:wheel: native")).toBe(true);
  }
  const app = await open("./fixtures/wheel-platform.tsx", {
    platform: "windows",
  });
  expect(app.shows("text:wheel: glides")).toBe(true);
});
