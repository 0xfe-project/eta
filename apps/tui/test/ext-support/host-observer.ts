/**
 * A second client of the host, apart from the interface under test: what a test reads to see that
 * the host itself changed, not only the screen. It is closed after the test.
 */
import type { Host } from "@eta/app/src/host";
import type { Client } from "../../../eta/test/support/client";
import { afterEach } from "vitest";
import { connect, until } from "../../../eta/test/support/client";

const open = new Set<Client>();

afterEach(() => {
  for (const client of open) client.close();
  open.clear();
});

export interface HostObserver {
  client: Client;
  /** A section of a target as the host last sent it; the target is subscribed on first use. */
  section: <T>(target: string, name: string) => T | undefined;
  /** Waits until `predicate` holds for what the host has sent. */
  until: (predicate: () => boolean, timeoutMs?: number) => Promise<void>;
}

export async function observeHost(
  host: Host,
  token?: string,
): Promise<HostObserver> {
  const client = await connect(
    `ws://127.0.0.1:${host.port}/ws`,
    token === undefined ? {} : { authorization: `Bearer ${token}` },
  );
  open.add(client);
  await client.hello();
  const subscribed = new Set<string>();
  return {
    client,
    section: <T>(target: string, name: string) => {
      if (!subscribed.has(target)) {
        subscribed.add(target);
        client.subscribe(target);
      }
      return client.section<T>(target, name);
    },
    until: async (predicate, timeoutMs = 10_000) => until(predicate, timeoutMs),
  };
}
