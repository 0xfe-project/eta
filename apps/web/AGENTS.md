# Web UI Development Conventions

## 1. Ablative Design

Follow Occam's Razor: inspect each UI element and try removing it. If removal doesn't affect understanding or operation, don't keep it. New elements must also have a clear purpose.

## 2. Minimal Copy

Don't add explanations to self-explanatory controls. Remove duplicate titles, status prompts, and redundant labels; keep only information necessary for understanding current state, completing operations, and handling errors. When removing visible copy, still preserve necessary accessibility names and semantics.

## 3. Compact Layout

Use space like a car dashboard. Avoid stacking multiple layers of padding and margin; establish hierarchy through alignment, grouping, and minimal whitespace, using few dividers. Compact layout should still preserve clear operation space and readability.

## 4. Components first

Prefer existing shadcn components; do not reinvent their appearance or change component structure and spacing without reason.

## 5. Direct, fast animation

Interaction transitions use 60ms linear by default, with no trailing or bouncing. All Tabs with the default variant have a built-in sliding selected indicator, implemented via a shared component and not customized repeatedly on every page. Respect the prefers-reduced-motion setting.

## 6. Chinese and English UI

All product UI is maintained in Simplified Chinese and English via react-i18next, including buttons, navigation, settings, hints, errors, and accessibility labels. Maintain `src/locales/zh/<namespace>.json` and `en/<namespace>.json` by feature, with shared copy in common. Use English semantic keys and nested paths; Chinese keys, full-sentence copy keys, and dynamic text as keys are forbidden; name interpolation parameters by meaning. Components explicitly declare their namespace, e.g. `useTranslation(["tasks", "common"] as const)`; outside components, use namespaced `translate("tasks:status.todo")`. When adding copy, update both Chinese and English resources and comply with i18next type constraints and resource coverage checks. Follow the user's system language by default; fall back to English for unsupported languages. Can be switched in Settings → Appearance. Product names such as Claude, Codex, and Grok, code, and commands stay as-is; route paths, internal identifiers, and user content do not need translation.

## 7. Visual constraints

Use square corners globally. Support light and dark themes (with follow system selectable in settings); all colors go through color variables; do not scatter hardcoded colors in components that apply to only one theme.

## 8. Code structure

Separate pages, components, and shared state. Full-window and other standalone pages use real routes, supporting direct access, refresh, and browser history navigation; shared UI reuses components.

## 9. Data goes only through wire

The UI reads and writes to the host only through the single WebSocket in `src/lib/wire.ts`: state comes from `hello` and `state` frames, and actions are `target.action` calls. Do not open a separate `fetch` or polling for a feature; for plugins not mounted by the host (`hello.mounted`), hide the corresponding entry point.
