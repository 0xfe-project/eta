/**
 * The daemon as a library: what the primary shares with it, so the two ends cannot disagree (the
 * link's peer, the run of a session, a model definition fit to leave the
 * primary), and the daemon's own parts, for a test that runs one in process.
 */
export {
  DaemonLink,
  type DaemonLinkOptions,
  type LinkServer,
  type LinkState,
} from "./client";
export { enroll } from "./enroll";
export {
  fingerprintOf,
  groupFingerprint,
  type Identity,
  loadIdentity,
} from "./identity";
export {
  type CallOptions,
  LinkError,
  Peer,
  type PeerOptions,
  type ServeContext,
  type ServeHandler,
} from "./link/peer";
export {
  mcpServerKey,
  parseCredentialCall,
  relayCredentialStore,
  RELAYED_KINDS,
} from "./mcp-auth";
export { McpHost, type McpHostOptions, type PluginOwner } from "./mcp-host";
export { forwardedOptions, modelSpecOf } from "./models";
export { DaemonNode, type DaemonNodeOptions } from "./node";
export {
  pluginChunks,
  pluginHash,
  pluginSignature,
  PluginStore,
} from "./plugin-files";
export {
  type ActivePlugin,
  claimServerNames,
  plainRemote,
  pluginDataDir,
  pluginMcpSources,
  type PluginServersInput,
  type ResolvedServer,
  resolvePluginServers,
  runtimeExtras,
  type ServerNameClash,
  type ServersConfig,
  serversConfig,
  serverSupported,
  sessionServerName,
  toMcpEntries,
  toSessionServers,
  type UserEnvInput,
  type UserHeaderInput,
  withSessionServers,
} from "./plugin-launch";
export {
  loadPlugin,
  PluginError,
  type PluginPackage,
  type PluginServer,
} from "./plugin-package";
export { lastSeq, listen, runAndWait } from "./run";
export {
  type DetachedRunner,
  installedEnv,
  passedValues,
  type ServiceManager,
  type ServiceStatus,
  type ServiceUnit,
} from "./service";
export { detachedRunner, serviceManager } from "./service-manager";
export type { WindowsOptions } from "./service-windows";
export {
  dropStaged,
  previousPath,
  stagedPath,
  swapBack,
  swapIn,
  sweepPrevious,
  tryBuild,
} from "./swap";
export { daemonPlatform } from "./upgrade";
