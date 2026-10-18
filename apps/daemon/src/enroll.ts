/**
 * `eta-daemon setup <primary> <code>`: trade a one-time install code for a place on the primary.
 *
 * The daemon makes its own secret and keeps it. All the primary ever sees is the secret's
 * SHA-256, the fingerprint, which doubles as what it checks the credential against later. The
 * fingerprint is printed here and shown in the primary's settings; the user compares the two and
 * approves, which is what makes a stolen code worth nothing on its own.
 */
import type { EnrollRequest, EnrollResponse } from "@eta/client-contracts";
import type { Identity } from "./identity";
import { homedir, hostname, platform } from "node:os";
import { ENROLL_PATH } from "@eta/client-contracts";
import { newSecret, saveIdentity } from "./identity";

export async function enroll(options: {
  dataDir: string;
  /** The primary's address, `http(s)://host:port`. */
  url: string;
  code: string;
  fetch?: typeof fetch;
}): Promise<{ identity: Identity; fingerprint: string }> {
  const url = new URL(options.url);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(
      `the primary's address must be http(s)://host:port, not ${options.url}`,
    );
  const base = `${url.protocol}//${url.host}`;
  const { secret, fingerprint } = newSecret();
  const body: EnrollRequest = {
    code: options.code,
    fingerprint,
    hostname: hostname(),
    home: homedir(),
    os: platform(),
  };
  const response = await (options.fetch ?? fetch)(`${base}${ENROLL_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const reason = (await response.text().catch(() => "")).trim();
    throw new Error(
      `the primary refused the code (${response.status}${reason === "" ? "" : `: ${reason}`})`,
    );
  }
  const { machineId } = (await response.json()) as EnrollResponse;
  const identity: Identity = { url: base, machineId, secret };
  saveIdentity(options.dataDir, identity);
  return { identity, fingerprint };
}
