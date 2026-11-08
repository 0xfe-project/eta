const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Which of `count` colours the agent `agentId` is framed in: the 32-bit FNV-1a hash of the id's
 * UTF-16 code units, modulo `count`. The same id gets the same index in every conversation and on
 * every start. `count` is at least 1.
 */
export function agentColourIndex(agentId: string, count: number): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < agentId.length; i += 1) {
    hash ^= agentId.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return (hash >>> 0) % count;
}

/**
 * The colour of `agentId`'s frame among `colours` (at least one) in a conversation whose members
 * are `memberIds`, in any order. Each member prefers the colour `agentColourIndex` picks; taking
 * the members in order of id, one whose preferred colour is taken gets the next colour after it
 * not yet taken, going round the list. Only once every colour is taken does a colour go to a
 * second member, again preferred first. An agent not among the members gets its preferred colour.
 */
export function agentColour<T>(
  agentId: string,
  memberIds: readonly string[],
  colours: readonly T[],
): T {
  const count = colours.length;
  const members = [...new Set(memberIds)].sort();
  if (!members.includes(agentId))
    return colours[agentColourIndex(agentId, count)]!;
  const taken = new Set<number>();
  for (const member of members) {
    if (taken.size === count) taken.clear();
    let index = agentColourIndex(member, count);
    while (taken.has(index)) index = (index + 1) % count;
    if (member === agentId) return colours[index]!;
    taken.add(index);
  }
  return colours[agentColourIndex(agentId, count)]!;
}
