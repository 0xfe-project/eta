/**
 * The daemon as a library: what the primary shares with it, so the two ends cannot disagree (the
 * link's peer, the approval policy, the run of a session, a model definition fit to leave the
 * primary), and the daemon's own parts, for a test that runs one in process.
 */
export { approvalMiddleware, type ApprovalOptions } from "./approval";
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
export { forwardedOptions, modelSpecOf } from "./models";
export { DaemonNode, type DaemonNodeOptions } from "./node";
export { listen, runAndWait } from "./run";
