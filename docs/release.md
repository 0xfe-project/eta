# Release

The host and the desktop app are released separately, each with its own version number:

| tag          | Workflow                                | What ships                                          |
| ------------ | --------------------------------------- | --------------------------------------------------- |
| `v*`         | `.github/workflows/release.yml`         | `eta-host`, one file each for Linux, macOS, Windows |
| `desktop-v*` | `.github/workflows/release-desktop.yml` | Desktop app installers, see "Desktop app" below     |

GitHub's Latest is always the host: desktop releases are published with `--latest=false`. `eta-host upgrade` and the settings page button also don't look at who Latest is, they only take `v*` tags (`apps/eta/src/upgrade/releases.ts`), so even if a desktop Release is manually marked Latest, the host still picks up the newest host.

## Tagging

Tag the commit you want to release, usually the latest one on `main`:

```sh
git fetch origin
git tag v0.2.0 origin/main
git push origin v0.2.0
```

- The version is the tag minus the `v`. Both the host and the daemon it ships are this version; `version` in `package.json` plays no part.
- This section and the ones below are all about the host. For the desktop app, tag `desktop-v*`; see "Desktop app".
- A `-` makes it a prerelease, e.g. `v0.2.0-rc.1`; the Release is marked Pre-release and doesn't count as the latest version.
- The tag must be `vX.Y.Z` or `vX.Y.Z-suffix`; any other form won't publish.

Pipeline order:

1. `prepare`: read the version from the tag, open a draft Release.
2. `check`: runs alongside the build, the full `bun run check`, not `--affected`. If it fails nothing is published and the draft stays.
3. `build`: each platform on its own runner, clean checkout, frozen lockfile build. The host is run separately once to check `--version`, `/up` and the page, and only then uploaded to the draft. The Linux one also writes `eta-host.json` (`eta-host --version --json`) and uploads it too.
4. `cross`: `upgrade-cross.yml` upgrades from the previous stable release to this draft on Linux, see "Cross-version upgrade test" below. With no previous release, or if the previous one is older than the earliest seed (e.g. v0.1.0, which cannot self-upgrade), it is skipped and noted in the run summary.
5. `publish`: only runs if everything before it succeeded, computes `SHA256SUMS` from the draft, then publishes. If any step fails the Release stays a draft and users cannot see it.

The desktop app is no longer built and WebKit and Xvfb are no longer installed, so host releases are no longer slowed down by the Ubuntu image.

On failure, first check whether it is a known flaky test (`gh run rerun <id> --failed`). When one platform fails the others run to completion, and `--failed` reruns only the failed one. A draft can be rerun and its files are overwritten. Once a Release is published it never changes again: rerunning errors out, and to replace files you push a new tag.

If the run for the tag never happened or was lost, you can run it manually; `--ref` must be the tag:

```sh
gh workflow run release.yml --ref v0.2.0
```

## Artifacts

Releases for `v*`:

| File                       | Platform    | What it is                                                                    |
| -------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `eta-host-linux-x64`       | Linux x64   | host                                                                          |
| `eta-host-darwin-arm64`    | macOS arm64 | host                                                                          |
| `eta-host-windows-x64.exe` | Windows x64 | host                                                                          |
| `eta-host.json`            |             | `{"version","commit","minDesktop"}`, see "Desktop app and host compatibility" |
| `SHA256SUMS`               |             | Checksums of everything above                                                 |

The host is a single uncompressed file containing the pages, database migrations, CLIProxyAPI and the daemons for every platform. It is uncompressed because zstd would save only about a third (the daemons inside are already compressed) while requiring the downloading machine to have zstd, and the checksum would no longer cover the file that actually runs.

Build the same file locally with `bun run --cwd apps/web build && bun apps/eta/scripts/build-host.ts`; the artifact is in `apps/eta/out/host/`.

The CLIProxyAPI bundled in the host depends on the machine that builds it, so each platform must be built on its own runner. Adding a platform means adding a row to the `build` matrix; verify that the platform compiles first. There is no `darwin-x64` and no Windows daemon (it is not in the platform table in `apps/daemon/scripts/build.ts`).

## Desktop app

```sh
git tag desktop-v0.2.0 origin/main
git push origin desktop-v0.2.0
```

- The version is the tag with `desktop-v` stripped, passed via `ETA_DESKTOP_VERSION` to `electrobun.config.ts`, written into `Resources/version.json` in the bundle, and read by the app at runtime (`apps/desktop/src/version.ts`). Local packaging has no such variable, so it takes `version` from `apps/desktop/package.json`. Nowhere else in the source hardcodes the version.
- A `-` makes it a prerelease. Tags must be `desktop-vX.Y.Z` or `desktop-vX.Y.Z-suffix`.
- Both drafts and releases pass `--latest=false` and do not take the repository's Latest.

Pipeline: `prepare` opens the draft; `check` runs the full `bun run check` like the host; `build` packages each platform, installs it and launches it once (`apps/desktop/scripts/try-app.ts`); on Linux, if WebKit is not installed within 8 minutes the launch is skipped and a warning is left; `publish` computes `SHA256SUMS` and publishes. There is no cross-version upgrade test, that belongs to the host.

The installer does not contain the host. The launch step picks "Run on this computer", and the app downloads the newest host it can run from the same repository (using the workflow token), so **before publishing a desktop release, the repository must already have a host Release with `eta-host.json`**, otherwise this step fails.

### The first time "Run on this computer" is picked

The app downloads only when there is no host in `~/.eta/desktop/host/`; picking "Connect to an existing host" downloads nothing at all (`apps/desktop/src/bun/download.ts`):

1. First check `~/.eta/running-host.json`: if a host is already serving `~/.eta`, open it directly with no download. Older versions that do not write this file are not recognized here; after downloading, `eta-host running` will recognize it and still will not start a second one.
2. Find the newest stable host Release in the repository baked into the app at build time (`ETA_HOST_UPSTREAM`, the same as the host's; `ETA_RELEASES_URL` can override it), read its `eta-host.json`, and if `minDesktop` is newer than the app look at the previous one, up to 10. Older versions without `eta-host.json` are not given to the app.
3. Download to `~/.eta/desktop/host/eta-host.<pid>.download` (on Windows `eta-host.<pid>.download.exe`: Bun inside the app only runs `.exe` on Windows), and the window shows the shell's own progress page; verify against `SHA256SUMS`, run `--version` once to confirm the version, and only then rename it to `eta-host`. If any step fails the file is deleted and the next attempt downloads from scratch; a partial file is never treated as the host.
4. From then on it always starts from there, and upgrades with the button on the settings page (see "The host in the desktop app").

The token order is the same as for host upgrades: `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token --hostname github.com` (`gh` located using the login shell's `PATH`), and anonymous if none is available; the app has no settings page for saving a token. The failure page distinguishes causes: cannot connect, download interrupted, checksum mismatch, private repository without a token (and what to set), server refused, no usable version, the downloaded file will not run, the disk cannot be written. Each has "Retry" and "Switch connection method" (you can change to connect to a remote host).

The download logic is the same code as host upgrades (`packages/releases`: `hostForDesktop`, `hostFile`, `downloadChecked`), not a copy.

| File                           | Platform    | What it is                                    |
| ------------------------------ | ----------- | --------------------------------------------- |
| `eta-desktop-linux-x64.tar.gz` | Linux x64   | Desktop app, contains `installer`             |
| `eta-desktop-darwin-arm64.dmg` | macOS arm64 | Desktop application                           |
| `eta-desktop-windows-x64.zip`  | Windows x64 | Desktop application, contains `eta-Setup.exe` |
| `SHA256SUMS`                   |             | Checksums for all of the above                |

hutch only packages for the host machine it runs on, so each platform is built on its corresponding runner.

### Desktop application's own updates

Uses Electrobun's built-in Updater (`apps/desktop/src/bun/update.ts`), only acts when the user clicks a button: Settings → Update's "Desktop" section shows the app version, click "Check for updates" to check, click "Download" if there's a new version, then click "Restart and update" after download. No scheduled checks, doesn't check on startup, and won't install itself.

- **Update URL** is the build-time `ETA_DESKTOP_UPDATE_URL` (`release-desktop.yml` reads the repository variable `vars.ETA_DESKTOP_UPDATE_URL`), written into the package's `version.json` as `baseUrl`. If not set, this section doesn't exist and no patches are generated. **The official URL hasn't been finalized yet.**
- This URL must be **anonymously** readable: Updater sends GETs without credentials, so private repository Releases won't work. The files to place are the three from that build's `artifacts/`, names cannot be changed: `stable-<os>-<arch>-update.json`, `stable-<os>-<arch>-eta.tar.zst`, and the patch relative to the previous version `stable-<os>-<arch>-<previous hash>.patch`. When the URL is set, `release-desktop.yml` uploads them all to the Release, just copy them to that URL.
- Check reads `update.json`, if the hash differs from the local one there's an update; add one more rule here: the version number must be newer than the current one, won't "update" to an older version.
- Download first follows the patch chain (patches are only generated if the previous version can be fetched from the update URL at build time), if unavailable downloads the full `.tar.zst`. Updater verifies the extracted hash itself.
- When updating the app, Updater exits the app, a helper program replaces the entire app directory then launches the new version. In local mode, host is a child process of the app, so stop host first, then hand over to Updater; if handover fails (e.g., helper program fails to start), restart host, old version continues to work, settings page explains the reason. Confirmation dialog lists work that will be interrupted by restart (the list from host's `upgrade.check`). When connected to remote host, only says host is not affected.
- On Linux, helper program first copies to temp directory (`/tmp`) then runs, will fail on machines where `/tmp` is mounted as `noexec` (`EACCES`, tested), old version not affected.

### Desktop application and host compatibility

Both upgrade independently: host uses settings page button or `eta-host upgrade`, desktop app reinstall. App doesn't include host, downloads when first used. Pages in the window are provided by host, so pages may be newer or older than the app; even more so when connected to remote host. Conventions in `packages/client-contracts/src/desktop.ts`:

- **Native bridge only adds, never changes.** App lists what it can do via `window.__ETA_HOST__.capabilities` (`open-external`, `save-file`, `context-menu`, `window-action`, `connection`, will only add more). Once a name is released, meaning and response don't change; to change, use a new name. Apps without this list are 0.1.0, calculated by `BASELINE_CAPABILITIES`.
- **Pages judge by capability, not by version.** Before calling use `hasCapability(<name>)` (`apps/web/src/lib/native.ts`); if no such capability, don't show corresponding entry, nothing in browser.
- **When really need to break compatibility, raise `MIN_DESKTOP`.** When page finds app version is lower than it, prompts to update desktop at bottom of window. `dev` builds and apps that can't tell version don't prompt. This is the only place that compares versions, should rarely be used. Each host Release's `eta-host.json` carries `minDesktop`, app can know if it can run it without downloading host.

## Upgrade testing

There are two workflows, both reuse `scripts/upgrade-e2e/`, both can only prove what can be tested on runner: auto-start after restart and real logged-in user credentials must be tested on real machine.

- `upgrade-e2e.yml`: on real macOS and Windows runners, using fake Release server (`fake-releases.ts`) upgrade between several variants of this build, covers success, various failure fallbacks and uninstall, about 15 minutes. Only runs on PRs that change service or upgrade-related code, not a release gate.
- `upgrade-cross.yml`: upgrade between two real versions.

### Cross-version upgrade testing

A tag's pipeline only runs once on Linux, results in a few minutes, doesn't release if fails. macOS and Windows runners in private repository count minutes at 10x and 2x, so not a gate for every tag, run manually when needed:

```sh
gh workflow run upgrade-cross.yml --ref v0.2.1 -f platforms=all
gh workflow run upgrade-cross.yml --ref main -f from=0.2.0 -f to=0.2.1 -f platforms=windows
```

`to` defaults to the tag being run, `from` defaults to the highest release version smaller than it.

It downloads real files for both versions, installs `from` as a service, puts in seed data, then:

1. Use `eta-host upgrade` to upgrade to `to`.
2. Start over, upgrade to `to` using the same interface called by the settings page button.
3. Start over, upgrade to a broken build (`bad-host.ts`, will destroy data, exits after responding to `/up`), see `from`'s worker put files and database back.

After each time verify: file version, service running, `/up`, page can open, seed count and content, migration records, encrypted values can be decrypted, session can open, then send a message and get a reply.

### Seed data

`test/upgrade-seed/<version>/` is a data directory (`data/`) actually left behind by a host of that version, plus the content to verify against later (`manifest.json`). Everything in it is fake data, and `data/secret.key` can only decrypt those fake values. The test picks the newest one no higher than `from`, and `from` migrates it up itself.

For versions where the schema or storage format changed, add a seed. Do it in an isolated environment; the script wipes `/tmp/eta-seed-home`:

```sh
gh release download v0.3.0 --repo <owner>/<name> --pattern eta-host-linux-x64
chmod +x eta-host-linux-x64
bun scripts/upgrade-e2e/seed.ts ./eta-host-linux-x64 0.3.0
docker run --rm -v "$PWD:/repo:ro" zricethezav/gitleaks detect --source /repo/test/upgrade-seed --no-git
```

The script starts a host with this version's binary, HOME at `/tmp/eta-seed-home`, model `fake-model.ts`, then calls over the wire like the pages do: create agents, projects, conversations, send messages, have the model publish two versions of an artifact, create tasks and run them to completion, store email accounts and plugin config, register host machines, create routine tasks, change settings. After the host exits, copy the data directory over and generate `manifest.json`, then verify once more. Don't hand-write SQL, don't put in real data, and the hostname must be fake (generated in a container with `--hostname eta-seed`).

## No signatures

None of these files are signed or notarized. Desktop app updates are triggered by the user in settings (see "The desktop app's own updates"), and builds without a configured update URL can only be re-downloaded and reinstalled. macOS and Windows both block them on first open; once allowed, they work normally.

On macOS, drag eta from the DMG into Applications, then remove the quarantine flag from the download, otherwise the system will say the app is damaged:

```sh
xattr -dr com.apple.quarantine /Applications/eta.app
```

Do the same for the downloaded host: `xattr -d com.apple.quarantine eta-host-darwin-arm64`.

On Windows, unzip and run `eta-Setup.exe`. When SmartScreen says "Windows protected your PC", click "More info", then "Run anyway".

## Download and run

The repo is private, so downloading needs a token with permission; a logged-in `gh` is enough:

```sh
gh release download v0.2.0 --repo 0xfe-project/eta --pattern 'eta-*' --pattern SHA256SUMS
sha256sum -c SHA256SUMS
```

To download only one platform, put the exact filename in `--pattern` and add `--ignore-missing` when verifying. macOS has no `sha256sum`; use `shasum -a 256 -c SHA256SUMS --ignore-missing`. On Windows use PowerShell's `Get-FileHash <file>` and compare against that line in `SHA256SUMS`.

Then:

```sh
chmod +x eta-host-linux-x64
./eta-host-linux-x64 --version
```

`--version` outputs `eta-host 0.2.0 (37d8188c1234)`; the parentheses hold the commit.

Running it and installing it as a service work the same as a build from a checkout; see "Running in production" in the README.

## Install as a service

`eta-host install-service <args>` registers this file as a service, starting at boot or login, and restarting on crash. Running it again changes the args and restarts. `eta-host uninstall-service` removes the service; data stays in `~/.eta`.

| Platform | What it is                      | When it starts                | Permissions needed |
| -------- | ------------------------------- | ----------------------------- | ------------------ |
| Linux    | systemd user unit `io.eta.host` | at login, at boot with linger | none               |
| macOS    | LaunchAgent `io.eta.host`       | at login                      | none               |
| Windows  | Windows service `io.eta.host`   | at boot                       | admin to install   |

### Windows service

Run in an **administrator terminal** (search Terminal in the Start menu, right-click "Run as administrator"):

```powershell
.\eta-host.exe install-service --port 8787
```

Put the file in a directory you can write to, e.g. `%LOCALAPPDATA%\eta`, not `Program Files`: upgrades replace the files next to it, and the host itself has no admin privileges.

The service runs as **the account that ran this command**. Agents under the host need to read this user's Claude, Codex and `gh` login state and `~/.eta`; LocalSystem can't read them, and running agents as SYSTEM is too dangerous. So installation asks for the Windows password once:

- The password is read from the console without echo and handed to Windows via `CreateServiceW` to store; it never reaches the command line, logs, or files on disk. From a script, pass one line on stdin.
- This account gets the "Log on as a service" right. It's revoked on uninstall; rights the account already had are left alone.
- This account can start and stop these two services without admin, so `eta-host upgrade` and the button in settings need no admin rights.
- **If the account is an administrator, the host and agents carry full admin rights**, with no UAC prompt: UAC only splits interactive logon, and a service gets the full token. That's more privilege than user services get on Linux and macOS. A restricted token doesn't solve it: in session 0 a restricted token can't start console programs (`0xC0000142`), and the host needs to start git, gh and agents. If that bothers you, install the service under a regular account (not in the Administrators group).
- After changing your Windows password the service can't log in. Run `uninstall-service` then `install-service`.
- On machines signed in with a Microsoft account, enter the Microsoft account password, not the PIN.

The Windows service must respond to the system's service control. This part calls `advapi32.dll` directly via `bun:ffi` (`apps/daemon/src/windows-api.ts`); there is no other binary, still just one file. Windows runs `eta-host.exe service-run` (`windows-shell.ts`), which does only three things: start `eta-host.exe <arguments>`; translate “stop” into the host's graceful stop, force-killing only if it has not finished after 90 seconds; restart 10 seconds after the host crashes. The host and all processes it starts are in one job object, so subprocesses such as CLIProxyAPI are not left behind.

The host is a child process rather than being inside the service process because Windows' own crash restart cannot be canceled and might land exactly while a rollback is restoring the database; the service has no stdout, so crash output would be lost; and when the host hangs, its own timer will not run either.

Windows has no SIGTERM. Each time the shell starts, it generates a named pipe name and tells the host via `ETA_STOP_PIPE` (the host removes it from the environment after reading it and does not pass it to the agent); when the host receives one line, it follows the same exit path as SIGTERM.

When something goes wrong, check these:

| What to check  | Where                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| host output    | `~/.eta/service/io.eta.host.log`                                                         |
| Upgrade output | `~/.eta/service/io.eta.host-upgrade.log`                                                 |
| Service config | `~/.eta/service/io.eta.host.json`: command to run, environment variables, stop wait time |
| Run status     | `~/.eta/service/io.eta.host.state.json`, `sc query io.eta.host`                          |
| Windows logs   | Event Viewer: Windows Logs → System, Source Service Control Manager                      |

## Upgrade

An installed `eta-host` can upgrade itself; no checkout required:

```sh
eta-host upgrade              # latest stable release
eta-host upgrade 0.2.0-rc.1   # specific version; prereleases can only be installed this way
eta-host upgrade --check      # only report whether a new version is available; change nothing
eta-host upgrade --status     # result of the last upgrade, or the stage currently in progress
eta-host upgrade --cancel     # cancel the in-progress upgrade; cannot cancel if the service has already stopped
```

The “Updates” section in settings does the same thing, but only upgrades to the latest stable release.

The first version with `upgrade` must be installed with `bun run host:install` or by manually replacing files; earlier versions do not have this command.

On Windows, run it under the account that installed the service; administrator privileges are not required. Running under another account is rejected, and reports who installed it.

While the service is running, the upgrade is handled by a separate worker, `io.eta.host-upgrade`. It is started by the service manager and is not a child process of the host, so stopping the service does not kill it. `eta-host upgrade` merely prints progress: closing the terminal, killing this command, or stopping the host does not affect it. Progress is written to `~/.eta/upgrade-status.json`. This file is not kept in the database because the database is replaced during a rollback.

| Platform | What the worker is                                                     | Logs                                         |
| -------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| Linux    | Temporary user unit, not in the host's cgroup                          | `journalctl --user -u io.eta.host-upgrade`   |
| macOS    | Temporary launchd job with its own process group                       | `~/Library/Logs/eta/io.eta.host-upgrade.log` |
| Windows  | One-shot service registered during installation, not in the host's job | `~/.eta/service/io.eta.host-upgrade.log`     |

On Windows, a running exe cannot be overwritten or deleted, but it can be renamed, so there are two differences: the worker runs from a temporary copy in `~/.eta/service`, which is deleted afterward; when swapping files, always rename the old file to `.prev` first. If the previous `.prev` is still in use by a process (such as an `eta-host upgrade` that has not exited yet), it is first renamed to `.prev.<pid>.old`. On rollback, likewise first rename the failed version to `.prev.<pid>.failed.old`, then swap back the old version: a file that has just run may remain locked for a while, during which it can be renamed but not overwritten. These `.old` files are cleaned up on the next upgrade; each is about 390 MB. Downloaded new files must be scanned by antivirus, so the test run timeout is 2 minutes, versus 20 seconds on other platforms.

The order is as follows; the first half does not affect the running host:

1. Find the version. If it is already this version, stop. Versions older than the current one are rejected; to roll back, use the method below.
2. Download to `eta-host.next` next to the executable and verify `SHA256SUMS`.
3. Test run: `--version` must match the version; `--migrations` lists the migrations it includes, and it is rejected if the database has a migration it does not recognize (the database is newer than this version, for example the host was built from a newer main). `v0.1.0` cannot list migrations: a host built from a checkout cannot upgrade to it, because there is no way to tell whether the database is newer.
4. Wait for agents: continue only after `task_run`, `routine_run`, and in-progress replies (including those just queued and those waiting for a user answer) have all finished. By default it waits 10 minutes (`--wait <minutes>`); if the wait times out, it exits without changing anything. `--force` does not wait; a restart will kill them.
5. Stop the service, back up the database, replace the files (the old files are kept as `eta-host.prev`), and start it.
6. Verify: `/up` must respond within 2 minutes, then keep responding for the next 5 seconds with the process unchanged, and the new version's migrations are all in the database.

If step 6 fails, stop the service, switch back to `.prev`, restore the database, start the old version again, then report the error and exit with exit code 1. Content written while the new version was running will be lost when the database is restored. If rollback also fails, the error message contains the paths to the old files and the backup; handle it manually.

Before step 5 you can abort with `--cancel`; nothing will be left behind. Starting at step 5, the worker ignores `SIGINT`, `SIGTERM`, and `SIGHUP`, so it will not leave the service halfway through.

Pressing Ctrl-C only stops following the output; the upgrade continues.

A restart only happens when `io.eta.host` is running (or has crashed and is waiting for the service manager to restart it), and the file running is this one:

- The service is running a different file: refuse; use that file's `upgrade`.
- The service is not installed or not running: back up the database and replace the files; you handle the restart; no verification or rollback.

Agents under host can also run `upgrade` directly. It counts itself among the running agents, so add `--force`; it will be killed during the restart and the upgrade continues.

After the service restarts, the daemon reconnects, and the host replaces them with the version it ships.

## Upgrade source

The upstream determines whose code this host runs. `SHA256SUMS` and the files come from the same place; this only proves the files are intact and cannot guard against a problem in the upstream itself.

Take the first one that exists, in order:

1. Command-line `--repo`; applies only to this run.
2. The `ETA_RELEASES_URL` environment variable.
3. The value saved in the "Updates" section of settings, stored in the host's database and readable by both the service and background workers.
4. The default compiled into the binary: CI builds use the repository they are built in; local builds use `0xfe-project/eta`. `eta-host upgrade --help` displays this value.

Only users can change settings; agent tools cannot reach them. When `ETA_RELEASES_URL` is present in the service's environment, it takes precedence; the settings page explains this and does not offer editing.

All four sources use the same syntax:

| Syntax                                    | What it is                                        |
| ----------------------------------------- | ------------------------------------------------- |
| `owner/name`                              | A repository on github.com                        |
| `https://github.com/owner/name`           | Same as above                                     |
| `https://api.github.com/repos/owner/name` | Same as above                                     |
| `https://<host>/api/v3/repos/owner/name`  | GitHub Enterprise                                 |
| Any other `http(s)` URL                   | Another server; must serve the same API as GitHub |

The URL must not contain credentials or query parameters: it will be shown on the page and written to logs.

Take the first available token:

| Upstream          | Order                                                                                                                                              |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| github.com        | `GH_TOKEN`, `GITHUB_TOKEN`, the one saved in settings, `gh auth token --hostname github.com`; anonymous if none are present                        |
| GitHub Enterprise | `GH_ENTERPRISE_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, the one saved in settings, `gh auth token --hostname <host machine>`; anonymous if none of them |
| Other servers     | Only `ETA_RELEASES_TOKEN`                                                                                                                          |

Environment variables and `gh` are read fresh each time, never stored. The “access token” in settings is the only token eta stores, and is meant for when the service cannot reach the `gh` login:

- It is encrypted with the host machine's key (`~/.eta/secret.key`) and stored in the database's `setting` table. It is ciphertext in database backups too.
- When saved, it is bound to the upstream host machine at that time and only sent to that host machine. If the upstream is later switched to another host machine, it is no longer used, and the page says so.
- It is never shown again after saving; the page only knows which host machine it belongs to.
- A token in the server's environment variables takes precedence over it, and the page says so. It cannot be saved when the upstream is another server, and that row is not shown then either.

The token never appears in logs, state files, or error messages.

GitHub credentials are never sent to other servers, nor to the signed addresses that downloads redirect to. Only `https` addresses whose path is `/api/v3/repos/<owner>/<name>` count as GitHub Enterprise, so this check looks only at the address: fill in one of those and `GH_TOKEN` will be sent to it.

The service can use `gh` only if `gh` is on its `PATH` (`PATH` comes from the shell at `install-service` time) and it can read the login state. When it cannot, the error messages say which case it is:

- No `gh`: install it, save a token in settings, or set `GH_TOKEN` for the service.
- `gh` has no login for this host machine: run `gh auth login` as the service's user (add `--hostname <host machine>` for Enterprise), or save a token in settings.
- `gh` has a login but it cannot be read: the login is in the keychain and the service cannot reach it. Run `gh auth login --insecure-storage`, save a token in settings, or set `GH_TOKEN` for the service.
- There is a token but the repository cannot be read: the token lacks permission for this repository, or the repository does not exist.
- The token was rejected: it expired or was revoked.

## How a fork releases

A fork uses the same `release.yml` with nothing to change: the workflow writes `github.repository` into the binary, so a release tagged from a fork upgrades from the fork itself by default, with no configuration needed from users.

1. Enable the workflow on the fork's Actions page. It is off by default for private forks.
2. Tag and push to the fork (the desktop app uses `desktop-v*`, same idea):

   ```sh
   git tag v0.2.0
   git push <the fork's remote> v0.2.0
   ```

3. Wait for the Release to publish. The Turborepo Remote Cache step in `check` belongs to the upstream only; failing there on a fork does not affect the result, it just makes the first run take longer. macOS and Windows runners count Actions minutes at a multiplier on private repositories.
4. Download and install the fork's `eta-host`, or, if the host machine already runs an upstream version, upgrade with `eta-host upgrade --repo <owner>/<name>`. After that this host machine follows the fork by default.

The version must be newer than the running one: releases older than the current version are rejected. When the fork is private, the host machine needs a token that can read it, see the previous section.

### The update button in settings

The `upgrade` wire target provides `check`, `start`, and `cancel`, which the page uses to start the worker. Progress goes over plain HTTP: the page polls `/upgrade/status`, which requires a token just like the page does. The socket drops first and recovers last during a restart, while polling this address only needs an answer or not, so it can tell “the host machine is restarting” apart from “the upgrade is finished”.

The page stays usable while downloading and waiting for the agent, and you may still need to answer the agent meanwhile. Once the service stops, a full-screen waiting page appears; when the host machine comes back it reads the result: on success it reloads the page, on rollback it explains why. Other tabs that did not read progress before the host machine stopped see the usual disconnected notice, and are prompted to refresh once it returns.

The button only appears for a compiled host, and only when `io.eta.host` or the desktop app is running that file, on all three platforms. When running from source, when no service is installed, or when the service runs a different file, only the reason is shown; on Windows without an installed service it also says to run `install-service` in an administrator terminal.

### The host machine in the desktop app

In local mode the desktop app is itself the host machine's service, alongside systemd, launchd, and the Windows service (`apps/desktop/src/bun/service.ts`; on the host machine side it is `apps/eta/src/upgrade/desktop.ts`). It runs `~/.eta/desktop/host/eta-host`, downloaded the first time it is needed (see “the first time you pick ‘run on this computer’”), and started from there ever after. App upgrades never touch this host machine; the host machine is upgraded only from the button in settings, so files in the installer are never modified and the signature is unaffected.

The shell opens a port on the local loopback whose token only it and the host machine know, and puts the address and token into the host machine's environment variables (the host machine removes them from the environment as soon as it starts, so processes it spawns never see them). After the button is clicked the flow is the same as with the service: the host machine asks the shell to start `eta-host upgrade --worker`; the worker is the shell's child process, not the host machine's, so it survives the host machine stopping. It downloads, verifies, and test-runs, then asks the shell to stop the host machine, backs up the database, swaps the files, asks the shell to start the new version on the original port, and checks `/up` and the migrations; on failure it swaps back to `eta-host.prev`, restores the database, and starts the old version again. The port stays the same, the window does not need to change, and the page's own waiting page refreshes once the host machine returns. The shell only runs `<host file> upgrade …` on behalf of the host machine and rejects every other command.

Quitting the app mid-upgrade: an upgrade that hasn't stopped the host yet is canceled; if the host has already been stopped, the app waits for it to finish (success or rollback) before exiting.

If a host on this machine is already using `~/.eta` (the command-line-installed `io.eta.host`, or one running in a terminal), the shell no longer starts a second one; it opens that one directly and leaves its upgrade alone—its settings page reports its own status. The way to determine this is to ask the host binary (`eta-host running`): first check `~/.eta/running-host.json`, written by the running host (it only counts if the pid is alive and `/up` responds), then ask the system service manager, so older services that don't write this file are also recognized. If that host stops, the window shows a failure page after 30 seconds, just like remote mode; on retry it re-evaluates and may switch to the app's own host.

When the shell is force-killed, the host is not left behind: the wrapper script between the shell and the host checks once a second whether the shell is still there, and stops the host if it isn't. On Windows it's more direct: child processes started by Bun share the same job object as the shell; as soon as the shell dies, the wrapper script and host end together on the spot, too quickly for a clean exit, so `running-host.json` is left behind, and on next startup the pid is used to determine that it is no longer alive. On normal app exit, the shell writes a line to the host's `ETA_STOP_PIPE`, and the host exits cleanly as if it had received SIGTERM (all three rounds pass on the Windows runner, `apps/desktop/test/real-host.test.ts`).

On Windows the buttons are initiated by the service, so the host works without administrator privileges: installation has already granted this account permission to start and stop both services.

### Backup

Backups are written to `~/.eta/backups/upgrade-<UTC time>-<old version>.sqlite` using `VACUUM INTO`, with permissions 0600, and a `quick_check` is run after writing. After each backup, only the latest 3 are kept; other files in this directory are left untouched. Each backup is the same size as the database.

The service is stopped before backup, so rollback does not lose data. Only `eta.sqlite` is backed up; session files and configuration in `~/.eta` are left untouched.

### Manual rollback

Migrations cannot necessarily be reversed (for example, `0042` dropped a column), so going back to an old version requires going back to the old database as well. The desktop app's host is in `~/.eta/desktop/host/`; quit the app first, swap the files and database, then open it again—no need for the service commands below:

```sh
systemctl --user stop io.eta.host
cd ~/.local/share/eta/host && mv eta-host.prev eta-host
cp ~/.eta/backups/upgrade-<time>-<old version>.sqlite ~/.eta/eta.sqlite
rm -f ~/.eta/eta.sqlite-wal ~/.eta/eta.sqlite-shm
systemctl --user start io.eta.host
```

On macOS, replace the first and last lines with `launchctl bootout gui/$(id -u)/io.eta.host` and `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.eta.host.plist`. On Windows, use `sc stop io.eta.host` and `sc start io.eta.host`, swapping the files in between:

```powershell
sc stop io.eta.host
Move-Item -Force eta-host.exe.prev eta-host.exe
Copy-Item -Force "$HOME\.eta\backups\upgrade-<time>-<old version>.sqlite" "$HOME\.eta\eta.sqlite"
Remove-Item -Force "$HOME\.eta\eta.sqlite-wal", "$HOME\.eta\eta.sqlite-shm" -ErrorAction SilentlyContinue
sc start io.eta.host
```

Data written after the upgrade is not in the backup and will be lost on manual rollback.
