/**
 * The numbers down the side of a long conversation.
 *
 * A few hundred identical squares neither fit on the screen nor say anything. So the rail keeps a
 * handful of anchors that never move (`RAIL_ANCHORS`, evenly spread from the first turn to the
 * last) plus a window around wherever you happen to be reading (`RAIL_WINDOW` either side): far
 * jumps to aim at, nearby steps to take. What is skipped between two rows is one `⋯` carrying the
 * count — it is a real row, because "there are 40 turns you are not seeing" is information.
 *
 * Pure, so the arithmetic can be checked without a scroll container.
 */

export const RAIL_ANCHORS = 6;
export const RAIL_WINDOW = 3;

export interface RailRow {
  /** The index this row stands for; absent for a `⋯` row. */
  index?: number;
  /** How many entries the `⋯` above this row swallowed. */
  skipped: number;
}

/** 44 characters: enough to recognise the message, short enough for a tooltip. */
export function preview(text: string | undefined): string {
  if (text === undefined) return "";
  const squashed = text.trim().replace(/\s+/g, " ");
  return squashed.length <= 44 ? squashed : `${squashed.slice(0, 44)}…`;
}

/** The rows the rail shows for `total` entries while entry `focus` is on screen. */
export function railRows(
  total: number,
  focus: number,
  anchors = RAIL_ANCHORS,
  span = RAIL_WINDOW,
): RailRow[] {
  if (total < 2) return [];
  const at = focus >= 0 && focus < total ? focus : total - 1;
  const picked = new Set<number>([0, total - 1]);
  for (let step = 1; step < anchors - 1; step += 1) {
    picked.add(Math.round((step * (total - 1)) / (anchors - 1)));
  }
  for (let index = at - span; index <= at + span; index += 1) {
    if (index >= 0 && index < total) picked.add(index);
  }
  const rows: RailRow[] = [];
  let previous = -1;
  for (const index of [...picked].sort((left, right) => left - right)) {
    if (index - previous > 1) rows.push({ skipped: index - previous - 1 });
    rows.push({ index, skipped: 0 });
    previous = index;
  }
  return rows;
}

/** Which entry is the first one visible: what the rail marks as "you are here". */
export function firstVisible(
  offsets: readonly { id: string; top: number }[],
): string | undefined {
  const visible = offsets.find((entry) => entry.top >= -8);
  return (visible ?? offsets.at(-1))?.id;
}
