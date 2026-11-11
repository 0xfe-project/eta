# Web

Vite + React + React Compiler. The UI reads and writes only through one host WebSocket (`/ws`); there is no REST and no generated API client. Run the development command from the repository root with `bun run dev` (host and vite start together); in production, the host directly serves the build output with `--web-dir` (`bun run --cwd apps/web build` → `dist/`, whose `BUILD` file is the content of `/version`).

## Configured libraries

| Purpose        | Library                                           | Configuration entry                                                                               |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Icons          | `@phosphor-icons/react`                           | `src/components/providers.tsx`, default 20px / regular                                             |
| Agent avatar   | `blobatar` + `@blobatar/react`                    | `AgentAvatar` (`agent-identity.tsx`), generated from id; animation requires importing `blobatar/motion.css` in `styles.css` |
| Routing        | `@tanstack/react-router`                          | `src/router.tsx` + `src/routes/`                                                                  |
| Server state   | `@tanstack/react-query` + own wire store          | `src/lib/query-client.ts`, `src/lib/wire.ts`, `src/queries/`                                      |
| URL state      | `nuqs`                                            | Root component adapter                                                                            |
| Forms and validation | `react-hook-form` + `@hookform/resolvers` + `zod` | `src/components/workspace/agent-editor.tsx`                                                       |
| Notifications  | `sonner`                                          | Mount `Toaster` in the root component; call `toast.success()` in business code                     |
| Markdown       | `streamdown` + `@streamdown/cjk`                  | `src/components/markdown.tsx`                                                                     |
| Styles         | Tailwind CSS v4                                   | `vite.config.ts` + `src/styles.css`                                                               |
| React Compiler | `babel-plugin-react-compiler`                     | `reactCompilerPreset` in `vite.config.ts`                                                         |

`@/` points to `src/` in both TypeScript and Vite.

## Data layer

`src/lib/wire.ts` is the page's only connection: it speaks the wire protocol from `@eta/client-wire-proto`, handles `hello`, `reply`, `state`, and `event`, reconnects with increasing intervals after disconnection, resubscribes to targets still in use on reconnect, and calls that get no reply end with an error. Connection state and each target's section / revision live in a zustand store. Types come from `@eta/client-contracts`. See [Wire protocol and target](../../docs/architecture/wire-protocol.md) for the protocol.

`src/queries/wire.ts` wires it into hooks (`useTarget`, `useConnectionLost`, and a mutation for calls); one `src/queries/<target>.ts` per target (agents, machines, projects, conversations, sessions, providers, inbox, tasks, artifacts, routines, memory, usage, personas), with signatures close to react-query conventions. Reads are host-pushed state; no polling.

For plugins not present in `hello.mounted`, hide the corresponding entry point instead of erroring (e.g. the memory page when there is no memory sidecar; see `queries/memory.ts`).

During development, vite only proxies `/ws` (target `ETA_HOST_ORIGIN`, default `http://127.0.0.1:8787`); the browser sends vite's origin, so the host allows it with `--allow-origin` (the root `dev` script already does this). `/up` and `/version` are answered by the server serving the page: vite in development and the host in production; based on this, the page (`src/lib/update.ts`) indicates "a new version is available".

## Internationalization

Uses `react-i18next`; Simplified Chinese and English resources are organized by feature under `src/locales/zh/<namespace>.json` and `en/<namespace>.json`, registered by `resources.ts`, with 14 namespaces in total (common, agents, artifacts, chat, machines, connections, memory, navigation, overview, providers, routines, settings, tasks, validation). Shared buttons, time, and common labels go in common; each feature maintains its own resources.

All UI text, accessibility labels, notifications, and validation messages are read from resources; user content, product names, code, and commands remain as-is. Keys use stable English semantic paths, such as `tasks:status.todo`; Chinese keys or whole-sentence copy keys are forbidden. Interpolation parameters are named by meaning; English quantity copy maintains `_one` / `_other`.

By default, Chinese or English is selected based on `navigator.languages`; Chinese locale variants all use Simplified Chinese, and other languages fall back to English. Settings → Appearance → Language can be set to Follow system, Chinese, or English, and is saved in `eta.language.v1`, switching instantly and syncing across tabs. React components explicitly declare namespaces, such as `useTranslation(["tasks", "common"] as const)`; outside components, `translate("tasks:status.todo")` from `src/lib/i18n.ts` reads the language at call time. `src/@types/i18next.d.ts` derives key types from the English resources, so misspelled keys or namespaces fail type checking. `i18n.test.ts` checks namespace/key consistency, English semantic keys, interpolation variables, and source call coverage.

## Query

`getRouter()` creates an independent QueryClient for each router instance (tests and the app do not share the cache), with a default stale time of 30 seconds, one retry on failure, and no retry for mutations.

## Loading, Empty, and Error States

`src/components/states.tsx` provides the three states shared across the app; do not hand-write 「Loading…」 or a single-line empty prompt again:

- `Loading`: gray skeleton, shaped like the content about to appear (`list`, `detail`, `lines`); fades in after a 300ms delay, so fast requests do not flash.
- `Empty`: centered icon + a line saying 「Nothing yet…」 + what will go here + a start button. Also use it when filtering or searching yields no results, swapping the button for clear filters.
- `LoadError`: same layout, 「Unable to load…」 + error message + retry.

## Forms, Notifications, and Markdown

The agent editor uses `useForm` + `zodResolver` to validate fields, shows errors below the fields, and reports results with a toast. `Markdown` supports GFM tables, lists, and code blocks, does not render raw HTML, filters unsafe URLs, and opens links in new tabs; text being streamed in chat uses `streaming` mode, and everything else uses static mode.

## shadcn and Design Conventions

`components.json` uses `radix-lyra`, the neutral color scheme, and Phosphor icons; component source is in `src/components/ui/`. To add components later, run `bunx shadcn@latest add <component>` in `apps/web`; reapplying the preset may overwrite `src/styles.css`, so the following project rules must be preserved:

- Fonts are locally bundled Geist Variable / Geist Mono Variable.
- `--radius` and all Tailwind radius tokens are `0px`; global styles force `border-radius` to 0 for elements and pseudo-elements.
- Components use semantic tokens such as `bg-background` and `text-foreground`, not hard-coded colors for a single theme.
- `ThemeProvider` follows the system by default; it can be switched in Settings → Appearance.

See [AGENTS.md](AGENTS.md) and the root [DESIGN.md](../../DESIGN.md) for UI conventions. All single-select controls use `select-field.tsx` to compose the official Select (do not use native select).

## Pages and Routing

File routes live in `src/routes/`.

- `/`: workbench. Sidebar project → conversation → members (if there is more than one machine, group by machine first), with the agent library at the bottom; the main area is the conversation, and the header has a lead chip.
- `/new`: new conversation, selecting project and agent; `?project=<id>` preselects the project.
- `/workspace`: full-window app shell (`app-shell.tsx`), below which are `/workspace/tasks`, `/workspace/routines`, `/workspace/inbox`, `/workspace/memory` (only when there is a memory sidecar), and `/workspace/more` (the entry page on phones).
- Settings is a modal shared by the home page and `/workspace`, with sections: agents, model providers, approvals, machines, archived, appearance. `?settings=<section>` opens the corresponding section once on any page, then removes it from the URL.
- Tasks page: list (grouped by status) or board, `?task=<id>` opens and `?task=new` creates; routine page parameters are `routine`, `run`, and `edit`; the pending page is grouped by day, and `?filter=pending` shows only pending items. Sections and the sidebar share the same URL parameters (`task-nav.ts`, `routine-nav.ts`, `workspace-search.ts`), all supporting direct access, refresh, and browser history.

The entire app has only one keyboard shortcut: ⌘, (Ctrl+, on Windows / Linux) opens Settings, implemented by a single `window` listener mounted by the root component (`src/lib/settings-shortcut.ts`), so it works on any page and regardless of focus—it also opens when focus is in an input (⌘ plus comma is not a printable character), but yields during IME composition. On wide windows it opens the Settings modal; on phones there is no modal semantics, so go to the `/settings` page and close the covering layer. A registry is only needed when adding a second shortcut; there is only one now.

`localStorage` only stores things belonging to this browser, all validated with Zod: `eta.workspace.v1` is UI state (layout, font, last-used model, task page filters, etc.), `eta.groups.v1` is drafts and undelivered messages, and `eta.language.v1` is the language.

## React Grab (Element Picker)

`react-grab` is dynamically loaded by `src/lib/element-picker.ts`: enabled only in development builds by default, and `reactGrab` in workspace state can override that. Hover over a page element and press ⌘C (Ctrl+C on Windows/Linux) to copy the element, component, and source location information. Production builds include source maps, so element picking in production bundles can also map back to source.

## Verification

```sh
bun run --cwd apps/web build
bun run --cwd apps/web typecheck
bun run --cwd apps/web test
```

`typecheck` depends on `build` first generating `src/routeTree.gen.ts`（not committed）; `bun run check` at the repo root runs them in this order via turbo.
