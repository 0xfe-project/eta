/** The members and the steward chosen in the second step of `/new`. */

export interface MemberPick {
  /** Agent ids, in the order of the agent list. */
  checked: readonly string[];
  /** One of `checked`, or null: the group has no steward. */
  steward: string | null;
}

/** The first agent, checked and steward. */
export function initialPick(order: readonly string[]): MemberPick {
  const first = order[0];
  return first === undefined
    ? { checked: [], steward: null }
    : { checked: [first], steward: first };
}

/**
 * Checks an agent, or drops it. The first one checked becomes the steward; dropping the steward
 * hands the role to the first checked agent left, or to nobody.
 */
export function toggleMember(
  pick: MemberPick,
  order: readonly string[],
  id: string,
): MemberPick {
  if (!pick.checked.includes(id)) {
    const checked = order.filter(
      (agent) => agent === id || pick.checked.includes(agent),
    );
    return { checked, steward: pick.checked.length === 0 ? id : pick.steward };
  }
  const checked = pick.checked.filter((agent) => agent !== id);
  const steward = pick.steward === id ? (checked[0] ?? null) : pick.steward;
  return { checked, steward };
}

/** Makes a checked agent the steward, or null none; an unchecked one changes nothing. */
export function chooseSteward(pick: MemberPick, id: string | null): MemberPick {
  return id === null || pick.checked.includes(id)
    ? { ...pick, steward: id }
    : pick;
}
