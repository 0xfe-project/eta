# Computer Use

Computer Use lets agents operate web browsers and Windows desktop applications inside **isolated execution realms** without touching the user's physical mouse cursor, stealing foreground window focus, popping up blocking native OS file dialogs, or sharing the host OS clipboard.

The implementation spans `packages/client-contracts/src/computer.ts` (wire types and coordinate geometry), `packages/eta-computer` (realm manager, browser CDP pipe, Windows child session and hidden desktop drivers, silent file broker, virtual clipboard, and Agent Plugin / MCP bridge), `apps/daemon/src/computer.ts` (remote machine realm bridge), `apps/eta/src/computer/` (host service, session tools, remote mirror, and `/ws` plugin), and `apps/web/src/components/workspace/computer/` (`<ComputerStrip />`, `<ComputerPanel />`, and `<ComputerViewport />`).

## Isolated realm backends

Every Computer Use session operates on a `ManagedRealm` (`packages/eta-computer/src/manager.ts`) backed by a `RealmDriver`:

| Kind      | Tier             | Driver                  | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser` | `cdp`            | `BrowserRealmDriver`    | Headless Chromium, talked to over CDP. On runtimes that can hand a child descriptors 3 and 4 (Node), `--remote-debugging-pipe` with `\0`-framed JSON-RPC via `CdpPipeConnection` and **zero TCP ports**. On Bun (eta's host runtime) those descriptors never reach the browser, so `CdpSocketConnection` is used instead: `--remote-debugging-port=0 --remote-debugging-address=127.0.0.1` and the ephemeral loopback port the browser writes to `DevToolsActivePort`, living only as long as that realm's browser. `transport: "pipe" \| "socket" \| "auto"` selects, and `transport.transportKind` reports what was chosen. |
| `app`     | `child_session`  | `WindowsAppRealmDriver` | **Tier A** (Windows Pro / Enterprise / Server with ` ChildSessions` enabled): isolated Windows Child Session via RDP loopback (`ConnectToChildSession=true`) with full GPU/DWM composition and its own cursor and input queue.                                                                                                                                                                                                                                                                                                                                                                                                |
| `app`     | `hidden_desktop` | `WindowsAppRealmDriver` | **Tier B** (universal Windows fallback, including Windows Home): isolated Win32 desktop (`CreateDesktopW("eta_cu_<id>")` + `CreateProcessW` with `STARTUPINFOW.lpDesktop`), captured via `PrintWindow(PW_RENDERFULLCONTENT)` and driven cleanly.                                                                                                                                                                                                                                                                                                                                                                              |

### Zero main-desktop contention and VirtualClipboard

- **Zero host cursor or focus contention**: `BrowserRealmDriver` dispatches `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent` over the CDP pipe. `HiddenDesktopDriver` posts window messages (`WM_MOUSEMOVE`, `WM_LBUTTONDOWN/UP`, `WM_MOUSEWHEEL`, `WM_CHAR`, `WM_KEYDOWN/UP`) directly to target `HWND`s on the hidden desktop and never calls `SwitchDesktop` or global `SendInput`.
- **Clipboard isolation**:
  - In Tier A (`ChildSessionHost`), `enforceChildSessionRdpInvariants` enforces `RedirectClipboard: false` and `ManualClipboardSyncEnabled: true`, throwing `clipboard_sharing_violation` if any caller attempts to enable automatic host clipboard sharing.
  - Every `ManagedRealm` owns an in-memory `VirtualClipboard` (`packages/eta-computer/src/clipboard.ts`, 4 MiB default cap, supporting `text/plain`, `text/html`, and `image/png`). Synthesized `Control+C` / `Meta+C` and `Control+V` / `Meta+V` chords inside the realm read and write only that realm's `VirtualClipboard`.
- **Sensitive process denylist**: `checkProcessTargetAllowed` (`packages/eta-computer/src/windows/probe.ts`) blocks sensitive executables (`1password`, `bitwarden`, `keepass`, `credentialmanager`, `lsass`, `regedit`, `powershell`, `cmd`, `wt`, `ssh-agent`, etc.) before any `app` realm launches.
- **UTF-8 on both pipes**: the hidden-desktop worker (`packages/eta-computer/src/windows/hidden-desktop-worker.ts`) is one long-lived `powershell.exe` speaking JSON lines. Its stdio is redirected, so the console codepage (an OEM one) would decode requests with the wrong table and CJK input would reach the target as mojibake. The script therefore builds an explicit `UTF8Encoding` reader/writer over `OpenStandardInput`/`OpenStandardOutput`, and the host writes the script file with a BOM because Windows PowerShell reads a BOM-less script as ANSI.

## Silent File Picker 3-layer broker

Native OS file dialogs (`comdlg32.dll` / `#32770`) normally block UI automation or pop up on the user's active desktop. Computer Use eliminates main-desktop file dialog popups with a three-layer broker:

1. **Layer 1 — Browser CDP interception (`BrowserRealmDriver`)**:
   - Enables `Page.setInterceptFileChooserDialog({ enabled: true })` and `Browser.setDownloadBehavior({ behavior: "allowAndName", downloadPath })`.
   - When a click triggers `<input type="file">` or `window.showOpenFilePicker()`, Chromium emits `Page.fileChooserOpened` without opening `comdlg32.dll`.
   - If the realm was pre-armed via `computer_stage_files`, `BrowserRealmDriver` immediately injects the authorized paths via `DOM.setFileInputFiles({ files, backendNodeId })` (`status: "intercepted_silent"`). Otherwise the realm transitions to `status: "pending_input"` until resolved via `computer_resolve_picker` or the UI bar.
2. **Layer 2 — Windows UIA `#32770` dialog auto-fill (`UiaDialogWatcher`)**:
   - For desktop apps in Tier A / Tier B, `UiaDialogWatcher` (`packages/eta-computer/src/windows/uia-dialog-watcher.ts`) monitors the realm's process tree inside the isolated desktop/session for modal `#32770` Common Item Dialogs (`Open`, `Save As`).
   - Instead of fragile coordinate clicking, it populates the filename control (`AutomationId = "1148"` / `"FileNameControlHost"` / `ControlType.Edit`) via UIA `ValuePattern.SetValue` and invokes the confirm button (`CommandId = "1"`) via `InvokePattern`, automatically confirming overwrite prompts when configured.
3. **Layer 3 — `FileBrokerPolicy` and `Inbox` approval gate (`packages/eta-computer/src/file-broker.ts`)**:
   - Evaluates canonicalized realpaths (`resolvePath` following symlinks and nearest existing ancestors, rejecting NUL bytes and Windows reserved DOS device names `CON`, `PRN`, `AUX`, `NUL`, `COM1..9`, `LPT1..9`) into three decisions:
     - **`deny`**: Hard-blocks ETA secrets (`~/.eta/secret.key`, `access-token`, `identity.json`, `plugin_config`, `credential`, `.eta/llm/auths`), `~/.ssh`, `~/.gnupg`, and configured `deniedPaths`.
     - **`allow`**: Silently permits paths strictly inside the session's `projectDir`, `worktreeDir`, `uploadsDir`, `stagingDir`, or `allowedDirs`.
     - **`ask`**: Pauses the tool call and routes an approval question (`Allow Computer Use <read|write> access to file(s) outside the workspace: ...?`) through the session's `AskRegistry` / `Inbox` (`apps/eta/src/computer/service.ts`).

## Clean Frame vs. `<ComputerViewport />` Agent Cursor overlay & single-writer lock

### Clean Frame invariant

Screenshots captured by `realm.observe()` (and `Page.captureScreenshot({ fromSurface: true })` / `PrintWindow`) are **100% pure clean frames**:

- No synthetic cursor icon or highlight is ever painted onto the bitmap bytes sent to the vision model, stored in session journals, or broadcast in `frame` events.
- Following the session image rule in [Wire protocol](wire-protocol.md#images-in-sessions), tool result screenshots in `sessions.<id>` transcripts are stripped of inline base64 in snapshots (`data: ""`, `bytes`) and fetched on demand via `sessions.image`.
- Live `frame` events on `computer.<realmId>` are **warm-on-subscribe**: when `<ComputerPanel />` is collapsed or unsubscribed (`watcherCount === 0`), `setWatched(false)` stops background screencasting so `/ws` and daemon links carry zero frame traffic while background actions and file saves continue uninterrupted.

### `<ComputerViewport />` 60ms linear SVG Agent Cursor overlay

When the user expands `<ComputerPanel />`, `<ComputerViewport />` (`apps/web/src/components/workspace/computer/computer-viewport.tsx`) renders two distinct layers:

1. **Bottom layer**: the clean frame `<img>` scaled to the logical `viewport`.
2. **Top layer**: an independent `pointer-events-none` SVG Agent Cursor overlay positioned via normalized `0..1000` `cursor` events (`left: ${x / 10}%`, `top: ${y / 10}%`) with a `60ms linear` CSS transition (`motion-reduce:transition-none`), an agent name badge (`agentName`), and a click ripple ring on `click` / `double_click` / `right_click`.

### Millisecond single-writer takeover lock (`agent | user | paused` + `epoch`)

Each `ManagedRealm` maintains a single-writer controller lock (`controller`: `"agent" | "user" | "paused" | "closed"`) and a monotonically increasing integer `epoch`:

- **`agent` mode**: `realm.act(actions, { expectedEpoch })` executes batches of 1..8 micro-actions. Manual `userInput` calls are rejected.
- **Instant `takeover`**: when the user clicks **Take over** (`computer.<id>.takeover`), `ManagedRealm` increments `epoch`, transitions `controller` to `"user"`, and synchronously calls `AbortController.abort()` on any in-flight `act()` batch. Remaining queued micro-actions are discarded immediately.
- **Manual `user` control**: while `controller === "user"`, `<ComputerViewport />` hides the agent cursor overlay and forwards pointer, wheel, keyboard, and IME composition (`useInputMethod`) events as normalized `0..1000` `computer.<id>.input` calls. Any concurrent `computer_act` call from the agent is rejected immediately.
- **`release` / `resume`**: clicking **Return to Agent** (`computer.<id>.release`) increments `epoch` and restores `controller = "agent"`.

### Bringing a hidden desktop to the front (`promote` / `demote`)

A live window cannot move between desktops — Windows binds a window to the desktop its thread
created it on, and no API relocates one. "Bringing a background app to the front" therefore means
switching **the whole screen** to the desktop the app already runs on: the process, its window and
its state survive, because nothing moved.

- **`computer.<id>.promote`** (`ComputerService.promoteRealm`) does three things in this order:
  1. `takeover` — the human is about to be in front of the keyboard, so the single-writer lock moves
     to `user` and any in-flight `act()` batch is aborted;
  2. start the **in-realm overlay** (`packages/eta-computer/src/windows/desktop-overlay.ts`, its own
     `-STA` PowerShell process created with `STARTUPINFO.lpDesktop` onto the realm desktop) and wait
     for its ready file;
  3. only then `SwitchDesktop(realm_desktop)`.
     If the overlay never comes up, the screen is **not** switched: the user is never left on a desktop
     with no way back. The desktop the user was on is remembered with `OpenInputDesktop` and restored by
     `demote`.
- **The overlay** is the way back that does not depend on the ETA window the user just lost sight of:
  a topmost WinForms panel with _回到我的桌面_, the agent's current status, and a one-line box that
  appends `{"text": "..."}` to a chat file. The host polls that file
  (`ComputerService.#watchOverlay`) and forwards each line to the realm's `conversationId` via
  `sendChat`, so the user can talk to the agent without leaving the desktop. The marker
  `__switch_back__` demotes instead of sending a message.
  There is deliberately no global hotkey: `GetAsyncKeyState` polled from this process reports a key
  as held when it cannot read the key state at all (a desktop that is not yet the input desktop), so
  a `Ctrl+Alt+E` check threw the screen back on its own seconds after it arrived. The button is the
  one escape that cannot misfire.
- **Screen watchdog** (`packages/eta-computer/src/windows/desktop-watchdog.ts`): a separate detached
  `powershell.exe` that watches a heartbeat file the driver touches every 2 s and switches the screen
  back to `Default` once it goes stale (12 s). Verified by killing the host mid-promotion — the screen
  came back on its own. Without it, a host crash would strand the user on a desktop with no shell.
- **`computer.<id>.demote`** switches back, kills the overlay, clears `promoted` and `release`s the
  realm. It also runs from `closeRealm`/`closeAll`, and a 30-minute `MAX_PROMOTED_MS` timer hands the
  screen back even if everybody forgets.
- **Only a hidden-desktop app realm can be promoted.** A browser realm is `--headless=new` and has no
  OS window; a child-session realm is already visible in its own session window. `ManagedRealm.view()`
  reports `promoted` so the panel can flip the button between **提到前台** and **收回后台**.
- **Honest costs**: while promoted the screen is a desktop with no shell (no taskbar, no Start),
  clipboard and input belong to whoever is in front, and the `agent` cannot write to the realm until
  `demote` returns it. It is an explicit, time-boxed "look at it yourself" action, not a live status
  view — the panel's frame stream is that.

### A realm's process is the user's, not the agent's

The app inside a realm is a real program with real, possibly unsaved work. Nothing in ETA may end it
except the person in front of the screen:

- **Closing a realm releases, it does not end.** The worker's `close` command drops the process
  handle and the desktop handle and replies `{ ended: false }`; the app keeps running on its own.
  `computer_close` therefore never destroys anything, and says so in its reply.
- **`terminateApp` is the one way to end it**, and only `closeRealm(…, { endApp: true })` calls it:
  the panel's Close button, after its own confirmation dialog naming the target. An agent has no
  path to it — `dispatchAction` reads `endApp` from the browser, `computer_close` never sets it.
- **Host shutdown leaves apps running too** (`closeAll` only detaches), because quitting ETA is not
  a decision to discard an unsaved scene.
- **A relaunch never closes the window that is already open.** `computer_open` with `args`/`script`
  implies a fresh instance; if one is already open for that target the call fails with
  `"<target>" is already open in realm "<id>"` and the realm is left untouched.
- **A dead app is not a showable desktop.** `promote` checks `IsWindow` first and replies
  `window_gone`; the service then closes that realm so the panel collapses to its closed row instead
  of offering a screen with nothing on it.

### Coming back to a screen the host no longer knows about

Because apps outlive realms, a host restart, a crash, or a page reload would otherwise strand a
running window on a desktop nobody can reach again. Two things prevent that:

- **`screens.json` in the data directory** records `realmId`, `desktopName`, `target`, `title`,
  `viewport` and the realm's conversation/agent/session owners whenever a realm is registered.
  `ComputerService.restoreScreens()` (called from `product.ts` at construction) re-registers each one
  through the driver's `attachTo` instead of launching: the worker opens the existing desktop, adopts
  the app's real window (`LargestWindow` skips invisible, already-titled-missing and helper windows
  such as `__wgLDummyWindowFodder`), and no new process is started. Restore also calls
  `ComputerService.refresh()` so the `computer` section — already published once with `eager: true`
  before the restore finished — is pushed again, which is what makes the realm appear in the UI.
- **`<ActiveRealmsBar />` lists realms from other conversations too**, after the current
  conversation's ones and marked with a dashed border plus a tooltip. A restored realm usually
  belongs to the conversation it was opened from, while the page may be showing a different one;
  hiding it there would be the same dead end in a different disguise.

Attaching is not relaunching: if the desktop or the app is gone, the record is dropped silently, and
if the app is dead the recreate path is a normal `computer_open` — nothing is ever killed.

## BYOK model capability gate & optional `groundingModel` routing

- **Vision capability gate (`checkModelSupportsVision`)**: Before opening or observing a realm, `ComputerService` checks whether the session's model (or configured `groundingModel`) declares `"image"` in `model.input`. Text-only models fail fast with a structured `computer_model_lacks_vision` diagnostic naming multimodal alternatives.
- **GroundCascade selective zoom (`crop`)**: `computer_observe` accepts `crop: { x, y, width, height, unit }` (default `0..1000` normalized) to capture a high-resolution crop of dense UI regions. Passing the same `crop` to `computer_act` maps crop-local coordinates back to full-viewport pixels via `toViewportPixels`.
- **Fast/slow `groundingModel` routing**: Users can optionally configure a dedicated fast vision grounder via `computer.setGroundingModel`. When `computer_observe` is called with `locate: "<element description>"`, `ComputerService.locateWithGrounder` streams the cropped or full screenshot to `groundingModel` via `KernelModels`, parses the returned `0..1000` coordinate (`parseGroundedCoordinate`), maps it to both crop-local and full-viewport normalized coordinates, and forwards the `AssistantMessage` to `onGenerated` so every grounding token and cost is recorded in the session's `usage` table.

## Built-in Skill & Agent Plugins 1.0.0 / MCP bridge

`packages/eta-computer/src/skill-bridge.ts` packages the Computer Use workflow for both the built-in kernel and external runtimes (Claude Code, Codex, OpenCode):

- `COMPUTER_USE_SKILL_MD`: valid Agent Skills `SKILL.md` (`name: computer-use`) teaching the **Observe -> Act -> Verify** loop, **GroundCascade Selective Zoom (`crop`)**, **Silent File Picker Discipline** (`computer_stage_files` / `computer_resolve_picker`), and **Objective Completion Judge**.
- `createComputerMcpToolDefinitions()` and `handleComputerMcpToolCall(manager, name, args, options)`: expose the exact same 7 tools (`computer_open`, `computer_observe`, `computer_act`, `computer_stage_files`, `computer_resolve_picker`, `computer_clipboard`, `computer_close`) over an MCP tool handler backed by `RealmManager`.
- `writeComputerPluginBundle(targetDir)`: materializes a spec-valid [Agent Plugins 1.0.0](plugins.md) directory (`plugin.json` and `skills/computer-use/SKILL.md`) that passes `loadPlugin` validation with zero reports.

## Design plan

The plan this implementation follows — the problem statement, the four hard problems (zero-contention
realms, silent file pickers, overlay and Agent cursor, BYOK model routing), the T1–T12 work breakdown and
its acceptance gates — is [computer-use-plan.md](computer-use-plan.md).
