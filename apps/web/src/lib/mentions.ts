interface Member {
  agent_id: string;
  name: string;
}
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Disambiguate equal display names without exposing an id for every member. */
export function mentionLabel(member: Member, members: Member[]) {
  return members.filter((p) => p.name === member.name).length > 1
    ? `${member.name}·${member.agent_id.slice(0, 6)}`
    : member.name;
}

/** Resolve explicit mentions in their written order; a bare message has no targets. */
export function mentionedMembers(text: string, members: Member[]) {
  const match = (label: string) =>
    new RegExp(
      `(?:^|[\\s，。！？、,:;!?])@${escaped(label)}(?=\\s|[，。！？、,:;!?]|$)`,
      "u",
    ).exec(text);
  const everyone = match("所有人");
  const ordered = members.flatMap((p) => {
    const named = match(mentionLabel(p, members));
    const index = Math.min(
      named?.index ?? Infinity,
      everyone?.index ?? Infinity,
    );
    return Number.isFinite(index) ? [{ id: p.agent_id, index }] : [];
  });
  return ordered.sort((a, b) => a.index - b.index).map((p) => p.id);
}
