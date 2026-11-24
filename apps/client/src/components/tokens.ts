import type { TextVariant } from "./theme";

// The design's numbers, said once (#356, the plan in "NSH 客户端设计值盘点与收敛方案" v3).
// Every length is 1, 2 or a multiple of 4. Colours are the palette's (theme.ts `light` / `dark`),
// text sizes the type scale's (theme.ts `typeScale`). What is not a token (a row's height, a
// column's or a dialog's width) is a named constant in its component, on the same grid
// (`dialogWidth`, `const rowHeight = 52`). A number written anywhere else needs a
// `// design-value: <reason>` (scripts/check-design-values.ts).

/** The one scale of lengths: spacing, offsets and the height of a row (its text's line height
 * and the space around it). 1 is the hairline beside a 1px border. */
export const space = {
  1: 1,
  2: 2,
  4: 4,
  8: 8,
  12: 12,
  16: 16,
  20: 20,
  24: 24,
  32: 32,
  40: 40,
  48: 48,
  64: 64,
} as const;

/** The height of a control (a button, an input, a select); `touch` is the least a finger gets on
 * a phone. */
export const control = { sm: 24, md: 28, lg: 32, touch: 44 } as const;

/** An icon's size; `xl` is an empty state's. */
export const icon = { sm: 12, md: 16, lg: 20, xl: 32 } as const;

/** An avatar's size; `xl` is Captain's card and the avatar editor. */
export const avatar = { sm: 16, md: 24, lg: 32, xl: 40 } as const;

/** The two weights the shipped face draws: Regular, and Bold for 600. */
export const weight = { regular: 400, strong: 600 } as const;

/** Letter spacing, in em of the text's size: `caps` for uppercase captions, `tight` for display
 * text. */
export const tracking = { caps: 0.08, tight: -0.02 } as const;

/** A tracking step in pixels, for text of `size` (a `Label` takes `tracking` itself). */
export const tracked = (step: keyof typeof tracking, size: number) =>
  tracking[step] * size;

/** Border widths. */
export const border = { hair: 1, thick: 2 } as const;

/** A view drawn faded: `disabled` (what cannot be used now), `muted` (what is there but not the
 * point). */
export const opacity = { disabled: 0.45, muted: 0.7 } as const;

/** What draws over what: a sticky bar, a dialog with its scrim, a toast. Order inside one
 * component (1, 2, 3) is that component's own. */
export const layer = { sticky: 10, modal: 100, toast: 1000 } as const;

/** A shadow, as a `boxShadow` entry: `popover` for menus and popovers, `float` for what floats
 * over content (a toast, a floating button). The colours are today's, the same in both themes. */
export const shadow = {
  popover: { x: 0, y: 8, blur: 24, color: "#0000001f" },
  float: { x: 0, y: 4, blur: 16, color: "#0a0a0a14" },
} as const;

/** The keyboard focus ring (its colour is the palette's `ring`): `ring` 2px outside the view,
 * `ringInset` 1px inside, for a row against an edge that would cut a ring outside it off. */
export const focus = {
  ring: { outlineWidth: 2, outlineOffset: 2 },
  ringInset: { outlineWidth: 1, outlineOffset: -1 },
} as const;

/** The layout's fixed sizes. */
export const sizes = {
  sidebar: 288,
  tabletList: 320,
  rail: 64,
  panel: 400,
  header: 40,
  sectionHeader: 36,
  phoneNav: 64,
};

/** How tightly a part of the app is drawn (the `Density` context in theme.ts): `regular` in the
 * main area (chat, a task's page, Settings, routines); `compact` in the side panels, board cards,
 * menus and popovers, sidebar lists. */
export type DensityName = "compact" | "regular";

/** What a component takes by default in each density, when its caller says nothing. */
export interface DensityDefaults {
  /** A `Label`'s role. */
  text: TextVariant;
  /** A `Button`'s height and the size of its icon. */
  button: number;
  buttonIcon: number;
  /** An `Icon`'s size. */
  icon: number;
  /** An `AgentFace`'s size. */
  avatar: number;
  /** The role of an editor's text (`chatText.Editor`). */
  editor: "body" | "small";
}

/**
 * The defaults by density: `regular` takes the main area's steps, `compact` the side panels'
 * (the parts that say `<Compact>` at their root, density.tsx).
 */
export const densities: Record<DensityName, DensityDefaults> = {
  regular: {
    text: "body",
    button: control.sm,
    buttonIcon: icon.sm,
    icon: icon.md,
    avatar: avatar.md,
    editor: "body",
  },
  compact: {
    text: "small",
    button: control.sm,
    buttonIcon: icon.sm,
    icon: icon.sm,
    avatar: avatar.sm,
    editor: "small",
  },
};
