import type { QueryClient } from "@tanstack/react-query";
import type { Agent } from "@/queries/chat";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { llmApi } from "@/lib/api";
import { translate } from "@/lib/i18n";

// The LLM gateway's public API (/api/llm/v1): model services, accounts and
// the model catalog. See apps/control-plane/internal/llm.

const reasonSchema = z.object({ code: z.string(), message: z.string() });

const connectorSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  flow: z.string(),
  hint: z.string().optional(),
});

const connectionSchema = z.object({
  id: z.string(),
  connector: z.string(),
  label: z.string(),
  plan: z.string().optional(),
  state: z.enum([
    "active",
    "disabled",
    "needs_login",
    "rate_limited",
    "error",
    "degraded",
  ]),
  error: reasonSchema.optional(),
  retry_at: z.string().optional(),
  created_at: z.string(),
  /** When the account was last checked against its provider. */
  checked_at: z.string().optional(),
  /** Why that check failed; the account's state stays as it was. */
  check_error: reasonSchema.optional(),
});

const modelSchema = z.object({
  id: z.string(),
  connector: z.string(),
  display_name: z.string(),
  context_window: z.number().optional(),
  /**
   * `degraded` is a transient upstream failure: requests still go through
   * and it clears by itself (`retry_at`); `unavailable` needs the user.
   */
  status: z.enum(["available", "degraded", "unavailable"]),
  /** Whether chats may use it: status is not `unavailable`. */
  available: z.boolean(),
  reason: reasonSchema.optional(),
  retry_at: z.string().optional(),
});

const usageSchema = z.object({
  id: z.string(),
  plan: z.string().optional(),
  windows: z.array(
    z.object({
      kind: z.string(),
      used: z.number(),
      resets_at: z.string().optional(),
      duration_seconds: z.number().optional(),
    }),
  ),
  error: z.string().optional(),
});

const loginSchema = z.object({
  id: z.string(),
  connector: z.string(),
  flow: z.string(),
  status: z.enum(["pending", "succeeded", "failed", "expired"]),
  url: z.string().optional(),
  user_code: z.string().optional(),
  expires_at: z.string(),
  error: z.string().optional(),
});

const countsSchema = z.object({
  requests: z.number(),
  failed: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cached_tokens: z.number(),
  reasoning_tokens: z.number(),
  total_tokens: z.number(),
});

const agentUsageSchema = z.object({
  principal: z.string(),
  windows: z.record(z.string(), countsSchema),
  models: z.array(countsSchema.extend({ name: z.string() })),
  accounts: z.array(countsSchema.extend({ name: z.string() })),
});

export type Connector = z.infer<typeof connectorSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Model = z.infer<typeof modelSchema>;
export type Usage = z.infer<typeof usageSchema>;

const keys = {
  connectors: ["llm", "connectors"] as const,
  connections: ["llm", "connections"] as const,
  models: ["llm", "models"] as const,
  usage: ["llm", "usage"] as const,
  agentUsage: ["llm", "usage", "agents"] as const,
  login: (id: string) => ["llm", "login", id] as const,
};

// Account state changes without any action here (tokens expire, quotas
// recover), so connections and models are polled.
const POLL_MS = 30_000;

export function useConnectors() {
  return useQuery({
    queryKey: keys.connectors,
    queryFn: async ({ signal }) =>
      z.array(connectorSchema).parse(await llmApi.get("/connectors", signal)),
    staleTime: Infinity,
  });
}

export function useConnections() {
  return useQuery({
    queryKey: keys.connections,
    queryFn: async ({ signal }) =>
      z.array(connectionSchema).parse(await llmApi.get("/connections", signal)),
    refetchInterval: POLL_MS,
  });
}

export function useModels() {
  return useQuery({
    queryKey: keys.models,
    queryFn: async ({ signal }) =>
      z.array(modelSchema).parse(await llmApi.get("/models", signal)),
    refetchInterval: POLL_MS,
  });
}

/** Subscription limits as each provider reports them, per connection. */
export function useUsage() {
  return useQuery({
    queryKey: keys.usage,
    queryFn: async ({ signal }) =>
      z.array(usageSchema).parse(await llmApi.get("/usage", signal)),
    refetchInterval: 60_000,
  });
}

/**
 * Who used the models over the last 5 hours, day and week: a chat agent
 * (its id; memory extraction for it counts too) or a routine ("routine-<id>").
 */
export function useAgentUsage(principal: string | undefined) {
  return useQuery({
    queryKey: keys.agentUsage,
    queryFn: async ({ signal }) =>
      z
        .object({ usage: z.array(agentUsageSchema) })
        .parse(await llmApi.get("/usage/agents", signal)).usage,
    select: (usage) => usage.find((u) => u.principal === principal),
    enabled: Boolean(principal),
    refetchInterval: 60_000,
  });
}

const statusSchema = z.object({
  connections: z.array(connectionSchema),
  models: z.array(modelSchema),
  usage: z.array(usageSchema),
});

const statusKeys = [keys.connections, keys.models, keys.usage];

/**
 * Checks every account against its provider now (not just a re-read of
 * what the last requests left behind). Polls in flight are cancelled before
 * and after, so none that started earlier lands on top of the result; a
 * failed check leaves the status as it was.
 */
export function useRefreshLlmStatus() {
  const queryClient = useQueryClient();
  const cancel = () =>
    Promise.all(
      statusKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })),
    );
  return useMutation({
    mutationKey: ["llm", "refresh"],
    mutationFn: async () => {
      await cancel();
      return statusSchema.parse(await llmApi.post("/refresh", {}));
    },
    onSuccess: async (status) => {
      await cancel();
      queryClient.setQueryData(keys.connections, status.connections);
      queryClient.setQueryData(keys.models, status.models);
      queryClient.setQueryData(keys.usage, status.usage);
    },
  });
}

export function refreshLlm(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: keys.connections }),
    queryClient.invalidateQueries({ queryKey: keys.models }),
    queryClient.invalidateQueries({ queryKey: keys.usage }),
  ]);
}

/** Accounts that serve requests; a degraded one recovers by itself. */
export const USABLE = new Set<Connection["state"]>(["active", "degraded"]);

/** Accounts the user has to act on (re-login, or an error that will not clear). */
export const NEEDS_ACTION = new Set<Connection["state"]>([
  "needs_login",
  "error",
]);

/** The xAI connector: Grok's models and the grok plugin's tools. */
export const GROK_CONNECTOR = "xai";

/** Whether an account needs the user; `grok` narrows it to Grok's. */
export function useNeedsAttention(grok?: boolean) {
  const { data } = useConnections();
  return (data ?? []).some(
    (connection) =>
      NEEDS_ACTION.has(connection.state) &&
      (!grok || connection.connector === GROK_CONNECTOR),
  );
}

/** Connectors whose accounts are API keys the user enters, not logins. */
export const FLOW_API_KEY = "api_key";

/**
 * Adds an API key: a login takes it, and the service checks it with the
 * provider before keeping it. A rejected key fails with the reason.
 */
export function useSubmitApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { connector: string; apiKey: string }) => {
      const login = loginSchema.parse(
        await llmApi.post("/logins", { connector: input.connector }),
      );
      return loginSchema.parse(
        await llmApi.post(`/logins/${login.id}/input`, {
          api_key: input.apiKey,
        }),
      );
    },
    onSuccess: () => refreshLlm(queryClient),
  });
}

export function useStartLogin() {
  return useMutation({
    mutationFn: async (connector: string) =>
      loginSchema.parse(await llmApi.post("/logins", { connector })),
  });
}

/** Polls a login until it finishes; refreshes accounts when it succeeds. */
export function useLoginStatus(id: string | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: keys.login(id ?? ""),
    enabled: Boolean(id),
    queryFn: async ({ signal }) => {
      const login = loginSchema.parse(
        await llmApi.get(`/logins/${id}`, signal),
      );
      if (login.status === "succeeded") void refreshLlm(queryClient);
      return login;
    },
    refetchInterval: (query) =>
      query.state.data && query.state.data.status !== "pending" ? false : 2000,
    refetchIntervalInBackground: true,
  });
}

export function useCancelLogin() {
  return useMutation({
    mutationFn: (id: string) => llmApi.delete(`/logins/${id}`),
  });
}

export function useSetConnectionEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; enabled: boolean }) =>
      connectionSchema.parse(
        await llmApi.patch(`/connections/${encodeURIComponent(input.id)}`, {
          enabled: input.enabled,
        }),
      ),
    onSettled: () => refreshLlm(queryClient),
  });
}

export function useDeleteConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      llmApi.delete(`/connections/${encodeURIComponent(id)}`),
    onSettled: () => refreshLlm(queryClient),
  });
}

export type ModelAvailability =
  | { state: "ok"; model: Model | undefined }
  | { state: "not_set" }
  /** A transient upstream failure: chats go on, with a warning. */
  | { state: "degraded"; model: Model; message: string }
  | { state: "unavailable"; model: Model | undefined; message: string };

/**
 * Whether an agent can chat with its model. The control plane enforces the
 * same rule; this only keeps the UI ahead of it. While the catalog cannot
 * be read (stale is true), the last one only names models: it does not
 * block, and the server decides on send.
 */
export function modelAvailability(
  agent: Pick<Agent, "model"> | undefined,
  models: Model[] | undefined,
  stale = false,
): ModelAvailability {
  const model = models?.find((item) => item.id === agent?.model);
  if (!agent?.model) return { state: "not_set" };
  // Unknown until the catalog loads; the server still checks on send.
  if (!models || stale) return { state: "ok", model };
  if (!model)
    return {
      state: "unavailable",
      model,
      message: translate("agents:models.errors.deleted", {
        modelName: agent.model,
      }),
    };
  if (model.status === "unavailable")
    return {
      state: "unavailable",
      model,
      message: translate("agents:models.errors.unavailable", {
        modelName: model.display_name,
        reason:
          model.reason?.message ??
          translate("agents:models.errors.checkAccounts"),
      }),
    };
  if (model.status === "degraded")
    return {
      state: "degraded",
      model,
      message: translate("agents:models.errors.degradedSendAllowed", {
        modelName: model.display_name,
        reason:
          model.reason?.message ??
          translate("agents:models.errors.upstreamFailure"),
      }),
    };
  return { state: "ok", model };
}

export function useModelAvailability(agent: Pick<Agent, "model"> | undefined) {
  const { data, isError } = useModels();
  return modelAvailability(agent, data, isError);
}
