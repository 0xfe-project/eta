/**
 * `plugins.logo` for a market entry: the client sends `homepage: null` for an entry that has none
 * (every Cursor entry), so the call must take null, a string, or no field alike.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logos } from "../src/plugins/logo";
import { pluginsPlugin } from "../src/plugins/plugin";

const REPO = "https://github.com/cursor/plugins";
const PNG = { type: "image/png", data: "iVBORw0KGgo=" };

afterEach(() => vi.restoreAllMocks());

function handler() {
  const handlers = new Map<string, (call: unknown) => unknown>();
  const wire = new Proxy(
    {
      handle: (target: string, action: string, run: never) => {
        handlers.set(`${target}.${action}`, run);
        return () => {};
      },
    } as Record<string, unknown>,
    { get: (self, key: string) => self[key] ?? (() => () => {}) },
  );
  pluginsPlugin(
    { plugins: {} as never, agents: {} as never, market: {} as never },
    () => {},
  ).apply({ wire, sessions: {}, effect: (run: () => unknown) => run() });
  const run = handlers.get("plugins.logo")!;
  return (args: Record<string, unknown>) =>
    run({ target: "plugins", action: "logo", args });
}

describe("plugins.logo of a market entry", () => {
  it("takes homepage null and asks for the entry's own logo", async () => {
    const forEntry = vi
      .spyOn(Logos.prototype, "forEntry")
      .mockResolvedValue(PNG as never);
    const logo = handler();
    await expect(
      logo({
        repo: REPO,
        ref: "abc",
        path: "plugins/teaching",
        homepage: null,
      }),
    ).resolves.toEqual({ result: PNG });
    expect(forEntry).toHaveBeenCalledWith(
      REPO,
      "abc",
      "plugins/teaching",
      null,
    );
  });

  it("keeps a homepage string, and no homepage field is the same as null", async () => {
    const forEntry = vi
      .spyOn(Logos.prototype, "forEntry")
      .mockResolvedValue(PNG as never);
    const logo = handler();
    await logo({
      repo: REPO,
      ref: "abc",
      path: "p",
      homepage: "https://a.test",
    });
    await logo({ repo: REPO, ref: "abc", path: "p" });
    expect(forEntry.mock.calls.map((call) => call[3])).toEqual([
      "https://a.test",
      null,
    ]);
  });

  it("still refuses a homepage that is neither a string nor null", async () => {
    vi.spyOn(Logos.prototype, "forEntry").mockResolvedValue(PNG as never);
    const logo = handler();
    await expect(
      Promise.resolve().then(() =>
        logo({ repo: REPO, path: "p", homepage: 3 }),
      ),
    ).rejects.toThrow("homepage must be a string");
  });
});
