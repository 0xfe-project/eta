/**
 * Who may reach the host: the Origin check on the socket, and the token gate.
 *
 * The Origin header is set by hand here. A browser would set it itself and a page cannot forge
 * it, which is the whole point of checking it; a script that sets its own is not who the check
 * is for, and passes anyway when it sends none.
 */
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAccess, isLoopback } from "../src/access";
import { connect } from "./support/client";
import { fakeWeb, tempDir, testHost } from "./support/host";

const TOKEN = "correct-horse-battery-staple";

async function tokenFile(contents = TOKEN): Promise<string> {
  const path = join(await tempDir("eta-token-"), "token");
  await writeFile(path, `${contents}\n`, { mode: 0o600 });
  return path;
}

/** Opens a socket and reports how the handshake went. */
async function handshake(
  url: string,
  headers: Record<string, string> = {},
): Promise<"open" | "refused"> {
  try {
    const client = await connect(url, headers);
    client.close();
    return "open";
  } catch {
    return "refused";
  }
}

describe("the Origin check", () => {
  it("lets a non-browser client in: no Origin header", async () => {
    const host = await testHost();
    expect(await handshake(`ws://127.0.0.1:${host.port}/ws`)).toBe("open");
  });

  it("lets the page in that this host serves: its Origin is the origin it asked", async () => {
    const host = await testHost({ webDir: await fakeWeb() });
    expect(
      await handshake(`ws://127.0.0.1:${host.port}/ws`, {
        origin: `http://127.0.0.1:${host.port}`,
      }),
    ).toBe("open");
    expect(
      await handshake(`ws://localhost:${host.port}/ws`, {
        origin: `http://localhost:${host.port}`,
      }),
    ).toBe("open");
  });

  it("refuses a page from another origin with 403", async () => {
    const host = await testHost();
    const url = `ws://127.0.0.1:${host.port}/ws`;
    for (const origin of [
      "https://evil.example",
      `http://127.0.0.1:${host.port + 1}`,
      `https://127.0.0.1:${host.port}`,
      "null",
    ]) {
      expect(await handshake(url, { origin })).toBe("refused");
    }
    // The refusal is a plain 403 before any socket exists.
    const response = await fetch(`http://127.0.0.1:${host.port}/ws`, {
      headers: { origin: "https://evil.example", upgrade: "websocket" },
    });
    expect(response.status).toBe(403);
    expect(host.server.server.clients).toBe(0);
  });

  it("lets in an origin it was told about, and only that one", async () => {
    const host = await testHost({ allowOrigins: ["http://127.0.0.1:3000"] });
    const url = `ws://127.0.0.1:${host.port}/ws`;
    expect(await handshake(url, { origin: "http://127.0.0.1:3000" })).toBe(
      "open",
    );
    expect(await handshake(url, { origin: "http://127.0.0.1:3001" })).toBe(
      "refused",
    );
  });

  it("does not take a rebound name for its own origin on a loopback host", async () => {
    const host = await testHost();
    // An attacker's domain resolved to 127.0.0.1 sends its own name as Host and as Origin.
    const response = await fetch(`http://127.0.0.1:${host.port}/ws`, {
      headers: {
        host: `evil.example:${host.port}`,
        origin: `http://evil.example:${host.port}`,
        upgrade: "websocket",
      },
    });
    expect(response.status).toBe(403);
  });

  it("refuses an Origin whose Host header is garbage rather than failing", async () => {
    const access = createAccess({ hostname: "127.0.0.1", dataDir: "/unused" });
    const response = access.authorize(
      new Request("http://127.0.0.1/ws", {
        headers: { host: "not a host", origin: "http://not a host" },
      }),
    );
    expect(response?.status).toBe(403);
  });

  it("only checks the socket: a page is not refused for its Origin", async () => {
    const host = await testHost();
    const response = await fetch(`http://127.0.0.1:${host.port}/up`, {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(200);
  });
});

describe("the token gate", () => {
  it("is off on a loopback host without a token file", async () => {
    const host = await testHost({ webDir: await fakeWeb() });
    expect(host.tokenFile).toBeUndefined();
    expect((await fetch(`http://127.0.0.1:${host.port}/`)).status).toBe(200);
  });

  it("asks for the token on every route but /up, the socket included", async () => {
    const host = await testHost({
      webDir: await fakeWeb(),
      tokenFile: await tokenFile(),
    });
    const origin = `http://127.0.0.1:${host.port}`;
    expect(await (await fetch(`${origin}/up`)).text()).toBe("ok");
    for (const path of ["/", "/version", "/assets/app-abc123.js", "/nope"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await handshake(`ws://127.0.0.1:${host.port}/ws`)).toBe("refused");
    expect(host.server.server.clients).toBe(0);
  });

  it("accepts the token as X-Eta-Token, for the phone's socket", async () => {
    const host = await testHost({
      webDir: await fakeWeb(),
      tokenFile: await tokenFile(),
    });
    const socket = `ws://127.0.0.1:${host.port}/ws`;
    expect(await handshake(socket, { "x-eta-token": TOKEN })).toBe("open");
    expect(await handshake(socket, { "x-eta-token": `${TOKEN}x` })).toBe(
      "refused",
    );
  });

  it("accepts the token as a bearer, for pages and for the socket", async () => {
    const host = await testHost({
      webDir: await fakeWeb(),
      tokenFile: await tokenFile(),
    });
    const bearer = { authorization: `Bearer ${TOKEN}` };
    const page = await fetch(`http://127.0.0.1:${host.port}/version`, {
      headers: bearer,
    });
    expect(await page.text()).toBe("b1");
    expect(await handshake(`ws://127.0.0.1:${host.port}/ws`, bearer)).toBe(
      "open",
    );
    // A wrong token is not a near miss.
    for (const wrong of [`Bearer ${TOKEN}x`, "Bearer ", TOKEN.slice(1)]) {
      const response = await fetch(`http://127.0.0.1:${host.port}/version`, {
        headers: { authorization: wrong },
      });
      expect(response.status).toBe(401);
    }
  });

  it("trades /?token=… for a cookie and redirects to a URL without it", async () => {
    const host = await testHost({
      webDir: await fakeWeb(),
      tokenFile: await tokenFile(),
    });
    const origin = `http://127.0.0.1:${host.port}`;
    const exchange = await fetch(`${origin}/workspace?token=${TOKEN}&tab=1`, {
      redirect: "manual",
    });
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe("/workspace?tab=1");
    const setCookie = exchange.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Secure/);
    // The cookie is not the token.
    const cookie = (setCookie.split(";")[0] ?? "").trim();
    expect(cookie).not.toContain(TOKEN);

    // With it, pages and the socket open.
    const page = await fetch(`${origin}/workspace`, {
      headers: { cookie },
    });
    expect(page.status).toBe(200);
    expect(
      await handshake(`ws://127.0.0.1:${host.port}/ws`, {
        cookie,
        origin,
      }),
    ).toBe("open");

    // A wrong token in the URL grants nothing.
    const wrong = await fetch(`${origin}/?token=nope`, { redirect: "manual" });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    // And a cookie that is not the one is no better than none.
    const forged = await fetch(`${origin}/`, {
      headers: { cookie: "eta_session=forged" },
    });
    expect(forged.status).toBe(401);
  });

  it("never redirects off the host", async () => {
    const host = await testHost({ tokenFile: await tokenFile() });
    const response = await fetch(
      `http://127.0.0.1:${host.port}//evil.example/x?token=${TOKEN}`,
      { redirect: "manual" },
    );
    expect(response.headers.get("location")).toBe("/evil.example/x");
  });

  it("marks the cookie Secure behind a proxy that terminates TLS", async () => {
    const host = await testHost({ tokenFile: await tokenFile() });
    const response = await fetch(
      `http://127.0.0.1:${host.port}/?token=${TOKEN}`,
      { redirect: "manual", headers: { "x-forwarded-proto": "https" } },
    );
    expect(response.headers.get("set-cookie")).toMatch(/; Secure/);
  });

  it("does not take the token from the socket's URL", async () => {
    const host = await testHost({ tokenFile: await tokenFile() });
    expect(
      await handshake(`ws://127.0.0.1:${host.port}/ws?token=${TOKEN}`),
    ).toBe("refused");
  });

  it("still checks the Origin of a socket that has the token", async () => {
    const host = await testHost({ tokenFile: await tokenFile() });
    expect(
      await handshake(`ws://127.0.0.1:${host.port}/ws`, {
        authorization: `Bearer ${TOKEN}`,
        origin: "https://evil.example",
      }),
    ).toBe("refused");
  });
});

describe("the token file", () => {
  it("is created with mode 0600 when missing, and kept between starts", async () => {
    const dir = await tempDir("eta-token-");
    const path = join(dir, "state", "token");
    const first = await testHost({ tokenFile: path });
    expect(first.tokenFile).toBe(path);
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    const token = (await readFile(path, "utf8")).trim();
    expect(token.length).toBeGreaterThanOrEqual(16);
    await first.close();

    const second = await testHost({ tokenFile: path });
    expect((await readFile(path, "utf8")).trim()).toBe(token);
    const response = await fetch(`http://127.0.0.1:${second.port}/`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(404);
  });

  it("is tightened to 0600 when it was looser", async () => {
    const path = await tokenFile();
    await chmod(path, 0o644);
    await testHost({ tokenFile: path });
    if (process.platform !== "win32")
      expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("refuses a token too short to be a secret, and stops the host from starting", async () => {
    const path = await tokenFile("short");
    await expect(testHost({ tokenFile: path })).rejects.toThrow(/shorter/);
  });
});

describe("a host beyond loopback", () => {
  it("turns the gate on by itself, with a token file in the data directory", async () => {
    const dataDir = await tempDir();
    const access = createAccess({ hostname: "0.0.0.0", dataDir });
    expect(access.tokenFile).toBe(join(dataDir, "access-token"));
    const token = (
      await readFile(join(dataDir, "access-token"), "utf8")
    ).trim();

    const page = (headers: Record<string, string> = {}) =>
      access.authorize(new Request("http://eta.example/", { headers }));
    expect(page()?.status).toBe(401);
    expect(page({ authorization: `Bearer ${token}` })).toBeUndefined();
    // /up is how a supervisor asks, and it has no token to send.
    expect(
      access.authorize(new Request("http://eta.example/up")),
    ).toBeUndefined();
    // The gateway has no route of its own: /llm is behind the gate like any other path.
    expect(
      access.authorize(new Request("http://eta.example/llm/v1/models"))?.status,
    ).toBe(401);
    // GitHub sends the browser back to exactly two paths, with no cookie of ours, to read only.
    for (const path of [
      "/github/manifest/callback?code=c&state=s",
      "/github/authorization/callback?code=c&state=s",
    ])
      expect(
        access.authorize(new Request(`http://eta.example${path}`)),
      ).toBeUndefined();
    for (const request of [
      new Request("http://eta.example/github/manifest/callback", {
        method: "POST",
      }),
      new Request("http://eta.example/github/manifest/callback/x"),
      new Request("http://eta.example/github/callback"),
      new Request("http://eta.example/github"),
    ])
      expect(access.authorize(request)?.status).toBe(401);
  });

  it("trusts the origin it was asked for, because a rebound name has no cookie", async () => {
    const access = createAccess({
      hostname: "0.0.0.0",
      dataDir: await tempDir(),
    });
    const token = (await readFile(access.tokenFile as string, "utf8")).trim();
    const socket = (origin: string) =>
      access.authorize(
        new Request("http://eta.example/ws", {
          headers: { authorization: `Bearer ${token}`, origin },
        }),
      );
    expect(socket("http://eta.example")).toBeUndefined();
    expect(socket("http://other.example")?.status).toBe(403);
  });

  it("leaves a loopback host with an explicit token file gated all the same", async () => {
    const access = createAccess({
      hostname: "127.0.0.1",
      dataDir: await tempDir(),
      tokenFile: await tokenFile(),
    });
    expect(access.authorize(new Request("http://127.0.0.1/"))?.status).toBe(
      401,
    );
  });
});

describe("isLoopback", () => {
  it("knows the names only this machine can reach", () => {
    for (const name of [
      "127.0.0.1",
      "127.1.2.3",
      "localhost",
      "LOCALHOST",
      "::1",
      "[::1]",
    ]) {
      expect(isLoopback(name)).toBe(true);
    }
    for (const name of [
      "0.0.0.0",
      "::",
      "192.168.1.5",
      "eta.example.com",
      "127.0.0.1.evil.example",
    ]) {
      expect(isLoopback(name)).toBe(false);
    }
  });
});
