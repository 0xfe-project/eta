import type { Context } from "cordis";
import type { RoutesApi } from "./plugin-api";
/**
 * The floor's route registry: a method, a path pattern, a handler. Nothing else.
 *
 * The floor does not know what a session, a group or a task is, and it carries no feature name
 * of its own — everything that answers a request registered itself here and unregisters the same
 * way (REFACTOR.md §9, P0.3; the envelope, idempotency and the SSE hub are P0.5's).
 *
 * Plugins reach it as the `routes` service; `RouteService` is that same registry, reachable from
 * a cordis context.
 */
import { randomUUID } from "node:crypto";
import { Service } from "cordis";

export type RouteHandler = (
  request: Request,
  params: Record<string, string>,
) => Response | Promise<Response>;

interface Route {
  method: string;
  pattern: string;
  segments: string[];
  handler: RouteHandler;
}

const segmentsOf = (path: string): string[] =>
  path.split("/").filter((part) => part.length > 0);

/**
 * `undefined` when the path does not fit the pattern; otherwise the path's parameters.
 *
 * A trailing `*name` captures everything left, slashes and all. It exists for one kind of route:
 * serving a static site's files, where the paths are the site's own (`assets/app.js`) and a page's
 * relative URLs have to resolve.
 */
function matchPattern(
  pattern: string[],
  actual: string[],
): Record<string, string> | undefined {
  const splat = pattern.at(-1)?.startsWith("*") === true;
  const fixed = splat ? pattern.length - 1 : pattern.length;
  if (splat ? actual.length < fixed : actual.length !== fixed) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < fixed; index += 1) {
    const expected = pattern[index] ?? "";
    const seen = actual[index] ?? "";
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(seen);
      continue;
    }
    if (expected !== seen) return undefined;
  }
  if (splat) {
    const rest = actual.slice(fixed).join("/");
    params[(pattern.at(-1) ?? "*").slice(1)] = rest
      .split("/")
      .map((part) => decodeURIComponent(part))
      .join("/");
  }
  return params;
}

/** The one error shape this server has: what a browser, a CLI and a log all read the same way. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
): Response {
  return Response.json(
    { error: { code, message, request_id: requestId } },
    { status, headers: { "x-request-id": requestId } },
  );
}

/** The same response, with the request id this server decided on. */
function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** One route's work, wrapped by whatever middleware the floor puts in front of it. */
export type HandlerWrapper = (
  request: Request,
  run: () => Promise<Response>,
) => Promise<Response>;

export class RouteRegistry {
  readonly #routes: Route[] = [];
  readonly #wrap: HandlerWrapper | undefined;

  constructor(wrap?: HandlerWrapper) {
    this.#wrap = wrap;
  }

  /** Register a handler. The returned function takes the route back out again. */
  register(method: string, pattern: string, handler: RouteHandler): () => void {
    const route: Route = {
      method: method.toUpperCase(),
      pattern,
      segments: segmentsOf(pattern),
      handler,
    };
    this.#routes.push(route);
    return () => {
      const index = this.#routes.indexOf(route);
      if (index !== -1) this.#routes.splice(index, 1);
    };
  }

  /** Take every route back. The floor does this on shutdown, after the plugins are out. */
  clear(): void {
    this.#routes.splice(0);
  }

  routes(): { method: string; pattern: string }[] {
    return this.#routes.map((route) => ({
      method: route.method,
      pattern: route.pattern,
    }));
  }

  async dispatch(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id") ?? randomUUID();
    const { pathname } = new URL(request.url);
    const actual = segmentsOf(pathname);
    for (const route of this.#routes) {
      if (route.method !== request.method) continue;
      const params = matchPattern(route.segments, actual);
      if (params === undefined) continue;
      const run = async (): Promise<Response> => route.handler(request, params);
      try {
        const response =
          this.#wrap === undefined
            ? await run()
            : await this.#wrap(request, run);
        return withRequestId(response, requestId);
      } catch (error) {
        return errorResponse(500, "INTERNAL", String(error), requestId);
      }
    }
    return errorResponse(
      404,
      "NOT_FOUND",
      `no route for ${request.method} ${pathname}`,
      requestId,
    );
  }
}

/**
 * The registry as a cordis service, so a plugin reaches it with `inject: ["routes"]`.
 *
 * The methods are own arrow properties, never prototype methods: cordis hands a *view* of a
 * service to whoever asks the context for it, and a prototype method called on that view would
 * resolve `this` to the view rather than to the instance (eta-old learned this in wire-service).
 */
export class RouteService extends Service implements RoutesApi {
  static readonly provide = "routes";

  readonly registry: RouteRegistry;

  constructor(ctx: Context, registry: RouteRegistry = new RouteRegistry()) {
    super(ctx, "routes");
    this.registry = registry;
  }

  readonly register: RoutesApi["register"] = (method, pattern, handler) =>
    this.registry.register(method, pattern, handler);

  readonly routes: RoutesApi["routes"] = () => this.registry.routes();

  readonly dispatch: (request: Request) => Promise<Response> = (request) =>
    this.registry.dispatch(request);
}
