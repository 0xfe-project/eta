/**
 * The window's own capabilities, on a loopback port that exists for as long as the window does.
 *
 * A folder dialog, a place to save a file, the system browser, a context menu, the three window
 * buttons: none of these belong to the host. The host owns sessions and knows nothing about
 * windows, and there may be several windows' worth of clients talking to one host — so the
 * capabilities that are true of *this* window live in the process that owns *this* window.
 *
 * Three things make the port safe to leave listening:
 *
 * - **Origin.** A browser attaches the page's origin to every request and a page cannot forge it,
 *   so a request from anywhere but the page we loaded is somebody else's page. The whitelist is
 *   the origin of the URL the window was actually given — not a list of guesses: the page is
 *   served by the host on a port that is only known at launch. A request with no Origin at all is
 *   not a browser (a script, a test) and is let through to the token check.
 * - **Token.** Every request needs this launch's bearer token, compared in constant time. The
 *   token is generated here, never written down, and handed to the page through the preload, so a
 *   page that has it is the page the shell itself loaded.
 * - **No cache.** `cache-control: no-store` on every answer: nothing about a window belongs in a
 *   cache, and a 401 must not be able to be replayed from one.
 *
 * This server never opens a session, never touches the database and never starts the host.
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

/** What the page may ask the window to do. Kept in step with `apps/web/src/lib/native.ts`. */
type WindowAction = "minimize" | "toggle-maximize" | "close";

/** One native context-menu row: `action` comes back to the page when the row is chosen. */
interface NativeMenuItem {
  label: string;
  action?: string;
  /** A row that only separates. */
  divider?: boolean;
}

interface NativeHandlers {
  /** The system's own folder chooser. `null` is a cancelled dialog, not a failure. */
  folderDialog: (input: { startingFolder?: string }) => Promise<string | null>;
  /** Write `content` somewhere the user chose; `null` when they chose nothing. */
  saveFile: (input: {
    filename: string;
    content: string;
  }) => Promise<string | null>;
  /** Hand a URL to the system browser; the window itself never navigates away. */
  openExternal: (input: { url: string }) => void;
  contextMenu: (input: { items: readonly NativeMenuItem[] }) => void;
  windowAction: (input: { action: WindowAction }) => void;
}

export interface NativeBridge {
  /** `http://127.0.0.1:<port>`, for the preload. */
  apiBase: string;
  /** This launch's bearer token, for the preload. Never log it, never put it in a message. */
  token: string;
  close: () => void;
}

/** Only a page we loaded may talk to this port; the list is that page's own origin. */
export interface NativeBridgeOptions {
  handlers: NativeHandlers;
  /** The origin of the page the window shows. Empty when the window shows a shell-owned page. */
  origins: readonly string[];
  /** What `GET /api/native/info` answers with. */
  platform: string;
  appVersion: string;
}

const JSON_HEADERS = {
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "cache-control": "no-store",
  vary: "Origin",
} as const;

/** A body that is a JSON object, or nothing: a page sending anything else gets a 400. */
async function objectBody(
  request: Request,
): Promise<Record<string, unknown> | undefined> {
  const body: unknown = await request.json().catch(() => undefined);
  return typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** What may leave the window: the system browser opens pages, mail, nothing local. */
const EXTERNAL_SCHEMES = ["http:", "https:", "mailto:"];

function externalUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return EXTERNAL_SCHEMES.includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const WINDOW_ACTIONS: readonly WindowAction[] = [
  "minimize",
  "toggle-maximize",
  "close",
];

function menuItems(value: unknown): NativeMenuItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: NativeMenuItem[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { action, divider, label } = entry as Record<string, unknown>;
    if (divider === true) {
      items.push({ divider: true, label: "" });
      continue;
    }
    const name = text(label);
    if (name === undefined) return undefined;
    items.push(
      text(action) === undefined
        ? { label: name }
        : { label: name, action: String(action) },
    );
  }
  return items;
}

export function startNativeBridge(options: NativeBridgeOptions): NativeBridge {
  const token = crypto.randomUUID();
  const expected = Buffer.from(token);
  const { handlers, origins } = options;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    // Zero: the port is this launch's business, and only the preload ever learns it.
    port: 0,
    async fetch(request) {
      const origin = request.headers.get("origin");
      if (origin !== null && !origins.includes(origin))
        return new Response("origin_denied", { status: 403 });
      const headers = {
        ...JSON_HEADERS,
        "access-control-allow-origin": origin ?? "null",
      };
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      const supplied = Buffer.from(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
      );
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return new Response("authentication_failed", { status: 401, headers });

      const json = (body: unknown): Response =>
        Response.json(body, { headers });
      const path = new URL(request.url).pathname;
      if (path === "/api/native/info" && request.method === "GET")
        return json({
          isDesktop: true,
          platform: options.platform,
          appVersion: options.appVersion,
        });
      if (request.method !== "POST")
        return new Response("not_found", { status: 404, headers });

      const body = await objectBody(request);
      if (body === undefined)
        return new Response("native_request_invalid", { status: 400, headers });
      // The body is whatever a page sent, so it is read by name rather than trusted as a shape.
      const field = (name: string): unknown => body[name];
      const startingFolder = text(field("startingFolder"));
      const filename = text(field("filename"));
      const content = field("content");
      const url = externalUrl(field("url"));
      const items = menuItems(field("items"));
      const action = WINDOW_ACTIONS.find(
        (candidate) => candidate === field("action"),
      );
      try {
        if (path === "/api/native/folder-dialog")
          return json({
            path: await handlers.folderDialog(
              startingFolder === undefined ? {} : { startingFolder },
            ),
          });
        if (path === "/api/native/save-file") {
          if (filename === undefined || typeof content !== "string")
            return new Response("native_request_invalid", {
              status: 400,
              headers,
            });
          return json({
            path: await handlers.saveFile({ content, filename }),
          });
        }
        if (path === "/api/native/open-external") {
          if (url === undefined)
            return new Response("native_request_invalid", {
              status: 400,
              headers,
            });
          handlers.openExternal({ url });
          return new Response(null, { status: 202, headers });
        }
        if (path === "/api/native/context-menu") {
          if (items === undefined)
            return new Response("native_request_invalid", {
              status: 400,
              headers,
            });
          handlers.contextMenu({ items });
          return new Response(null, { status: 202, headers });
        }
        if (path === "/api/native/window-action") {
          if (action === undefined)
            return new Response("native_request_invalid", {
              status: 400,
              headers,
            });
          handlers.windowAction({ action });
          return new Response(null, { status: 202, headers });
        }
      } catch {
        // A handler's own failure is the window's, not the page's: say so without a stack.
        return new Response("native_request_failed", { status: 400, headers });
      }
      return new Response("not_found", { status: 404, headers });
    },
  });
  return {
    apiBase: `http://127.0.0.1:${String(server.port)}`,
    token,
    close: () => {
      server.stop(true);
    },
  };
}
