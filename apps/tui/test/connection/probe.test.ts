/** Probes against real hosts: one open on loopback, one behind the token gate. */
import { describe, expect, it } from "vitest";
import { checkAddress, probeToken, probeUp } from "../../src/connection/probe";
import { baseUrl, closedPort, testHost } from "../support/host";

const TOKEN = "tok-0123456789abcdef";
const TIMEOUT = 1_500;

/** A loopback server that accepts connections and never answers. */
function silentServer(): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Promise<Response>(() => undefined),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => void server.stop(true),
  };
}

/** A loopback server that answers every path with one status and body. */
function fixedServer(
  status: number,
  body: string,
): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(body, { status }),
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => void server.stop(true),
  };
}

describe("probeUp", () => {
  it("is true for a live host, gated or not", async () => {
    expect(await probeUp(baseUrl(await testHost()), TIMEOUT)).toBe(true);
    expect(
      await probeUp(baseUrl(await testHost({ token: TOKEN })), TIMEOUT),
    ).toBe(true);
  });

  it("is false for a 200 that does not say ok, and for an ok that is not 200", async () => {
    const wrongBody = fixedServer(200, "hello");
    const wrongStatus = fixedServer(503, "ok");
    try {
      expect(await probeUp(wrongBody.url, TIMEOUT)).toBe(false);
      expect(await probeUp(wrongStatus.url, TIMEOUT)).toBe(false);
    } finally {
      wrongBody.stop();
      wrongStatus.stop();
    }
  });

  it("gives up after its timeout on a server that never answers", async () => {
    const silent = silentServer();
    try {
      const started = Date.now();
      expect(await probeUp(silent.url, 200)).toBe(false);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      silent.stop();
    }
  });
});

describe("probeToken", () => {
  it("is unreachable where nothing listens or nothing answers in time", async () => {
    expect(
      await probeToken(
        `http://127.0.0.1:${await closedPort()}`,
        undefined,
        TIMEOUT,
      ),
    ).toBe("unreachable");
    const silent = silentServer();
    try {
      expect(await probeToken(silent.url, undefined, 200)).toBe("unreachable");
    } finally {
      silent.stop();
    }
  });

  it("passes on any status other than 401", async () => {
    for (const status of [200, 403, 404, 500]) {
      const server = fixedServer(status, "x");
      try {
        expect(
          await probeToken(server.url, undefined, TIMEOUT),
          String(status),
        ).toBe("pass");
      } finally {
        server.stop();
      }
    }
  });
});

describe("checkAddress", () => {
  it("is invalid for what is not an address", async () => {
    expect(await checkAddress("ftp://h", undefined, TIMEOUT)).toEqual({
      result: "invalid",
    });
  });

  it("is ok for an open host, with the normalised address", async () => {
    const host = await testHost();
    expect(
      await checkAddress(`ws://127.0.0.1:${host.port}/ws `, undefined, TIMEOUT),
    ).toEqual({ result: "ok", url: baseUrl(host) });
  });

  it("asks for a token, refuses a wrong one and takes the right one", async () => {
    const host = await testHost({ token: TOKEN });
    const url = baseUrl(host);
    expect(
      await checkAddress(`127.0.0.1:${host.port}`, undefined, TIMEOUT),
    ).toEqual({
      result: "needs-token",
      url,
    });
    expect(await checkAddress(url, "wrong-token-000000", TIMEOUT)).toEqual({
      result: "bad-token",
      url,
    });
    expect(await checkAddress(url, TOKEN, TIMEOUT)).toEqual({
      result: "ok",
      url,
    });
  });

  it("is unreachable where nothing listens", async () => {
    const url = `http://127.0.0.1:${await closedPort()}`;
    expect(await checkAddress(`${url}/`, undefined, TIMEOUT)).toEqual({
      result: "unreachable",
      url,
    });
  });
});
