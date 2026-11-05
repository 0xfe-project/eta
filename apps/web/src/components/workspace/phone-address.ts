/** Whether a name only this computer can reach: a phone cannot dial it. */
export function isLoopback(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    name === "localhost" || name === "::1" || /^127(?:\.\d{1,3}){3}$/.test(name)
  );
}
