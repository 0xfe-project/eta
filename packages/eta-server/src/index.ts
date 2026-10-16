/**
 * The eta server host: many sessions in one process, each one a harness session
 * behind a store.
 *
 * Ported from eta-old's `eta-server`, minus the wire transport and the bundled
 * plugins: this repository builds its own HTTP/SSE face and its own plugins
 * (see REFACTOR.md §9, step P0.2b).
 */

export {
  FileSessionStore,
  type FileSessionStoreOptions,
  JOURNAL_FILE,
  META_FILE,
} from "./file-store";
export { forkWrites } from "./fork";
export {
  type CreateSessionOptions,
  type ForkSessionOptions,
  type ManagedSession,
  newSessionId,
  SessionManager,
  type SessionManagerOptions,
  type SessionMemoryWiring,
  registerSessionTools,
} from "./manager";
export { MemorySessionStore, type SessionStorageFactory } from "./memory-store";
export {
  DEFAULT_PROVIDER,
  formatModelId,
  type ModelIdentity,
  parseModelId,
} from "./model-id";
export {
  describeCard,
  discoverPersonas,
  type DiscoverPersonasOptions,
  FALLBACK_PERSONA,
  fallbackPersona,
  personaDirs,
  resolvePersona,
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
  type Settings,
  settingsPath,
  SettingsStore,
  type SettingsStoreOptions,
} from "./settings";
export type {
  SessionListing,
  SessionMeta,
  SessionSeed,
  SessionStore,
  StoredSession,
} from "./store";
export {
  type SessionSubagentOptions,
  sessionSubagentRunner,
  SubagentFailed,
} from "./subagent";
export type {
  MountedPlugin,
  PluginPanelDescriptor,
} from "@eta/client-contracts";
