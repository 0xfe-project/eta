import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
/**
 * The Cursor sign-in (unofficial): a fake Cursor, no network. Covers 404 then 200, the deadline,
 * cancel, a redirect, the verifier matching the challenge, and the token staying out of every
 * answer.
 */
import { describe, expect, it } from "vitest";
import {
  CursorLogin,
  cursorLoginAllowed,
  isCursorServer,
  jwtValidFor,
} from "../src/plugins/cursor-login";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (exp: number) =>
  `${b64({ alg: "none" })}.${b64({ exp })}.sig-SECRET`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fake api2.cursor.sh: answers per call from `replies`, records every address asked. */
function fake(replies: (n: number) => Response | Promise<Response>) {
  const seen: string[] = [];
  const impl = (async (input: unknown) => {
    seen.push(String(input));
    return replies(seen.length);
  }) as typeof fetch;
  return { seen, impl };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status });

describe("cursor sign-in", () => {
  it("polls until the browser confirmed, then hands over the token once", async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    const f = fake((n) =>
      n < 3 ? json(404, {}) : json(200, { accessToken: token }),
    );
    const got: string[] = [];
    const login = new CursorLogin({ fetchImpl: f.impl, pollEveryMs: 5 });
    const { id, url } = login.start((t) => got.push(t));
    await wait(100);
    const status = login.status(id);
    expect(status.state).toBe("done");
    expect(status.validForSeconds).toBeGreaterThan(3000);
    expect(got).toEqual([token]);
    expect(JSON.stringify(status)).not.toContain("SECRET");
    expect(f.seen.length).toBe(3);

    // The page address and the poll agree: sha256(verifier) is the challenge.
    const page = new URL(url);
    expect(page.origin + page.pathname).toBe(
      "https://cursor.com/loginDeepControl",
    );
    const poll = new URL(f.seen[0] as string);
    expect(poll.origin + poll.pathname).toBe(
      "https://api2.cursor.sh/auth/poll",
    );
    expect(poll.searchParams.get("uuid")).toBe(page.searchParams.get("uuid"));
    const verifier = poll.searchParams.get("verifier") as string;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      page.searchParams.get("challenge"),
    );
    // The verifier is not in the page address.
    expect(url).not.toContain(verifier);
  });

  it("allows one sign-in at a time", async () => {
    const f = fake(() => json(404, {}));
    const login = new CursorLogin({ fetchImpl: f.impl, pollEveryMs: 5 });
    const a = login.start(() => {});
    expect(() => login.start(() => {})).toThrow(/already/);
    login.cancel(a.id);
    expect(() => login.start(() => {})).not.toThrow();
  });

  it("gives up at the deadline", async () => {
    const f = fake(() => json(404, {}));
    const login = new CursorLogin({
      fetchImpl: f.impl,
      pollEveryMs: 5,
      timeoutMs: 40,
    });
    const { id } = login.start(() => {});
    await wait(150);
    expect(login.status(id).state).toBe("expired");
  });

  it("can be cancelled, and then asks no more", async () => {
    const f = fake(() => json(404, {}));
    const got: string[] = [];
    const login = new CursorLogin({ fetchImpl: f.impl, pollEveryMs: 5 });
    const { id } = login.start((t) => got.push(t));
    await wait(30);
    login.cancel(id);
    const asked = f.seen.length;
    await wait(60);
    expect(login.status(id).state).toBe("cancelled");
    expect(f.seen.length).toBeLessThanOrEqual(asked + 1);
    expect(got).toEqual([]);
  });

  it("fails on a redirect, an odd answer or a token that cannot be saved, with a reason and no secret", async () => {
    const run = async (
      reply: () => Response,
      onToken: (t: string) => void = () => {},
    ) => {
      const login = new CursorLogin({
        fetchImpl: fake(reply).impl,
        pollEveryMs: 5,
      });
      const { id } = login.start(onToken);
      await wait(60);
      return login.status(id);
    };
    const redirect = await run(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/" },
        }),
    );
    expect(redirect.state).toBe("failed");
    expect(redirect.reason).toContain("redirect");
    expect(JSON.stringify(redirect)).not.toContain("evil");
    expect((await run(() => json(500, {}))).reason).toContain("500");
    expect((await run(() => json(200, { nope: 1 }))).reason).toContain(
      "accessToken",
    );
    const token = jwt(Math.floor(Date.now() / 1000) + 60);
    const unsaved = await run(
      () => json(200, { accessToken: token }),
      () => {
        throw new Error("no such server");
      },
    );
    expect(unsaved.state).toBe("failed");
    expect(JSON.stringify(unsaved)).not.toContain("SECRET");
  });

  it("a network error names its kind and not the address (which carries the verifier)", async () => {
    const login = new CursorLogin({
      fetchImpl: (async (input: unknown) => {
        throw new Error(`connect failed for ${String(input)}`);
      }) as unknown as typeof fetch,
      pollEveryMs: 5,
    });
    const { id } = login.start(() => {});
    await wait(40);
    const status = login.status(id);
    expect(status.state).toBe("failed");
    expect(status.reason).not.toContain("verifier");
    expect(status.reason).not.toContain("uuid");
  });

  it("only two https hosts are allowed, and only Cursor servers get the credential", () => {
    expect(cursorLoginAllowed("https://cursor.com/x")).toBe(true);
    expect(cursorLoginAllowed("https://api2.cursor.sh/auth/poll?a=1")).toBe(
      true,
    );
    expect(cursorLoginAllowed("http://cursor.com/x")).toBe(false);
    expect(cursorLoginAllowed("https://evil.test/x")).toBe(false);
    expect(cursorLoginAllowed("https://cursor.com.evil.test/x")).toBe(false);
    expect(cursorLoginAllowed("https://user@cursor.com/x")).toBe(false);
    expect(
      isCursorServer("https://api.cursor.com/rest-mcp/google-drive/mcp"),
    ).toBe(true);
    expect(isCursorServer("https://cursor.com.evil.test/mcp")).toBe(false);
    expect(isCursorServer("http://api.cursor.com/mcp")).toBe(false);
    expect(isCursorServer("https://example.com/mcp")).toBe(false);
  });

  it("reads exp without checking anything, and says nothing for a non-JWT", () => {
    expect(jwtValidFor(jwt(2000), 1_000_000)).toBe(1000);
    expect(jwtValidFor(jwt(500), 1_000_000)).toBe(0);
    expect(jwtValidFor("not-a-jwt", 0)).toBeUndefined();
    expect(jwtValidFor("a.b.c", 0)).toBeUndefined();
  });
});
