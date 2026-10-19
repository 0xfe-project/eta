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
  "GitHub 还没有连接。请让用户在 eta 的“设置 → 连接”里按向导连接 GitHub。";

export const notConnected = (): GithubError =>
  new GithubError("GITHUB_NOT_CONNECTED", 409, NOT_CONNECTED_MESSAGE);

/** What the user or agent is told about an error. */
export const messageOf = (error: unknown): string =>
  error instanceof GithubError
    ? error.message
    : "代码托管服务出错，请稍后再试。";
