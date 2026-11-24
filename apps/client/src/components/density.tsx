import type { JSX } from "nsh";
import type { DensityName } from "./tokens";
import { Density } from "./theme";

const regular = (): DensityName => "regular";

/**
 * A part of the app drawn compact (tokens.ts `densities`): the side panels, board cards, menus
 * and popovers, the sidebar's lists. Its `Label`s, `Button`s, `Icon`s, avatars, editors and
 * Markdown take the compact defaults. With `when` false it keeps the
 * density around it (a list that is a sidebar on a computer and the page on a phone).
 */
export function Compact(props: { when?: boolean; children?: JSX.Element }) {
  const around = Density();
  const density = (): DensityName =>
    props.when === false ? around() : "compact";
  return <Density.Provider value={density}>{props.children}</Density.Provider>;
}

/** Back to regular inside a compact part, for what opens over the whole app from it (a dialog). */
export function Regular(props: { children?: JSX.Element }) {
  return <Density.Provider value={regular}>{props.children}</Density.Provider>;
}
