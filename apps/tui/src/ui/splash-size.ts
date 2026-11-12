/** How much room the splash needs. */
import { LOGO_LINES } from "./logo";

const LOGO_WIDTH = Math.max(...LOGO_LINES.map((line) => [...line].length));
/** Columns between the logo and the text beside it. */
export const LOGO_GAP = 3;
/** The narrowest text column worth drawing beside the logo. */
const MIN_TEXT_WIDTH = 24;
const MIN_COLUMNS = LOGO_WIDTH + LOGO_GAP + MIN_TEXT_WIDTH;

/** Rows the logo form of the splash takes. */
export const SPLASH_LOGO_ROWS = LOGO_LINES.length;

/** Whether the logo form fits across `columns`. */
export function splashLogoFits(columns: number): boolean {
  return columns >= MIN_COLUMNS;
}
