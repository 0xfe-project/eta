/**
 * Whether the app shows the workspace or the connection page.
 *
 * The workspace is replaced by the connection page only when there is nothing to keep: a cold
 * start, or the user asking for another host. Once this run has been online, a dropped socket, a
 * reconnect, or the retries giving up leave the workspace where it is — the strip over it
 * (`ReconnectingBanner`) says the connection is down — so the conversation, the task and the
 * settings the user had open survive the app going to the background and coming back.
 */
export interface WorkspaceGateState {
  /** The wire is open right now. */
  connected: boolean;
  /** This run has been online at least once. */
  everConnected: boolean;
  /** The user asked for another host: the connection page is what they asked for. */
  changingHost: boolean;
  /** The web workspace has had its least time on screen, so nothing flashes. */
  settled: boolean;
}

export function showsWorkspace(state: WorkspaceGateState): boolean {
  if (state.changingHost || !state.settled) return false;
  return state.connected || state.everConnected;
}

/** Whether the connection screen was opened over a live workspace and can cancel back to it. */
export function canReturnToWorkspace(state: WorkspaceGateState): boolean {
  return (
    state.changingHost &&
    state.settled &&
    (state.connected || state.everConnected)
  );
}

export interface PhoneHostSetupGateState {
  phone: boolean;
  startPage: string;
  hostOpen: boolean;
  providersLoaded: boolean;
  agentsLoaded: boolean;
  agentCount: number;
  hasGroupConversation: boolean;
  hostOrigin?: string;
  /** Host origin for which the user dismissed the phone setup screen during this session. */
  dismissedForOrigin?: string;
}

/**
 * Whether a phone landing on an unconfigured host shows `PhoneHostSetup`.
 * Dismissing the gate lets the user configure the host directly from the phone for the current
 * host session, while resetting automatically if the client switches to another host.
 */
export function showsPhoneHostSetup(state: PhoneHostSetupGateState): boolean {
  if (
    !state.phone ||
    state.startPage !== "chat" ||
    !state.hostOpen ||
    !state.providersLoaded ||
    !state.agentsLoaded ||
    state.agentCount > 0 ||
    state.hasGroupConversation
  ) {
    return false;
  }
  return (
    state.dismissedForOrigin === undefined ||
    state.dismissedForOrigin !== (state.hostOrigin ?? "")
  );
}
