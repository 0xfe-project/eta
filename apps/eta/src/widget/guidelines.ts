/**
 * What `visualize_read_me` returns: how to write a widget that draws well in the web chat. One
 * core section, then a section per module the model asks for, so a chart does not pay for the
 * diagram rules. The variables and classes named here are the ones the page's frame defines.
 */

export const WIDGET_MODULES = [
  "interactive",
  "chart",
  "diagram",
  "mockup",
  "art",
] as const;

export type WidgetModule = (typeof WIDGET_MODULES)[number];

const CORE = `# Widgets

A widget is an HTML or SVG fragment drawn in the conversation, under your reply, in a sandboxed
frame as wide as the chat column (about 640px; it may be narrower on a phone). It is drawn while
you write it: each element appears, fading in, as soon as its markup has arrived. Scripts run
once, after the whole widget has arrived.

Use one when the answer is easier to see than to read: a chart of numbers, a diagram of how
parts connect, a dashboard of a status, an explainer the reader can play with. For prose, code
or a single number, just write. The reply should say in a sentence what the widget shows and
what to take from it, without repeating its numbers.

## Writing it so it streams well

- A fragment: no <!doctype>, <html>, <head> or <body>.
- Order: one short <style> first, then the markup from top to bottom, then <script> last. The
  reader watches it build, so put the headline (title, key numbers) first.
- The markup must read as finished before any script runs: real text and numbers in the HTML,
  not filled in by JavaScript. Scripts are for charts, canvas and interaction.
- Keep it under 40KB. Height follows the content; do not set a fixed page height.
- For an SVG on its own, start the code with <svg> and give it a viewBox (width 640).

## Look

The frame follows the app's light or dark theme. Use these variables, never fixed colours (except
for the data palettes below):

- Text: --color-text-primary, --color-text-secondary, --color-text-tertiary
- Surfaces: --color-background-primary (the page; leave the body transparent),
  --color-background-secondary (cards, wells)
- Lines: --color-border-primary, --color-border-secondary, --color-border-tertiary (hairlines)
- States, as text/border and as a tinted background: --color-text-info, --color-text-success,
  --color-text-warning, --color-text-danger, and --color-background-info, ...-success,
  ...-warning, ...-danger
- Data series, in order: --color-series-1 … --color-series-6
- Fonts: --font-sans (default), --font-mono (numbers in tables, code)
- Corners are square: --border-radius-md and --border-radius-lg are 0. Keep it that way.

Type: 13–14px body, 12px labels, 18–22px for a key number, weights 400 and 500. Spacing is
compact: 8–16px gaps, 1px hairlines in --color-border-tertiary. No gradients, shadows or emoji.
Write all text in the user's language.

## What is there

- Scripts may load from https://cdnjs.cloudflare.com and https://cdn.jsdelivr.net/npm/ with an
  exact version, e.g. https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js,
  https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js. Nothing else loads: no fetch, no
  remote images or fonts (inline SVG and data: URLs work), no localStorage.
- \`sendPrompt(text)\` puts text in the user's message box; nothing is sent until the user presses
  send themselves. Use it for a button that drafts the next question ("Break down the slowest
  step"); never call it on load.
- Everything else (clicks, sliders, animation) stays inside the widget; you are not told about it.
`;

const SECTIONS: Record<WidgetModule, string> = {
  interactive: `## Interactive explainers

- Controls on top or on the left, the thing they change right next to them, so cause and effect
  are seen together.
- <input type="range"> for numbers (show the current value beside it), <select> or a row of
  buttons for choices. Update on "input", not "change", so dragging is live.
- Compute the first state in the script from the controls' starting values, so the numbers in the
  markup and the first frame agree.
- Format with Intl.NumberFormat (currency, percent, compact) in the user's locale.
- Metric cards: a 12px label in --color-text-secondary above a 20px number; a row of 2–4 in a
  CSS grid (repeat(auto-fit, minmax(140px, 1fr))).
- Buttons: 1px --color-border-secondary, transparent background, --color-text-primary; the
  pressed one takes --color-background-secondary.
`,
  chart: `## Charts (Chart.js)

- Load https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js in a <script src>,
  then the chart in a following inline <script>.
- Put the canvas in a wrapper with an explicit height: <div style="position:relative;height:260px">
  <canvas id="c"></canvas></div>, and set responsive: true, maintainAspectRatio: false.
- Read colours from the variables at run time:
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  then use css('--color-series-1') … for datasets, css('--color-text-secondary') for ticks and
  css('--color-border-tertiary') for grid lines. Set Chart.defaults.font.family to css('--font-sans').
- Keep Chart.js's own animation on: the chart drawing in is part of the effect.
- One idea per chart; 1–3 charts per widget. Bar for comparing, line for change over time,
  doughnut only for parts of one whole with few parts.
- Replace the default legend with a small HTML legend above the chart when there is more than one
  series; put headline numbers above the chart as metric cards.
- Axis labels short; format ticks (k, %, currency) with a callback.
`,
  diagram: `## Diagrams (SVG)

- <svg viewBox="0 0 640 H" width="100%"> with H as small as the content allows.
- Classes the frame defines: .t (14px text), .ts (12px secondary text), .th (14px, weight 500),
  .box (a neutral node: secondary surface, border), .arr (a connector line), .leader (a dashed
  guide line). Colour a node by wrapping its shapes and text in <g class="c-blue"> (also c-teal,
  c-amber, c-red, c-purple, c-gray): the rect takes a tinted fill and border, the text a matching
  colour.
- Arrowheads: define <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6"
  markerHeight="6" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="context-stroke"/>
  </marker> and set marker-end="url(#a)" on .arr paths.
- Lay nodes out on a grid (columns at fixed x, rows at fixed y); give boxes room for their text
  (about 7px per character at 14px) and centre text with text-anchor="middle" and
  dominant-baseline="central".
- Draw top to bottom or left to right, one direction per diagram; route arrows with straight or
  right-angled paths, never across a box.
- Emit nodes in reading order, so the diagram builds the way it is read.
`,
  mockup: `## Mockups

- Draw the interface at the size it is used; a phone screen 320–360px wide, centred.
- Build it from plain elements styled with the variables: inputs with a 1px border, buttons, list
  rows with hairlines between them, tabs as a row of text with the selected one underlined.
- Real-looking content (names, dates, amounts), never lorem ipsum.
- Show one state at a time; if states matter, a row of buttons above it switches them.
`,
  art: `## Illustration and animation

- Static: an inline SVG with simple shapes and the variables' colours.
- Moving: a <canvas> sized to its container (width = clientWidth * devicePixelRatio) driven by
  requestAnimationFrame; keep it under ~60 lines of script.
- When matchMedia('(prefers-reduced-motion: reduce)').matches, draw one still frame instead.
- Physical or mathematical subjects (orbits, waves, sorting) explain best with a slider for the
  one parameter that matters.
`,
};

export function widgetGuidelines(modules: readonly WidgetModule[]): string {
  return [CORE, ...[...new Set(modules)].map((name) => SECTIONS[name])].join(
    "\n",
  );
}
