import { expect, it } from "@rstest/core";
import { handleWebApi } from "./http.ts";

it("answers health and the current build id", async () => {
  const up = await handleWebApi(new Request("http://web/up"), "build-1");
  expect(up?.status).toBe(200);
  expect(await up?.text()).toBe("ok");

  const version = await handleWebApi(
    new Request("http://web/version"),
    "build-1",
  );
  expect(version?.headers.get("Cache-Control")).toBe("no-store");
  expect(await version?.text()).toBe("build-1");
});

it("leaves page and asset requests to the static / SPA server", async () => {
  expect(
    await handleWebApi(new Request("http://web/workspace/tasks"), "build-1"),
  ).toBeNull();
  expect(
    await handleWebApi(new Request("http://web/assets/app.js"), "build-1"),
  ).toBeNull();
});
