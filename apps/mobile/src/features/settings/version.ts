import type { HostAddress } from "../../app/session";
import { httpUrl } from "../../wire/native-socket";

type ReadVersion = (target: HostAddress) => Promise<string | undefined>;

/** `GET /version`, which is outside the wire. A host that serves no page has none. */
let read: ReadVersion = async (target) => {
  const response = await fetch(httpUrl(target.address, "/version"), {
    headers: target.token === "" ? {} : { "X-Eta-Token": target.token },
  });
  if (!response.ok) return undefined;
  const version = (await response.text()).trim();
  return version === "" ? undefined : version;
};

/** Replaced by the fake host: there is no port to ask. */
export function useVersionReader(next: ReadVersion): void {
  read = next;
}

export function hostVersion(target: HostAddress): Promise<string | undefined> {
  return read(target).catch(() => undefined);
}
