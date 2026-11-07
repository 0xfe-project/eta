/**
 * Asking a remote host whether the window can show it, before and while it does.
 *
 * `node:http`, not `fetch`: Bun's `fetch` honours `http_proxy` for anything but loopback, and a
 * proxy cannot reach a tailnet address, which would read as a host that is not there.
 *
 * The token travels in `X-Eta-Token`, the header the phone uses, and only the shell sees it. The
 * page is let in with `/?token=…`, which the host trades for a cookie and redirects away from, so
 * the token is not in the address the page ends up on. Every launch goes through it, so a cookie
 * that expired or a cleared webview does not ask the user to log in again.
 */
import { Buffer } from "node:buffer";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { hostOrigin } from "./connection";

/** What is wrong with a remote host, in the order `probeRemote` finds out. */
export type RemoteFailure =
  | "address"
  | "unreachable"
  | "timeout"
  | "not-eta"
  | "token"
  | "no-page";

export interface RemoteTarget {
  address: string;
  token: string;
}

export type Probe =
  | { ok: true; origin: string }
  | { ok: false; failure: RemoteFailure; detail?: string };

interface Answer {
  status: number;
  contentType: string;
  location: string | undefined;
  body: string;
}

const PROBE_TIMEOUT_MS = 5_000;
/** More than `/up` or a status says; a page's head is enough to know it is one. */
const BODY_LIMIT = 16 * 1024;
/** `http://name` that answers from `https://name`, and no further. */
const MAX_REDIRECTS = 3;

class Unreachable extends Error {
  constructor(
    readonly failure: "unreachable" | "timeout",
    detail: string,
  ) {
    super(detail);
  }
}

function ask(url: string, token: string, timeoutMs: number): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const send = url.startsWith("https:") ? requestHttps : requestHttp;
    const request = send(
      url,
      {
        method: "GET",
        timeout: timeoutMs,
        headers: token === "" ? {} : { "x-eta-token": token },
      },
      (answer) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        const finish = () => {
          resolve({
            status: answer.statusCode ?? 0,
            contentType: answer.headers["content-type"] ?? "",
            location: answer.headers.location,
            body: new TextDecoder().decode(Buffer.concat(chunks)),
          });
        };
        answer.on("data", (chunk: Uint8Array) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= BODY_LIMIT) {
            finish();
            answer.destroy();
          }
        });
        answer.on("end", finish);
        answer.on("error", (error) => {
          reject(new Unreachable("unreachable", error.message));
        });
      },
    );
    request.on("error", (error) => {
      reject(new Unreachable("unreachable", error.message));
    });
    request.on("timeout", () => {
      request.destroy();
      reject(new Unreachable("timeout", `${String(timeoutMs)}ms`));
    });
    request.end();
  });
}

/** Follows a redirect to find the origin that answers: it is the one the window ends up on. */
async function askUp(
  origin: string,
  timeoutMs: number,
): Promise<{ origin: string; answer: Answer }> {
  let at = origin;
  for (let hop = 0; ; hop += 1) {
    const answer = await ask(`${at}/up`, "", timeoutMs);
    if (
      answer.location === undefined ||
      answer.status < 300 ||
      answer.status >= 400 ||
      hop === MAX_REDIRECTS
    )
      return { origin: at, answer };
    at = new URL(answer.location, `${at}/up`).origin;
  }
}

/** Whether the window can show this host. The only thing that decides a remote page opens. */
export async function probeRemote(
  target: RemoteTarget,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Probe> {
  const given = hostOrigin(target.address);
  if (given === undefined) return { ok: false, failure: "address" };
  try {
    const { origin, answer } = await askUp(given, timeoutMs);
    // Anything may answer on a port; `/up` saying `ok` is what a host says.
    if (answer.status !== 200 || answer.body.trim() !== "ok")
      return { ok: false, failure: "not-eta" };
    const page = await ask(`${origin}/`, target.token, timeoutMs);
    if (page.status === 401 || page.status === 403)
      return { ok: false, failure: "token" };
    if (page.status !== 200 || !page.contentType.includes("text/html"))
      return { ok: false, failure: "no-page" };
    return { ok: true, origin };
  } catch (error) {
    if (error instanceof Unreachable)
      return { ok: false, failure: error.failure, detail: error.message };
    return { ok: false, failure: "unreachable", detail: String(error) };
  }
}

/** The address that lets the window in. Holds the token: it goes to the webview and nowhere else. */
export function remotePage(target: RemoteTarget): string {
  return target.token === ""
    ? `${target.address}/`
    : `${target.address}/?token=${encodeURIComponent(target.token)}`;
}

/** One look at a host already on screen. */
type Health = "up" | "upgrading" | "token" | "down";

const HEALTH_TIMEOUT_MS = 4_000;

/**
 * `/upgrade/status` rather than `/up`: it is behind the gate, so it also says whether the token
 * still opens the host, and it says when going away is what the host is supposed to be doing.
 */
export async function remoteHealth(target: RemoteTarget): Promise<Health> {
  try {
    const answer = await ask(
      `${target.address}/upgrade/status`,
      target.token,
      HEALTH_TIMEOUT_MS,
    );
    if (answer.status === 401) return "token";
    // A proxy in front of a host that is down answers for it.
    if (answer.status >= 500) return "down";
    return upgrading(answer.body) ? "upgrading" : "up";
  } catch {
    return "down";
  }
}

function upgrading(body: string): boolean {
  try {
    const status = JSON.parse(body) as { state?: unknown } | null;
    return status?.state === "running";
  } catch {
    // A host from before `/upgrade/status` answers with its page.
    return false;
  }
}

export interface WatchOptions {
  health: () => Promise<Health>;
  onLost: (failure: "lost" | "token") => void;
  intervalMs?: number;
  /** Looks that may fail in a row: 30s, what the phone gives a dropped connection. */
  patience?: number;
  /** The same during an upgrade, whose restart the page waits out by itself: 10min. */
  upgradePatience?: number;
}

/**
 * Watch the host on screen, and say when the page is no good any more.
 *
 * The page has its own banner for a short drop and its own screen for an upgrade, so a miss is not
 * news yet. What counts is misses in a row rather than time since the last answer: a laptop that
 * slept all night has one miss when it wakes, not eight hours of them.
 */
export function watchRemote(options: WatchOptions): () => void {
  const {
    health,
    intervalMs = 5_000,
    onLost,
    patience = 6,
    upgradePatience = 120,
  } = options;
  let stopped = false;
  let misses = 0;
  let upgrade = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const look = async () => {
    const now = await health();
    if (stopped) return;
    if (now === "token") {
      // A wrong token will not fix itself.
      onLost("token");
      return;
    }
    if (now === "down") {
      misses += 1;
      if (misses >= (upgrade ? upgradePatience : patience)) {
        onLost("lost");
        return;
      }
    } else {
      misses = 0;
      upgrade = now === "upgrading";
    }
    timer = setTimeout(() => void look(), intervalMs);
  };
  timer = setTimeout(() => void look(), intervalMs);

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
