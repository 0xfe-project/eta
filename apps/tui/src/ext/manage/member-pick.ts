/** The members and the steward chosen in the second step of `/new`. */

export interface MemberPick {
  /** Agent ids, in the order of the agent list. */
  checked: readonly string[];
  /** One of `checked`, or none. */
  steward: string | undefined;
}

/** The project's steward when it is in the list, else the first agent; checked and steward. */
export function initialPick(
  order: readonly string[],
  projectSteward: string | null | undefined,
): MemberPick {
  const first =
    projectSteward != null && order.includes(projectSteward)
      ? projectSteward
      : order[0];
  return first === undefined
    ? { checked: [], steward: undefined }
    : { checked: [first], steward: first };
}

/**
 * Checks an agent, or drops it. Dropping the steward hands the role to the first checked agent
 * left, or to nobody.
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
    return { checked, steward: pick.steward };
  }
  const checked = pick.checked.filter((agent) => agent !== id);
  const steward = pick.steward === id ? checked[0] : pick.steward;
  return { checked, steward };
}

/** Makes a checked agent the steward; an unchecked one changes nothing. */
export function chooseSteward(pick: MemberPick, id: string): MemberPick {
  return pick.checked.includes(id) ? { ...pick, steward: id } : pick;
}
