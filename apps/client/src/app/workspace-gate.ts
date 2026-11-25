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
