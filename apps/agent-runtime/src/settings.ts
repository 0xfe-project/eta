// What the controller starts the runtime with (environment variables), and
// how Codex is configured from it.

import { join } from "node:path";
import process from "node:process";

export interface Settings {
  agentId: string;
  // The agent's credential for AXP's services, through the runtime gateway.
  agentKey: string;
  // The controller's credential for the control API.
  controlToken: string;
  gatewayUrl: string;
  natsUrl: string;
  // The model provider: an OpenAI-compatible (Responses) API, its key and
  // the model. AXP points them at the LLM gateway, with the agent's key.
  llmBaseUrl: string;
  llmApiKey: string;
  model?: string;
  contextWindow?: number;
  // Added to Codex's instructions: the agent's name and description.
  instructions: string;
  // The agent's volume: workspace/ (Codex's cwd) and codex/ (CODEX_HOME).
  home: string;
  workspace: string;
  codexHome: string;
  // The image's compiled plugins.
  pluginsDir: string;
  // Outside the volume: gh's login and git's commit identity.
  runDir: string;
  port: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const home = env.AXP_HOME || "/agent";
  const contextWindow = Number(env.AXP_MODEL_CONTEXT_WINDOW);
  return {
    agentId: required(env, "AXP_AGENT_ID"),
    agentKey: required(env, "AXP_AGENT_KEY"),
    controlToken: required(env, "AXP_CONTROL_TOKEN"),
    gatewayUrl: required(env, "AXP_GATEWAY_URL").replace(/\/+$/, ""),
    natsUrl: required(env, "AXP_NATS_URL"),
    llmBaseUrl: required(env, "AXP_LLM_BASE_URL"),
    llmApiKey: required(env, "AXP_LLM_API_KEY"),
    model: env.AXP_MODEL || undefined,
    contextWindow:
      Number.isInteger(contextWindow) && contextWindow > 0
        ? contextWindow
        : undefined,
    instructions: env.AXP_INSTRUCTIONS ?? "",
    home,
    workspace: join(home, "workspace"),
    codexHome: env.CODEX_HOME || join(home, "codex"),
    pluginsDir: env.AXP_PLUGINS_DIR || "/opt/axp/plugins",
    runDir: env.AXP_RUN_DIR || "/run/axp",
    port: Number(env.AXP_RUNTIME_PORT) || 8080,
  };
}

/** A Codex config override's value: JSON is valid TOML for strings, numbers and booleans. */
function toml(value: unknown): string {
  if (typeof value === "object" && value !== null) {
    const inner = Object.entries(value).map(
      ([key, v]) => `${JSON.stringify(key)} = ${toml(v)}`,
    );
    return `{${inner.join(", ")}}`;
  }
  return JSON.stringify(value);
}

const config = (key: string, value: unknown): string[] => [
  "-c",
  `${key}=${toml(value)}`,
];

/**
 * Codex's own OpenTelemetry export, to the runtime's OTLP endpoint (the
 * collector, which holds the credentials). Codex reads
 * OTEL_RESOURCE_ATTRIBUTES itself, so its records name the agent.
 */
function telemetry(env: NodeJS.ProcessEnv): string[] {
  const endpoint = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").replace(/\/+$/, "");
  if (endpoint === "") {
    return [];
  }
  const exporter = (signal: string) => ({
    "otlp-http": { endpoint: `${endpoint}/v1/${signal}`, protocol: "binary" },
  });
  const attributes = Object.fromEntries(
    (env.OTEL_RESOURCE_ATTRIBUTES ?? "")
      .split(",")
      .filter((item) => item.includes("="))
      .map((item) => item.split("=", 2)),
  );
  return [
    ...config(
      "otel.environment",
      attributes["deployment.environment.name"] ?? "dev",
    ),
    ...config("otel.log_user_prompt", true),
    ...config("otel.exporter", exporter("logs")),
    ...config("otel.trace_exporter", exporter("traces")),
    ...config("otel.metrics_exporter", exporter("metrics")),
  ];
}

/** Codex's model provider and telemetry, as app-server command-line overrides. */
export function codexArgs(
  s: Settings,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    ...config("model_provider", "axp"),
    ...config("model_providers.axp.name", "AXP"),
    ...config("model_providers.axp.base_url", s.llmBaseUrl),
    ...config("model_providers.axp.wire_api", "responses"),
    ...config("model_providers.axp.env_key", "AXP_LLM_API_KEY"),
    ...(s.contextWindow === undefined
      ? []
      : config("model_context_window", s.contextWindow)),
    ...telemetry(env),
  ];
}
