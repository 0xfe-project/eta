import type { Server } from "bun";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  probeRemote,
  remoteHealth,
  remotePage,
  watchRemote,
} from "../src/bun/remote";

const TOKEN = "the-token";
const servers: Server<undefined>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);
  vi.useRealTimers();
});

function serve(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
}

/** What `access.ts` and `http.ts` answer. */
const host = (pathname: string, request: Request): Response => {
  if (pathname === "/up") return new Response("ok");
  if (request.headers.get("x-eta-token") !== TOKEN)
    return new Response("unauthorized", { status: 401 });
  if (pathname === "/upgrade/status") return Response.json(null);
  return new Response("<!doctype html>", {
    headers: { "content-type": "text/html" },
  });
};
const aHost = () =>
  serve((request) => host(new URL(request.url).pathname, request));

describe("probing a host", () => {
  it("opens a host that takes the token", async () => {
    const address = aHost();
    await expect(probeRemote({ address, token: TOKEN })).resolves.toEqual({
      ok: true,
      origin: address,
    });
  });

  it("says when the token is wrong", async () => {
    await expect(
      probeRemote({ address: aHost(), token: "other" }),
    ).resolves.toEqual({ ok: false, failure: "token" });
  });

  it("says when a token is needed and there is none", async () => {
    await expect(probeRemote({ address: aHost(), token: "" })).resolves.toEqual(
      { ok: false, failure: "token" },
    );
  });

  it("says when nothing listens there", async () => {
    const address = aHost();
    void servers.pop()?.stop(true);
    await expect(probeRemote({ address, token: TOKEN })).resolves.toMatchObject(
      { ok: false, failure: "unreachable" },
    );
  });

  it("says when an address is not one", async () => {
    await expect(
      probeRemote({ address: "not a url at all", token: "" }),
    ).resolves.toEqual({ ok: false, failure: "address" });
  });

  it("says when what answers is not a host", async () => {
    const address = serve(() => new Response("hello"));
    await expect(probeRemote({ address, token: "" })).resolves.toEqual({
      ok: false,
      failure: "not-eta",
    });
  });

  it("says when a host has no page to show", async () => {
    const address = serve(({ url }) =>
      new URL(url).pathname === "/up"
        ? new Response("ok")
        : new Response("no page", { status: 404 }),
    );
    await expect(probeRemote({ address, token: "" })).resolves.toEqual({
      ok: false,
      failure: "no-page",
    });
  });

  it("does not wait forever for a host that takes the call and says nothing", async () => {
    const address = serve(() => new Promise<Response>(() => {}));
    await expect(
      probeRemote({ address, token: "" }, 50),
    ).resolves.toMatchObject({ ok: false, failure: "timeout" });
  });

  it("ends on the origin that answers, which is the one the page will have", async () => {
    const real = aHost();
    const address = serve(() => Response.redirect(`${real}/up`, 301));
    await expect(probeRemote({ address, token: TOKEN })).resolves.toEqual({
      ok: true,
      origin: real,
    });
  });

  it("does not send the token to /up, which needs none", async () => {
    const heard: (string | null)[] = [];
    const address = serve((request) => {
      if (new URL(request.url).pathname === "/up")
        heard.push(request.headers.get("x-eta-token"));
      return host(new URL(request.url).pathname, request);
    });
    await probeRemote({ address, token: TOKEN });
    expect(heard).toEqual([null]);
  });
});

describe("the page's address", () => {
  it("logs in with the token, escaped", () => {
    expect(remotePage({ address: "https://h", token: "a+b/c" })).toBe(
      "https://h/?token=a%2Bb%2Fc",
    );
  });

  it("is the bare origin on a host with no gate", () => {
    expect(remotePage({ address: "http://h:1", token: "" })).toBe(
      "http://h:1/",
    );
  });
});

describe("a host's health", () => {
  it("is up", async () => {
    await expect(
      remoteHealth({ address: aHost(), token: TOKEN }),
    ).resolves.toBe("up");
  });

  it("notices an upgrade", async () => {
    const address = serve(() => Response.json({ state: "running" }));
    await expect(remoteHealth({ address, token: "" })).resolves.toBe(
      "upgrading",
    );
  });

  it("notices a token that stopped working", async () => {
    await expect(
      remoteHealth({ address: aHost(), token: "old" }),
    ).resolves.toBe("token");
  });

  it("takes a proxy's answer for a host that is down", async () => {
    const address = serve(() => new Response("bad gateway", { status: 502 }));
    await expect(remoteHealth({ address, token: "" })).resolves.toBe("down");
  });

  it("is up on a host from before /upgrade/status, which answers with its page", async () => {
    const address = serve(() => new Response("<!doctype html>"));
    await expect(remoteHealth({ address, token: "" })).resolves.toBe("up");
  });
});

describe("watching a host", () => {
  const INTERVAL = 5_000;
  const downs = (count: number) => new Array<string>(count).fill("down");
  const run = (answers: string[]) => {
    vi.useFakeTimers();
    const onLost = vi.fn();
    const health = vi.fn(
      async () =>
        (answers.shift() ?? "up") as "up" | "upgrading" | "token" | "down",
    );
    const stop = watchRemote({ health, onLost });
    return { health, onLost, stop };
  };
  const looks = (count: number) =>
    vi.advanceTimersByTimeAsync(count * INTERVAL);

  it("waits out a short drop, which the page has its own banner for", async () => {
    const { onLost } = run(["down", "down", "up", "down", "down"]);
    await looks(5);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("gives up after 30 seconds of misses in a row", async () => {
    const { onLost } = run(downs(10));
    await looks(5);
    expect(onLost).not.toHaveBeenCalled();
    await looks(1);
    expect(onLost).toHaveBeenCalledExactlyOnceWith("lost");
  });

  it("does not stay on after giving up", async () => {
    const { health, onLost } = run(downs(20));
    await looks(10);
    expect(health).toHaveBeenCalledTimes(6);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("says at once when the token stopped working", async () => {
    const { onLost } = run(["token"]);
    await looks(1);
    expect(onLost).toHaveBeenCalledExactlyOnceWith("token");
  });

  it("lets the page wait out an upgrade's restart", async () => {
    const { onLost } = run(["upgrading", ...downs(100)]);
    await looks(101);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("gives up on an upgrade that never comes back", async () => {
    const { onLost } = run(["upgrading", ...downs(200)]);
    await looks(121);
    expect(onLost).toHaveBeenCalledExactlyOnceWith("lost");
  });

  it("is quiet once stopped", async () => {
    const { onLost, stop } = run(downs(10));
    await looks(3);
    stop();
    await looks(10);
    expect(onLost).not.toHaveBeenCalled();
  });
});
