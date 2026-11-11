/**
 * GitHub's HTTP API, as much of it as the App needs: one `fetch` with the three ways GitHub is
 * called (as the App with a JWT, with a token, with nothing) and GitHub's errors read the way the
 * rest of the code wants them.
 */
import { Buffer } from "node:buffer";
import { GithubError } from "./error";

export const WEB_URL = "https://github.com";
const API_URL = "https://api.github.com";
const TIMEOUT_MS = 20_000;

/** The part of `fetch` the client uses; a test wraps it. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Where GitHub is. Tests point both at a fake. */
export interface Endpoints {
  /** `https://api.github.com` */
  api: string;
  /** Where the OAuth endpoints are: `https://github.com` */
  oauth: string;
}

export const GITHUB: Endpoints = { api: API_URL, oauth: WEB_URL };

/** A failed call. `status` is GitHub's, or 0 when no answer came. */
class ApiError extends Error {
  readonly status: number;
  readonly reasons: string[];

  constructor(status: number, message: string, reasons: string[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.reasons = reasons;
  }
}

export const statusOf = (error: unknown): number =>
  error instanceof ApiError ? error.status : 0;

/** GitHub's message and the messages of its `errors`, joined. */
export function reasons(error: unknown): string {
  if (!(error instanceof ApiError)) return String(error);
  return [error.message, ...error.reasons]
    .join("; ")
    .replace(/^(?:; )+|(?:; )+$/g, "");
}

/**
 * A failed call as an answer naming GitHub's reasons. GitHub's failures are 424, never 502:
 * Cloudflare, in front of production deployments, replaces an origin's 502 and 504 with its own
 * error page.
 */
export function fromGitHub(error: unknown): GithubError {
  if (!(error instanceof ApiError) || error.status === 0)
    return new GithubError(
      "GITHUB_UNREACHABLE",
      424,
      "Can't reach GitHub right now.",
    );
  return new GithubError(
    "GITHUB_ERROR",
    424,
    `GitHub returned ${error.status}: ${reasons(error)}`,
  );
}

export interface Request {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** Joined to the API address. */
  path: string;
  query?: Record<string, string | number | undefined>;
  /** `Bearer` token: the App's JWT, an installation token or a user's. */
  token?: string;
  basic?: { user: string; password: string };
  json?: unknown;
  form?: Record<string, string>;
}

/** A GitHub client over `fetch`. */
export class Http {
  readonly #endpoints: Endpoints;
  readonly #fetch: FetchFn;

  constructor(endpoints: Endpoints = GITHUB, fetchFn: FetchFn = fetch) {
    this.#endpoints = endpoints;
    this.#fetch = fetchFn;
  }

  get oauthUrl(): string {
    return this.#endpoints.oauth.replace(/\/+$/, "");
  }

  async #send(url: string, request: Request): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "eta-github",
      "x-github-api-version": "2022-11-28",
    };
    if (request.token !== undefined)
      headers.authorization = `Bearer ${request.token}`;
    if (request.basic !== undefined)
      headers.authorization = `Basic ${Buffer.from(`${request.basic.user}:${request.basic.password}`).toString("base64")}`;
    let body: string | undefined;
    if (request.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(request.json);
    } else if (request.form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      headers.accept = "application/json";
      body = new URLSearchParams(request.form).toString();
    }
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: request.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ApiError(0, error instanceof Error ? error.message : "", []);
    }
    const text = await response.text().catch(() => "");
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const failure = (parsed ?? {}) as {
        message?: unknown;
        errors?: unknown;
      };
      const more: string[] = [];
      if (Array.isArray(failure.errors)) {
        for (const item of failure.errors) {
          if (typeof item === "string") more.push(item);
          else if (
            typeof item === "object" &&
            item !== null &&
            typeof (item as { message?: unknown }).message === "string"
          )
            more.push((item as { message: string }).message);
        }
      }
      throw new ApiError(
        response.status,
        typeof failure.message === "string" ? failure.message : "",
        more,
      );
    }
    return parsed;
  }

  /** A call to the REST API. */
  async api<T = unknown>(request: Request): Promise<T> {
    const url = new URL(
      `${this.#endpoints.api.replace(/\/+$/, "")}${request.path}`,
    );
    for (const [key, value] of Object.entries(request.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    return (await this.#send(url.href, request)) as T;
  }

  /** A call to the OAuth endpoints (GitHub's website). */
  async oauth<T = unknown>(request: Request): Promise<T> {
    return (await this.#send(`${this.oauthUrl}${request.path}`, request)) as T;
  }
}

/** One path segment of a repository, safe in a URL. */
export const segment = (value: string): string => encodeURIComponent(value);
