/**
 * An answer for the user or the agent, with the HTTP status the original forge service gave it.
 * The status is only a classification here (the wire has no statuses); the code and the message
 * are what a client acts on and shows.
 */
export class GithubError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "GithubError";
    this.code = code;
    this.status = status;
  }
}

const NOT_CONNECTED_MESSAGE =
  "GitHub is not connected yet. Ask the user to connect GitHub via the wizard in eta's "Settings → Connections".";

export const notConnected = (): GithubError =>
  new GithubError("GITHUB_NOT_CONNECTED", 409, NOT_CONNECTED_MESSAGE);

/** What the user or agent is told about an error. */
export const messageOf = (error: unknown): string =>
  error instanceof GithubError
    ? error.message
    : "The code hosting service errored, please try again later.";
