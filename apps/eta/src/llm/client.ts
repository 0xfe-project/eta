/**
 * The gateway's account API, as the host's code sees it.
 *
 * The gateway speaks snake_case JSON on `/api/llm/v1/*`; this turns that into the camelCase views
 * of `@eta/client-contracts` and its error envelope into `LlmError`, whose `problem` (a code and
 * its params) the wire passes on to the client unchanged. Nothing here is translated: the web
 * turns codes into words.
 */
import type {
  LlmAccounts,
  LlmConnection,
  LlmConnector,
  LlmLogin,
  LlmModel,
  LlmParams,
  LlmProblem,
  LlmQuota,
} from "@eta/client-contracts";

/** What the gateway needs from the process it is loaded in: a way to reach it with its key. */
export interface GatewayTransport {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * A refusal the gateway explained. `message` is an English diagnostic; `problem` is what the
 * client translates, and the transport forwards it with the failed reply.
 */
class LlmError extends Error {
  readonly problem: { code: string; params?: LlmParams };
  readonly status: number;
  constructor(problem: LlmProblem, status: number) {
    super(problem.message);
    this.name = "LlmError";
    this.problem = {
      code: problem.code,
      ...(problem.params === undefined ? {} : { params: problem.params }),
    };
    this.status = status;
  }
  get code(): string {
    return this.problem.code;
  }
}

interface RawProblem {
  code: LlmProblem["code"];
  message: string;
  params?: LlmParams;
}
interface RawConnector {
  id: string;
  display_name: string;
  flow: LlmConnector["flow"];
}
interface RawConnection {
  id: string;
  connector: string;
  label: string;
  plan?: string;
  state: LlmConnection["state"];
  error?: RawProblem;
  retry_at?: string;
  created_at: string;
  checked_at?: string;
  check_error?: RawProblem;
}
interface RawModel {
  id: string;
  connector: string;
  display_name: string;
  context_window?: number;
  reasoning_levels?: string[];
  image?: boolean;
  status: LlmModel["status"];
  available: boolean;
  reason?: RawProblem;
  retry_at?: string;
}
interface RawUsage {
  id: string;
  plan?: string;
  windows: {
    kind: "5h" | "weekly" | "monthly";
    used: number;
    resets_at?: string;
    duration_seconds?: number;
  }[];
  error?: RawProblem;
}
interface RawLogin {
  id: string;
  connector: string;
  flow: LlmLogin["flow"];
  status: LlmLogin["status"];
  url?: string;
  user_code?: string;
  expires_at: string;
  error?: RawProblem;
}

/** A model with the facts the model layer needs beyond the view. */
export interface CatalogModel extends LlmModel {
  reasoningLevels: string[];
  image: boolean;
}

const problem = (raw: RawProblem | undefined): LlmProblem | undefined =>
  raw === undefined
    ? undefined
    : {
        code: raw.code,
        message: raw.message,
        ...(raw.params === undefined ? {} : { params: raw.params }),
      };

function connection(raw: RawConnection): LlmConnection {
  return {
    id: raw.id,
    connector: raw.connector,
    label: raw.label,
    ...(raw.plan === undefined ? {} : { plan: raw.plan }),
    state: raw.state,
    ...(raw.error === undefined ? {} : { error: problem(raw.error) }),
    ...(raw.retry_at === undefined ? {} : { retryAt: raw.retry_at }),
    createdAt: raw.created_at,
    ...(raw.checked_at === undefined ? {} : { checkedAt: raw.checked_at }),
    ...(raw.check_error === undefined
      ? {}
      : { checkError: problem(raw.check_error) }),
  };
}

function model(raw: RawModel): CatalogModel {
  return {
    id: raw.id,
    connector: raw.connector,
    name: raw.display_name === "" ? raw.id : raw.display_name,
    ...(raw.context_window === undefined
      ? {}
      : { contextWindow: raw.context_window }),
    status: raw.status,
    available: raw.available,
    ...(raw.reason === undefined ? {} : { reason: problem(raw.reason) }),
    ...(raw.retry_at === undefined ? {} : { retryAt: raw.retry_at }),
    reasoningLevels: raw.reasoning_levels ?? [],
    image: raw.image === true,
  };
}

function quota(raw: RawUsage): LlmQuota {
  return {
    connectionId: raw.id,
    ...(raw.plan === undefined || raw.plan === "" ? {} : { plan: raw.plan }),
    windows: raw.windows.map((window) => ({
      kind: window.kind,
      used: window.used,
      ...(window.resets_at === undefined ? {} : { resetsAt: window.resets_at }),
      ...(window.duration_seconds === undefined
        ? {}
        : { durationSeconds: window.duration_seconds }),
    })),
    ...(raw.error === undefined ? {} : { error: problem(raw.error) }),
  };
}

function login(raw: RawLogin): LlmLogin {
  return {
    id: raw.id,
    connector: raw.connector,
    flow: raw.flow,
    status: raw.status,
    ...(raw.url === undefined ? {} : { url: raw.url }),
    ...(raw.user_code === undefined ? {} : { userCode: raw.user_code }),
    expiresAt: raw.expires_at,
    ...(raw.error === undefined ? {} : { error: problem(raw.error) }),
  };
}

export class GatewayClient {
  readonly #transport: GatewayTransport;

  constructor(transport: GatewayTransport) {
    this.#transport = transport;
  }

  async #call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | undefined> {
    const response = await this.#transport.fetch(`/api/llm/v1${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!response.ok) {
      let failure: LlmProblem = {
        code: "gateway_unavailable",
        message: `The gateway answered HTTP ${response.status}.`,
      };
      try {
        const parsed = JSON.parse(text) as { error?: RawProblem };
        if (parsed.error !== undefined) failure = problem(parsed.error)!;
      } catch {
        // Not the gateway's envelope (a proxy's page, say): the default stands.
      }
      throw new LlmError(failure, response.status);
    }
    return JSON.parse(text) as T;
  }

  /** Whether the credentials are loaded and the models are served. */
  async ready(): Promise<boolean> {
    try {
      return (await this.#transport.fetch("/api/llm/ready")).status === 204;
    } catch {
      return false;
    }
  }

  async connectors(): Promise<LlmConnector[]> {
    const raw = (await this.#call<RawConnector[]>("GET", "/connectors")) ?? [];
    return raw.map((entry) => ({
      id: entry.id,
      name: entry.display_name,
      flow: entry.flow,
    }));
  }

  async connections(): Promise<LlmConnection[]> {
    const raw =
      (await this.#call<RawConnection[]>("GET", "/connections")) ?? [];
    return raw.map(connection);
  }

  async models(): Promise<CatalogModel[]> {
    return ((await this.#call<RawModel[]>("GET", "/models")) ?? []).map(model);
  }

  /** The subscription windows of every enabled account, read from their providers. */
  async quota(): Promise<LlmQuota[]> {
    return ((await this.#call<RawUsage[]>("GET", "/usage")) ?? []).map(quota);
  }

  /** Every account checked against its provider now; one round shared by concurrent callers. */
  async refresh(): Promise<{
    connections: LlmConnection[];
    models: CatalogModel[];
    quota: LlmQuota[];
  }> {
    const raw = await this.#call<{
      connections: RawConnection[];
      models: RawModel[];
      usage: RawUsage[];
    }>("POST", "/refresh");
    return {
      connections: (raw?.connections ?? []).map(connection),
      models: (raw?.models ?? []).map(model),
      quota: (raw?.usage ?? []).map(quota),
    };
  }

  async loginStart(connector: string): Promise<LlmLogin> {
    return login(
      (await this.#call<RawLogin>("POST", "/logins", { connector }))!,
    );
  }

  async loginPoll(id: string): Promise<LlmLogin> {
    return login(
      (await this.#call<RawLogin>("GET", `/logins/${encodeURIComponent(id)}`))!,
    );
  }

  async loginSubmit(id: string, apiKey: string): Promise<LlmLogin> {
    return login(
      (await this.#call<RawLogin>(
        "POST",
        `/logins/${encodeURIComponent(id)}/input`,
        { api_key: apiKey },
      ))!,
    );
  }

  async loginCancel(id: string): Promise<void> {
    await this.#call("DELETE", `/logins/${encodeURIComponent(id)}`);
  }

  async setEnabled(id: string, enabled: boolean): Promise<LlmConnection> {
    return connection(
      (await this.#call<RawConnection>(
        "PATCH",
        `/connections/${encodeURIComponent(id)}`,
        { enabled },
      ))!,
    );
  }

  async remove(id: string): Promise<void> {
    await this.#call("DELETE", `/connections/${encodeURIComponent(id)}`);
  }

  /** The accounts as the `accounts` section shows them. */
  async accounts(): Promise<Omit<LlmAccounts, "ready">> {
    const [connectors, connections] = await Promise.all([
      this.connectors(),
      this.connections(),
    ]);
    return { connectors, connections };
  }
}
