import { context } from "nsh";

/**
 * The width a line of the editor's text has (its box less its padding), for the inline blocks
 * in it: a block never runs past the line (a phone's box beside ＋ and ↑). Provided by
 * `EtaEditor` around the editor; 0 where none is, which leaves a block its own limit.
 */
export const LineRoom = context<() => number>(() => 0);
