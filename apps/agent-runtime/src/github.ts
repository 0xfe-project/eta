// gh logged in as AXP's GitHub App; git gets its credentials from gh
// (/etc/gitconfig). The forge service's token goes to gh's hosts.yml: the
// user's, when they authorized the App (gh then names them), else the App's.
// The App's bot becomes the commit identity in GitHub repositories. Both live
// in /run, outside the agent's volume, and are refreshed before they expire.

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MARGIN_SECONDS = 300;
const RETRY_SECONDS = 60;

export interface GitHubSettings {
  gatewayUrl: string;
  agentKey: string;
  runDir: string;
}

interface Credentials {
  token: string;
  expires_at: number;
  user?: string;
  identity?: { name: string; email: string } | null;
}

async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

/** Seconds until the next refresh. */
async function refreshGitHub(s: GitHubSettings): Promise<number> {
  const hosts = join(s.runDir, "gh", "hosts.yml");
  let response: Response;
  try {
    response = await fetch(`${s.gatewayUrl}/forge/credentials`, {
      headers: { Authorization: `Bearer ${s.agentKey}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.warn("Cannot reach the forge service", error);
    return RETRY_SECONDS;
  }
  if (!response.ok) {
    if (response.status < 500) {
      await rm(hosts, { force: true }); // not connected, or no longer
    }
    return RETRY_SECONDS;
  }
  const answer = (await response.json()) as Credentials;
  if (
    typeof answer.token !== "string" ||
    typeof answer.expires_at !== "number"
  ) {
    console.warn("Unexpected answer from the forge service");
    return RETRY_SECONDS;
  }
  const identity = answer.identity ?? null;
  const user = answer.user || identity?.name || "x-access-token";
  await writePrivate(
    hosts,
    `github.com:\n    oauth_token: ${answer.token}\n    user: ${user}\n    git_protocol: https\n`,
  );
  if (identity) {
    await writePrivate(
      join(s.runDir, "git", "github.inc"),
      `[user]\n\tname = ${identity.name}\n\temail = ${identity.email}\n`,
    );
  }
  return Math.max(
    RETRY_SECONDS,
    answer.expires_at - Date.now() / 1000 - MARGIN_SECONDS,
  );
}

export function keepGitHubLoggedIn(s: GitHubSettings): void {
  const loop = async (): Promise<void> => {
    let delay = RETRY_SECONDS;
    try {
      delay = await refreshGitHub(s);
    } catch (error) {
      console.warn("GitHub refresh failed", error);
    }
    setTimeout(() => void loop(), delay * 1000).unref();
  };
  void loop();
}
