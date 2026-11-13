/**
 * The test host's model gateway: every connector that would log in to a provider on the internet
 * points at a local address unless a test gives it a fake, so no test reaches the provider.
 */
import { describe, expect, it } from "vitest";
import { withHostWire } from "./ext-support/host-wire";
import { offlineGateway, testHost, UNREACHABLE } from "./support/host";

const FAKE = "http://127.0.0.1:12345";
const OFFLINE = { codexIssuer: UNREACHABLE, gemini: UNREACHABLE };

describe("offlineGateway", () => {
  it("leaves a host without the gateway without it", () => {
    expect(offlineGateway(undefined)).toBeUndefined();
    expect(offlineGateway(false)).toBe(false);
  });

  it("points every connector at the unreachable address when the test names none", () => {
    expect(offlineGateway(true)).toEqual({ endpoints: OFFLINE });
    expect(offlineGateway({})).toEqual({ endpoints: OFFLINE });
    expect(offlineGateway({ endpoints: {} })).toEqual({ endpoints: OFFLINE });
  });

  it("keeps the fakes a test names and fills in the rest", () => {
    expect(offlineGateway({ endpoints: { gemini: FAKE } })).toEqual({
      endpoints: { codexIssuer: UNREACHABLE, gemini: FAKE },
    });
    expect(offlineGateway({ endpoints: { codexIssuer: FAKE } })).toEqual({
      endpoints: { codexIssuer: FAKE, gemini: UNREACHABLE },
    });
  });

  it("keeps the rest of the gateway's options", () => {
    const cpaExtra = { debug: true } as never;
    expect(offlineGateway({ cpaExtra })).toEqual({
      cpaExtra,
      endpoints: OFFLINE,
    });
  });
});

describe("a test host with the gateway and only a Google fake", () => {
  it("cannot start a Codex login: OpenAI's login server is the unreachable address", async () => {
    const host = await testHost({
      overrides: { llm: { endpoints: { gemini: FAKE } } },
    });
    const failure = await withHostWire(host, (wire) =>
      wire
        .call(
          "llm",
          "loginStart",
          { connector: "codex" },
          { timeoutMs: 30_000 },
        )
        .then(
          () => "started",
          (error: unknown) => String(error),
        ),
    );
    expect(failure).toContain("Could not start the Codex login");
  }, 90_000);
});
