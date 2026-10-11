import { afterEach, expect, it, rstest } from "@rstest/core";
import { checkForUpdate } from "./update";

const { toast } = rstest.hoisted(() => ({ toast: rstest.fn() }));
rstest.mock("sonner", () => ({ toast }));

function serve(build: string) {
  const fetch = rstest.fn(async () => new Response(build));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

afterEach(() => {
  toast.mockClear();
});

it("stays quiet while the server runs this build", async () => {
  const fetch = serve("test");
  await checkForUpdate();
  expect(fetch).toHaveBeenCalledWith("/version", { cache: "no-store" });
  expect(toast).not.toHaveBeenCalled();
});

it("stays quiet when the server cannot say", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("offline");
  }) as unknown as typeof globalThis.fetch;
  await checkForUpdate();
  expect(toast).not.toHaveBeenCalled();
});

it("offers a reload once after a deploy", async () => {
  serve("newer");
  await checkForUpdate();
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast.mock.calls[0]![1]).toMatchObject({
    action: { label: "刷新" },
  });
  await checkForUpdate();
  expect(toast).toHaveBeenCalledTimes(1);
});
