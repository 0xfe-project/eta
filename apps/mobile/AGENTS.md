# Mobile (apps/mobile)

Native Shell (nsh, TSX on QuickJS) client for iOS/Android. The design draft is in the Paper file "Eta mobile"
(`01M6NVTTY29AE2FET8P4VRX3ZK`), the overview page records the product judgements: **the first screen is "waiting for you"**, **answer in place**, **the process is evidence**,
**the phone is just a screen**, **black and white; red and green reserved for diff and errors**. Not doing: lock-screen push, question-expiry hints, voice transcription, email.
Stays on the computer: models, MCP, approval, editing agents, managing machines.

## Reproducing the design

- Use `get_jsx` (`includeNodeIds:false`, `format:"tailwind"`) for exact values; screenshots are only for comparing the result.
- Paper's exported class names aren't exactly the same as this project's; translate per the table below:

| Paper                                        | Here                                                 |
| -------------------------------------------- | ---------------------------------------------------- |
| `text-md/tight`                              | `text-md leading-[18px]`（`/tight` = 18px）           |
| `text-base/body`                             | `text-base leading-[23px]`（`/body` = 23px）          |
| `h-band`                                     | `h-11`（44）                                          |
| `px-5` `gap-5` and other `-5`                | `-[24px]` (Paper's 5 = 24, not 20)                   |
| `-6`                                         | `-[32px]` (Paper's 6 = 32)                           |
| `leading-5` `leading-6` `w-6`                | Same as above: Paper's spacing tokens (24, 32, 32)   |
| `bg-foreground/scrim`                        | `bg-scrim`                                            |
| `[color:var(--color-primary-foreground)]`    | `text-primary-foreground`                             |
| `border-t border-t-solid border-t-border`    | `border-t border-border`                              |
| `flex` (horizontal)                          | `flex-row` (nsh defaults to vertical)                |
| `flex flex-col`                              | Omit (default)                                       |
| `grow basis-[0%]`                            | `grow basis-0`                                        |
| `font-sans` `antialiased` `inline-block`     | Omit                                                 |
| Status bar frame, Home indicator frame       | Don't draw: `Page` already leaves the safe area      |
| `<svg>` Phosphor icons                       | `<Icon name=…>`, add missing paths to `src/ui/icons.ts` |
| Avatar `<svg viewBox="0 0 100 100">`         | `<AgentAvatar id={agent.id} size={20} />`            |

## Conventions

- Data only flows through the wire, same as Web: `useTarget` (subscribe) in `src/wire/target.ts`, `eager` (carried by `hello`),
  `call` (`target.action`). The list is in `src/app/lists.ts`. Types come from `@eta/client-contracts`,
  **Before starting, read `docs/architecture/` and the implementation of the same feature in `apps/web/src`**: keep semantics identical to Web, don't invent ops.
- All copy goes through `t("feature.key")`, with Chinese and English written as a pair in `src/features/<feature>/i18n.ts`.
- Use only theme colors (`theme.json`): `text-foreground`, `text-muted-foreground`, `text-faint`, `bg-muted`,
  `bg-surface`, `border-border`, `border-border-strong`, `bg-primary`, `text-state-error`…, dark mode switches automatically.
- Square corners. Motion is direct, no trailing. List rows need press feedback (`active:bg-muted` or `active:opacity-60`).
- Components live in `src/ui/`: `Page` `Header` `SectionLabel` `Body` `Button` `Segmented` `Sheet` `ConfirmSheet`
  `Empty` `Loading` `Failed` `Icon` `AgentAvatar` `toast`; time formatting is in `ui/format.ts`. Reuse first; anything shareable goes in `src/ui/`.
- Navigate between pages with `go.*` from `src/nav/links.tsx`; pages inside a feature use `open(key, page)` from `nav/stack.ts`.
- On failure use `toast(t("common.failed", { message: reason(error) }))`; hide the entry for plugins the host hasn't mounted (`wire().isMounted`).
- nsh reactivity: component functions run only once; use `signal`/`computed`, read `x()` in JSX; for lists use `<Each of=…>{(item) => …item()…}</Each>`
  or `<List>`, conditionals with `<If when=… else=…>`. Destructuring props loses reactivity, so don't destructure.
- Docs: `https://nsh.dev/docs/<page>.md`; type declarations are in `.nsh/types/nsh/`. Truncate text with class `truncate` / `line-clamp-2`.
  Don't use Tailwind font sizes that aren't in `nsh.json`; also clear the class-name check warnings.

## Fake host

`src/testing/fake-host.ts` speaks the same frames in the app's own VM: `DevApp.tsx` uses it to run in the simulator and under `nsh test`, no network needed.
Data and ops live in `src/testing/fixtures/<feature>.ts`; use the data from the design (Ache, Mori, Xiaoman, #128…).
Types are constrained by contracts; ops must answer the same way as `apps/eta`. `host.scenario` (storage's `eta.fake.scenario`) switches variants,
`eta.fake.route` (e.g. `group:wire`, `artifact:reconnect`) opens DevApp straight onto a page. The entry file must be in the app root, otherwise the theme won't load.

Tests go in `src/features/<feature>/*.test.tsx`:

```tsx
import { expect, open, test } from "nsh/test";

test("answering a question", async () => {
  const app = await open("../../../DevApp.tsx");
  await app.press("back up first, then run");
  expect(app.texts()).not.toContain("Should the migration script run directly on the production database?");
});
```

## Commands

```sh
nsh check                 # type check
nsh test                  # headless tests
nsh test <file> --target ios   # drive the UI in the simulator, screenshot with app.screenshot; set BINDGEN_EXTRA_CLANG_ARGS first, see docs/architecture/mobile.md
scripts/package-ios.sh simulator   # release build (real host), with camera and http exceptions
xcrun simctl io booted screenshot /tmp/x.png   # full-screen screenshot including the keyboard; app.screenshot can't capture the keyboard
```
