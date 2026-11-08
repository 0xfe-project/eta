/** The required ops the host did not register, in the order they were asked for. */
export function missingOps(
  available: readonly string[],
  required: readonly string[],
): string[] {
  const registered = new Set(available);
  return required.filter((op) => !registered.has(op));
}
