/**
 * The loopback port the shell's own page is served from.
 *
 * `BrowserWindow`'s `html` option would need no port, but a page loaded that way has no origin to
 * tell it from any other, and this page asks for things: a port gives it one, and the capability
 * bridge can then answer it like any page, for the window buttons a frameless window needs.
 *
 * It is the page that changes the connection, so it is held to more than the bridge. Only its own
 * origin is answered, and every call needs a token that the preload hands to the shell's page and
 * to no other: a remote host's page never has it. `describe` is all it says about the connection,
 * so no call here returns the token.
 */
import type { Choice, Failure, View } from "./shell";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { parseConnectLink } from "@eta/client-contracts/connect-link";
import { describe } from "./shell";
import { shellPage } from "./shell-page";

interface ShellServerOptions {
  view: () => View | undefined;
  choose: (choice: Choice) => Promise<Failure | undefined>;
  retry: () => Promise<Failure | undefined>;
  openChooser: () => void;
  back: () => void;
}

export interface ShellServer {
  /** `http://127.0.0.1:<port>`, for the window. */
  origin: string;
  /** For the preload of the shell's page. Never log it, never put it in a message. */
  token: string;
  close: () => void;
}

const HEADERS = { "cache-control": "no-store" } as const;

function choiceOf(body: unknown): Choice | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { address, mode, token } = body as Record<string, unknown>;
  if (mode === "local") return { mode };
  return mode === "remote" &&
    typeof address === "string" &&
    typeof token === "string"
    ? { mode, address, token }
    : undefined;
}

const outcome = (failure: Failure | undefined): Response =>
  Response.json(failure === undefined ? { ok: true } : { ok: false, failure }, {
    headers: HEADERS,
  });

export function startShellServer(options: ShellServerOptions): ShellServer {
  const token = crypto.randomUUID();
  const expected = Buffer.from(token);
  const page = shellPage();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/" && request.method === "GET")
        return new Response(page, {
          headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" },
        });

      const origin = `http://127.0.0.1:${String(server.port)}`;
      if (request.headers.get("origin") !== origin && request.method !== "GET")
        return new Response("origin_denied", { status: 403 });
      const supplied = Buffer.from(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
      );
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return new Response("authentication_failed", { status: 401 });

      if (url.pathname === "/api/view" && request.method === "GET") {
        const view = options.view();
        return view === undefined
          ? new Response("not_found", { status: 404 })
          : Response.json(describe(view), { headers: HEADERS });
      }
      if (request.method !== "POST")
        return new Response("not_found", { status: 404 });

      const body: unknown = await request.json().catch(() => undefined);
      if (url.pathname === "/api/choose") {
        const choice = choiceOf(body);
        return choice === undefined
          ? new Response("invalid", { status: 400 })
          : outcome(await options.choose(choice));
      }
      if (url.pathname === "/api/link") {
        const { text } = (body ?? {}) as { text?: unknown };
        return Response.json(
          typeof text === "string" ? (parseConnectLink(text) ?? null) : null,
          { headers: HEADERS },
        );
      }
      if (url.pathname === "/api/retry") return outcome(await options.retry());
      if (url.pathname === "/api/chooser") {
        options.openChooser();
        return outcome(undefined);
      }
      if (url.pathname === "/api/back") {
        options.back();
        return outcome(undefined);
      }
      return new Response("not_found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${String(server.port)}`,
    token,
    close: () => {
      server.stop(true);
    },
  };
}
