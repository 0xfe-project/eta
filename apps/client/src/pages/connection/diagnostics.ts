import type { HostAddress } from "../../services/host";

export type ConnectionFailure =
  | "token"
  | "address"
  | "not-eta"
  | "local"
  | "offline"
  | "checksum"
  | "lost";

export async function diagnose(
  address: HostAddress,
): Promise<ConnectionFailure> {
  const timeout = AbortSignal.timeout(3500);
  try {
    const up = await fetch(`${address.origin}/up`, {
      signal: timeout,
      redirect: "error",
    });
    if (!up.ok || (await up.text()).trim() !== "ok") return "not-eta";
    const reply = await fetch(`${address.origin}/ws`, {
      headers: address.token
        ? { Authorization: `Bearer ${address.token}` }
        : {},
      signal: timeout,
      redirect: "error",
    });
    return reply.status === 401 ? "token" : "not-eta";
  } catch {
    return "address";
  }
}
