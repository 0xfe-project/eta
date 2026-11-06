/**
 * @eta/server — many sessions, one process.
 *
 * The harness answers "what does one session need to run". The server answers
 * "how do several of them live together": where a session's metadata and journal
 * come from, which ones are open right now, and what happens to the others when
 * one of them is closed.
 *
 * The shape it is being built toward, in order:
 * - a `SessionStore` seam (`meta.json`-shaped metadata beside a storage handle)
 *   with a memory implementation first, so the seam is exercised before the disk
 *   is;
 * - a `SessionManager` that opens sessions through the harness's `openSession`
 *   and keeps them apart: each session has its own kernel, bus, journal and
 *   usage, and closing one leaves the rest running;
 * - a file-backed store, where a restart finds what the last run left behind.
 *
 * Session metadata lives beside the journal rather than inside it because a
 * sidebar needs to list sessions it has not opened: id, creation time, working
 * directory, and optionally a title, persona and model. A session that cannot be
 * read is listed *with its reason* — a session must never silently disappear.
 */

export {
  PERSONA_ACTIONS,
  personasPlugin,
  type PersonasPluginOptions,
} from "./bundled/personas";
/**
 * The server's parts, as parts. `assembleServer` is the one place they are put together: the
 * transport, the target registry, the plugin manager and `hello`, with every feature — including
 * sessions — arriving as a plugin.
 */
export {
  PROVIDER_ACTIONS,
  providersPlugin,
  type ProvidersPluginOptions,
} from "./bundled/providers";
export {
  type RemoteSessions,
  SESSION_ACTIONS,
  sessionsPlugin,
  type SessionsPluginOptions,
  type SessionsService,
} from "./bundled/sessions";
export {
  SETTINGS_ACTIONS,
  settingsPlugin,
  type SettingsPluginOptions,
} from "./bundled/settings";

/* ------------------------------------------------------------------ the floor */

export {
  CODEX_PROVIDER_ID,
  codexAuthPath,
  CodexCredentialStore,
  CodexLogin,
  type CodexLoginRunner,
  type CodexLoginView,
  LOGIN_TIMEOUT_MS,
  piCodexLogin,
} from "./codex-auth";
export { codexCatalog, codexRuntimeProvider } from "./codex-provider";
export {
  FileSessionStore,
  type FileSessionStoreOptions,
  JOURNAL_FILE,
  META_FILE,
} from "./file-store";
export { forkWrites } from "./fork";
export {
  type CreateSessionOptions,
  type ManagedSession,
  newSessionId,
  registerSessionTools,
  SessionManager,
  type SessionManagerOptions,
  type SessionMcpWiring,
} from "./manager";
export { MemorySessionStore, type SessionStorageFactory } from "./memory-store";
export {
  DEFAULT_PROVIDER,
  formatModelId,
  type ModelIdentity,
  parseModelId,
} from "./model-id";
export {
  initializeNetwork,
  type NetworkCommand,
  type NetworkStatus,
  parseLinuxProxy,
  parseMacProxy,
  parseWindowsProxy,
  PROXY_KEYS,
  readSystemProxy,
  type SystemProxy,
} from "./network";
export { FramePacer, type PacerOptions } from "./pacer";
export {
  AUTOPICK_MAX_TOKENS,
  type AutopickModel,
  describeCard,
  discoverPersonas,
  FALLBACK_PERSONA,
  fallbackPersona,
  parsePersonaAnswer,
  personaDirs,
  type PersonaPick,
  type PersonaPickSource,
  PICKER_SYSTEM_PROMPT,
  resolvePersona,
  suggestPersonaId,
  summarize,
} from "./personas";
export {
  type LoadedPlugin,
  pickPlugin,
  PLUGIN_MANIFEST_KEY,
  PluginManager,
  type PluginManagerOptions,
  type PluginManifest,
} from "./plugins";
export {
  catalogModelsFor,
  parseProviderModelCatalog,
  type ProviderCatalogEntry,
  providerCatalogRestrictsModels,
  providerDefinitionForKind,
  providerModelCatalog,
  providerModelDefinition,
  type ProviderReference,
  resolveConfiguredModels,
} from "./providers/catalog";
export {
  applyProviderHeaders,
  configDefaultModel,
  effectiveModel,
  type EtaConfig,
  type EtaModelConfig,
  type EtaProviderConfig,
  isCustomKind,
  type ModelCapabilities,
  modelDefaultThinking,
  modelSupportsVision,
  modelThinkingLevels,
  providerPreset,
  providerSummary,
  sanitizeProviderHeaders,
} from "./providers/config-types";
export {
  discoverModels,
  discoversModels,
  type DiscoveryOptions,
  type DiscoveryResult,
} from "./providers/discovery";
export {
  buildModels,
  type BuildModelsResult,
  buildProvider,
  type ProviderBuildFailure,
} from "./providers/runtime";
export {
  defaultConfigPath,
  ProviderConfigError,
  ProviderConfigStore,
  type ProviderConfigStoreOptions,
  publicView,
  revisionOf,
} from "./providers/store";
export {
  createTargetRegistry,
  type OpContext,
  type OpHandler,
  type OpMeta,
  type StateProjector,
  type TargetRegistry,
  type TargetSummary,
  UnknownOpError,
} from "./registry";
export {
  createEventRing,
  DEFAULT_RING_CAPACITY,
  type EventRing,
  matchesFilter,
} from "./ring";
export type {
  RuntimeCompaction,
  SessionRuntime,
  SessionRuntimeInput,
  SessionRuntimes,
} from "./runtimes";
export {
  branchMessages,
  firstHit,
  historyOf,
  type HistoryPage,
  historyPageOf,
  type HistoryRow,
  messageText,
  type SearchHit,
} from "./search";
export {
  type AssembledServer,
  type AssembleOptions,
  assembleServer,
  type BundledPluginName,
  pluginDirs,
} from "./server";
export {
  type Settings,
  settingsPath,
  SettingsStore,
  type SettingsStoreOptions,
} from "./settings";
export {
  discoverSkillDirs,
  gitRepoChain,
  renderSkillsBlock,
  type RenderSkillsOptions,
} from "./skills";
export {
  type AddressedFrame,
  createStateSender,
  type StateSender,
  type StateSenderOptions,
} from "./state-sender";
export type {
  SessionListing,
  SessionMeta,
  SessionSeed,
  SessionStore,
  StoredSession,
} from "./store";
export {
  createConnection,
  type EndpointConnection,
  type EndpointSocket,
  peerAddressOf,
  serveWire,
  type Socket,
  type TransportDeps,
  type WebSocketEndpoint,
  type WireServer,
  type WireServerOptions,
} from "./transport";
export {
  type FrameSink,
  WireService,
  type WireServiceOptions,
} from "./wire-service";
