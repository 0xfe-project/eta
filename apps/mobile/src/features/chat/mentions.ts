// Ported from apps/web/src/lib/mentions.ts: keep the two in step.

interface Member {
  id: string;
  name: string;
}
/**
 * Who a group's messages keep going to once the user has chosen. `"everyone"` holds no list, so it
 * means whoever the members are when a message goes; having no value at all means the steward.
 */
export type StickyTarget = "everyone" | string[];
/** Who the next message reaches, one answer for the composer and everything that sends. */
export interface ComposerTarget {
  /** What the composer says: nobody yet, the steward, everyone, or the members in `ids`. */
  kind: "none" | "steward" | "everyone" | "members";
  /** Everyone it reaches, the steward included when the host is the one to pick them. */
  ids: string[];
  /** What goes out with the message. Empty leaves it to the host, so a new steward just applies. */
  mentions: string[];
  /** What the group keeps for its next message; nothing means back to the steward. */
  sticky: StickyTarget | undefined;
}
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const written = (text: string, label: string) =>
  new RegExp(
    `(?:^|[\\s，。！？、,:;!?])@${escaped(label)}(?=\\s|[，。！？、,:;!?]|$)`,
    "u",
  ).exec(text);
// Both aliases remain valid in saved drafts after switching language.
const everyoneMention = (text: string) =>
  [written(text, "所有人"), written(text, "everyone")]
    .filter((result) => result !== null)
    .sort((a, b) => a.index - b.index)[0];

/** Disambiguate equal display names without exposing an id for every member. */
export function mentionLabel(member: Member, members: readonly Member[]) {
  return members.filter((p) => p.name === member.name).length > 1
    ? `${member.name}·${member.id.slice(0, 6)}`
    : member.name;
}

/** Resolve explicit mentions in their written order; a bare message has no targets. */
export function mentionedMembers(text: string, members: readonly Member[]) {
  const everyone = everyoneMention(text);
  const ordered = members.flatMap((p) => {
    const named = written(text, mentionLabel(p, members));
    const index = Math.min(
      named?.index ?? Infinity,
      everyone?.index ?? Infinity,
    );
    return Number.isFinite(index) ? [{ id: p.id, index }] : [];
  });
  return ordered.sort((a, b) => a.index - b.index).map((p) => p.id);
}

/**
 * Who a draft goes to: what it names, else what the group kept, else the steward. A saved member
 * who has left simply stops counting, and a choice with nobody left in it is no choice.
 */
export function composerTarget({
  text,
  members,
  steward,
  sticky,
}: {
  text: string;
  members: readonly Member[];
  steward: Member | undefined;
  sticky: StickyTarget | undefined;
}): ComposerTarget {
  const stewardTarget: ComposerTarget =
    steward === undefined
      ? { kind: "none", ids: [], mentions: [], sticky: undefined }
      : { kind: "steward", ids: [steward.id], mentions: [], sticky: undefined };
  const all = members.map((member) => member.id);
  const named = mentionedMembers(text, members);
  if (everyoneMention(text) !== undefined && named.length > 0)
    return {
      kind: "everyone",
      ids: named,
      mentions: named,
      sticky: "everyone",
    };
  // Naming the steward is going back to them, so a later steward change still applies.
  if (named.length === 1 && named[0] === steward?.id)
    return { ...stewardTarget, mentions: named };
  if (named.length > 0)
    return { kind: "members", ids: named, mentions: named, sticky: named };
  // A steward who is not a member yet can be named too: the host adds them for the wake.
  if (
    steward !== undefined &&
    !all.includes(steward.id) &&
    mentionedMembers(text, [steward]).length > 0
  )
    return stewardTarget;
  if (sticky === "everyone" && all.length > 0)
    return { kind: "everyone", ids: all, mentions: all, sticky };
  const kept =
    sticky === undefined || sticky === "everyone"
      ? []
      : sticky.filter((id) => all.includes(id));
  return kept.length > 0
    ? { kind: "members", ids: kept, mentions: kept, sticky: kept }
    : stewardTarget;
}
