import { afterEach, beforeAll, expect, it, rstest } from "@rstest/core";
import { watchForUpdates } from "./update";

const { toast } = rstest.hoisted(() => ({ toast: rstest.fn() }));
rstest.mock("sonner", () => ({ toast }));

function serve(build: string) {
  const fetch = rstest.fn(async () => new Response(build));
  globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
  return fetch;
}

/** The tab coming back into view: the moment the app compares builds. */
async function shown() {
  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(() => {
  watchForUpdates();
});

afterEach(() => {
  toast.mockClear();
});

it("stays quiet while the server runs this build", async () => {
  const fetch = serve("test");
  await shown();
  expect(fetch).toHaveBeenCalledWith("/version", { cache: "no-store" });
  expect(toast).not.toHaveBeenCalled();
});

it("stays quiet when the server cannot say", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("offline");
  }) as unknown as typeof globalThis.fetch;
  await shown();
  expect(toast).not.toHaveBeenCalled();
});

it("offers a reload once after a deploy", async () => {
  serve("newer");
  await shown();
  expect(toast).toHaveBeenCalledTimes(1);
  expect(toast.mock.calls[0]![1]).toMatchObject({
    action: { label: "刷新" },
  });
  await shown();
  expect(toast).toHaveBeenCalledTimes(1);
});
