# Release

The host and the desktop app are released separately, each with its own version number:

| tag          | Workflow                                | What ships                                                                    |
| ------------ | --------------------------------------- | ----------------------------------------------------------------------------- |
| `v*`         | `.github/workflows/release.yml`         | `eta-host`, one file each for Linux, macOS, Windows                           |
| `desktop-v*` | `.github/workflows/release-desktop.yml` | Client app: desktop installers, Android APK, iOS IPA, see "Desktop app" below |

GitHub's Latest is always the host: desktop releases are published with `--latest=false`. `eta-host upgrade` and the settings page button also don't look at who Latest is, they only take `v*` tags (`packages/releases/src/releases.ts`), so even if a desktop Release is manually marked Latest, the host still picks up the newest host.

Each kind's generated release notes only cover the changes since the previous release of the same kind: the workflow passes `--notes-start-tag` with the newest published `v*` (host) or `desktop-v*` (client) release before it. Drafts don't count, so a tag whose run failed is skipped. Without an earlier release of that kind, GitHub's default comparison is used and the run logs a warning.

## Tagging

Tag the commit you want to release, usually the latest one on `main`:

```sh
git fetch origin
git tag v0.2.0 origin/main
git push origin v0.2.0
```

- The version is the tag minus the `v`. Both the host and the daemon it ships are this version; `version` in `package.json` plays no part.
- This section and the ones below are all about the host. For the desktop app, tag `desktop-v*`; see "Desktop app".
- A `-` makes it a prerelease, e.g. `v0.2.0-rc.1`; the Release is marked Pre-release and doesn't count as the latest version. Hosts with "Pre-releases" switched on under Settings → Update (or `eta-host upgrade --prerelease`) are offered it; see "Pre-releases" below.
- The tag must be `vX.Y.Z` or `vX.Y.Z-suffix`; any other form won't publish.

### Pre-releases

Hosts that switched pre-releases on upgrade to them, so a pre-release tag is a release like any other for the database of whoever installed it. Two rules:

- **Pre-release tags are cut from `main` only**, like full releases.
- **A migration that is in any `v*` tag, pre-release tags included, is never renamed or edited. To change it, add a new migration.** `upgrade.ts` holds the new build's `--migrations` against the ids the database has already run and refuses the upgrade when the database has one the build does not carry; `--force` does not get past that. A renamed migration therefore leaves every host that installed the beta unable to upgrade, ever. A migration whose content changed passes that check, but it does not run again, so the database quietly stops matching the code.

`release.yml` enforces the second rule: its `migrations` job compares `apps/eta/src/migrations/` with the previous `v*` tag (pre-release tags included) and fails the release if a file there was renamed, removed or changed (`scripts/check-migrations-frozen.sh`). Run it by hand before tagging: `scripts/check-migrations-frozen.sh <previous tag>`.

Where `from` comes from: the highest earlier **full** release, and — when the tag being cut is a pre-release — the pre-release before it too, as one more entry in the same Linux matrix. That second one is the upgrade people on an rc actually do (rc.3 → rc.4, not through a full release), and it used to be a known gap that had to be run by hand with `-f from=<rc>`; it needs a seed for that rc, see "Seed data" (`0.4.0-rc.3` has one). A pre-release → its own full release is the same case with `to` being the full release: `from` is then the last full release, which is what a person on the last full release has.

Pipeline order:

1. `prepare`: read the version from the tag, open a draft Release.
2. `check`: runs alongside the build, the full `bun run check`, not `--affected`. If it fails nothing is published and the draft stays.
   `migrations` runs alongside it too: every migration in the previous `v*` tag (pre-release tags included) must be unchanged, see "Pre-releases".
3. `build`: each platform on its own runner, clean checkout, frozen lockfile build. The host is run separately once to check `--version`, `/up` and the page, and only then uploaded to the draft. The Linux one also writes `eta-host.json` (`eta-host --version --json`) and uploads it too.
4. `cross`: `upgrade-cross.yml` upgrades from the previous stable release to this draft on Linux — and, for a pre-release tag, from the pre-release before it as well — see "Cross-version upgrade test" below. With no previous release, or if the previous one is older than the earliest seed (e.g. v0.1.0, which cannot self-upgrade), it is skipped and noted in the run summary; a skipped `cross` publishes nothing, so an rc with no seed for its predecessor is the one case worth checking by hand.
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

Build the same file locally with `bun run --cwd apps/client package:web && bun apps/eta/scripts/build-host.ts`; the artifact is in `apps/eta/out/host/`.

The CLIProxyAPI bundled in the host depends on the machine that builds it, so each platform must be built on its own runner. Adding a platform means adding a row to the `build` matrix; verify that the platform compiles first. There is no `darwin-x64` and no Windows daemon (it is not in the platform table in `apps/daemon/scripts/build.ts`).

## Desktop app

```sh
git tag desktop-v0.2.0 origin/main
git push origin desktop-v0.2.0
```

The `desktop-v*` workflow packages `apps/client` with the Native Shell release pinned in `.github/actions/setup-nsh/action.yml` (`v0.7.1`). It strips `desktop-v` from the tag and passes the result as the app version. A suffix marks a prerelease. The host release keeps GitHub's Latest label.

The workflow opens a draft, runs CI and builds on each target's own runner. It checks that every desktop package includes the local host launcher, then publishes the draft with `SHA256SUMS`.

| File                           | Platform                    | Contents                        |
| ------------------------------ | --------------------------- | ------------------------------- |
| `eta-desktop-linux-x64.tar.gz` | Linux x64                   | App directory and desktop entry |
| `eta-desktop-darwin-arm64.dmg` | macOS arm64                 | App bundle                      |
| `eta-desktop-windows-x64.zip`  | Windows x64                 | App directory with `Eta.exe`    |
| `eta-android.apk`              | Android 8+, arm64 and armv7 | APK for sideloading             |
| `eta-ios.ipa`                  | iOS 15+ devices             | IPA, signed or not, see below   |
| `SHA256SUMS`                   |                             | Checksums for these files       |

### Phone packages

The phone apps get the same version as the desktop app; their build number (Android's version code) is the workflow's run number, which only grows, so a newer APK installs over an older one signed with the same key.

The packages are signed with what the repository's Actions secrets provide. Missing secrets don't fail the release; the package is built anyway and a note at the top of the release notes says how it was signed:

| Secret                          | What                                                        | Without it                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ETA_ANDROID_KEYSTORE`          | Release keystore (`.jks`), base64                           | Signed with a debug key made on the runner for this build. The next release's APK has another key, so Android only installs it after the old app is uninstalled, which deletes its data |
| `ETA_ANDROID_KEY_ALIAS`         | Key alias in the keystore                                   |                                                                                                                                                                                         |
| `ETA_ANDROID_KEYSTORE_PASSWORD` | Keystore password                                           |                                                                                                                                                                                         |
| `ETA_IOS_CERTIFICATE`           | Signing certificate with its private key (`.p12`), base64   | An unsigned IPA (`Payload/Eta.app`). It installs only once re-signed for a device, e.g. with AltStore or Sideloadly                                                                     |
| `ETA_IOS_CERTIFICATE_PASSWORD`  | The `.p12`'s password                                       |                                                                                                                                                                                         |
| `ETA_IOS_PROFILE`               | Provisioning profile (`.mobileprovision`), base64           |                                                                                                                                                                                         |
| `ETA_IOS_SIGN_IDENTITY`         | Its identity, e.g. `Apple Distribution: Your Team (TEAMID)` |                                                                                                                                                                                         |

A signed IPA installs only on the devices its profile allows (development or ad hoc). Anything beyond that goes through TestFlight or the App Store, see "Local packages and store uploads" below; the same goes for Google Play.

### The client app's own updates

The desktop apps (macOS, Windows, Linux) and the Android app update themselves from Settings → Update, whichever host they are connected to, and check once at start: a newer release shows a strip at the bottom of the window with one button (download, then restart) and a close button that hides it for that version. iOS is left to the store or a manual install: its build has no update source.

- **Desktop**: `nsh/updater` downloads the platform's archive (`Eta-<version>-<os>-<arch>.tar.gz|zip`), checks its size and SHA-256 against the signed manifest, and on restart swaps the app in place and opens it again. When the app runs this computer's host, the confirmation lists the work the restart would stop, as the host's own update does. The settings choose the channel: Full releases only (`stable`) or Pre-releases too (`rc`); a build starts on its own kind's channel.
- **Android**: the release's code also ships as a signed OTA package (`dev.eta.client-<build>.nshpkg`, `nsh publish`). The app downloads and verifies it, and runs it from its next start: the button then closes the app, and opening it again runs the new version. When the code needs a newer native shell (a newer nsh runtime than the installed APK's), there is no package for it and the app offers the release's APK instead, which the system installs. That only works over an APK signed with the same key, so the manifest lists the APK only when `ETA_ANDROID_KEYSTORE` is configured; without it, a new shell still means uninstalling and installing by hand. Android follows its build's own channel (nsh 0.7 checks for packages on the default source only).

Where they look is fixed in each build: two releases that are never Latest and hold nothing but `latest.json` and `latest.json.sig`, `desktop-channel-stable` and `desktop-channel-rc` (`https://github.com/<repo>/releases/download/desktop-channel-<channel>/latest.json`, downloadable without a token as the repository is public). The archives, the package and the APK stay on the versioned `desktop-v*` release, which the manifest points at. The publish job writes the manifest from the published release (notes included) and puts it on `rc`, and for a full release on `stable` too; a channel only moves forward, so rerunning an older tag leaves it alone. Not GitHub Pages: two small files do not need a site and a deploy, and a release asset is replaced at once rather than after a CDN's cache.

| Name                           | Kind               | What                                                                                                                                                        |
| ------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ETA_CLIENT_UPDATE_PUBLIC_KEY` | variable           | Ed25519 public key the apps check `latest.json.sig` with (`nsh keygen`). Without it a release has no updates at all, as before                              |
| `ETA_CLIENT_UPDATE_KEY`        | secret             | Its secret key: signs the manifest                                                                                                                          |
| `ETA_CLIENT_PACKAGE_ROOT`      | variable           | OTA root public key Android builds trust (comma separated to rotate). Its secret key is kept offline, not in GitHub                                         |
| `ETA_CLIENT_RELEASE_KEY`       | secret             | Release key that signs the OTA package                                                                                                                      |
| `ETA_CLIENT_RELEASE_CERT`      | secret             | The root's certificate for it (`nsh certify --apps dev.eta.client`), 365 days: certify the key again before it runs out                                     |
| `ETA_CLIENT_DOWNLOAD_BASE`     | variable, optional | Replaces `https://github.com/<repo>/releases/download` in the URLs, for a test from a private repository, whose downloads need a token the apps do not have |

A build trusts the update key and OTA root it was built with; changing either means users install a new app by hand once. A new release key only needs a new certificate.

macOS checks the new app's code signature before swapping it in (`codesign --verify --deep --strict`), which the ad hoc signature of `nsh package` passes. Gatekeeper is not involved, as the app downloads the archive itself, but a Developer ID signature and notarization are still what lets people open the first download without the quarantine workaround below.

### Local packages and store uploads

Install the Native Shell release that CI pins (`v0.7.1`, or point `ETA_NSH` at that binary — `scripts/nsh-client.ts` runs `ETA_NSH ?? "nsh"`), then package for your desktop from the repository root.

```sh
bun run client:package --target macos --out dist/macos
```

The path passed to `--out` is relative to `apps/client`. The macOS build is ad hoc signed. For public distribution, sign it with a Developer ID and notarize it.

Run the **Package Eta client** workflow to create downloadable CI artifacts for the web, the native desktop platforms, the iOS simulator and Android. For store builds, pass signing credentials to Native Shell when packaging, then use the corresponding upload command.

```sh
bun run client:package --target ios --sign "Apple Distribution: Your Team" --profile /path/to/profile.mobileprovision
bun run client:publish:ios .nsh/out/Eta.ipa

bun run client:package --target android --format aab --keystore /path/to/release.jks --key-alias eta
bun run client:publish:android .nsh/out/Eta.aab
```

The upload commands read App Store Connect and Google Play credentials from the environment. Keep the credentials outside the repository. See the [Native Shell packaging guide](https://nsh.dev/docs/packaging/) for the supported flags and environment variables.

### The first time "Run on this computer" is picked

The desktop package includes a host launcher. The launcher uses the installed host when available, or checks for an already running host before downloading one. It picks a compatible stable host release, verifies its `SHA256SUMS` entry, runs `--version`, and installs it in `~/.eta/desktop/host/`. Hosts already running as system services keep their own lifecycle.

The launcher follows the repository set at build time with `ETA_HOST_UPSTREAM`. Set `ETA_RELEASES_URL` to use a different release server. For private GitHub repositories, authenticate with `gh` on the desktop. Selecting an existing remote host skips the local launcher.

Host upgrades are available in Settings → Update when the host is managed by the desktop launcher or a system service. The app updates itself there too, see "The client app's own updates".

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

`to` defaults to the tag being run, `from` defaults to the highest release version smaller than it — full releases only when `to` is a full release, and the previous pre-release as well when `to` is one. Both run in one matrix: Linux twice, the other platforms (asked for by hand) once.

It downloads real files for both versions, installs `from` as a service, puts in seed data, then:

1. Use `eta-host upgrade` to upgrade to `to`.
2. Start over, upgrade to `to` using the same interface called by the settings page button.
3. Start over, upgrade to a broken build (`bad-host.ts`, will destroy data, exits after responding to `/up`), see `from`'s worker put files and database back.

After each time verify: file version, service running, `/up`, page can open, seed count and content, migration records, encrypted values can be decrypted, session can open, then send a message and get a reply.

### Seed data

`test/upgrade-seed/<version>/` is a data directory (`data/`) actually left behind by a host of that version, plus the content to verify against later (`manifest.json`). Everything in it is fake data, and `data/secret.key` can only decrypt those fake values. The test picks the newest one no higher than `from`, and `from` migrates it up itself — which is why a version that changes the schema needs its own seed: without one, `from` is handed an older shape and migrates that, so the shape people actually have is never the one tested. `0.2.0`, `0.3.0` (the first with the task board 0054 rebuilds) and `0.4.0-rc.3` (the first with ACP, and the one that makes an rc → rc run possible) are there now. `apps/eta/test/upgrade-seed.test.ts` upgrades each of them with the current code on every test run, so a seed that stopped matching fails before a release does.

For versions where the schema or storage format changed, add a seed. Do it in an isolated environment; the script wipes `/tmp/eta-seed-home`:

```sh
gh release download v0.3.0 --repo <owner>/<name> --pattern eta-host-linux-x64
chmod +x eta-host-linux-x64
bun scripts/upgrade-e2e/seed.ts ./eta-host-linux-x64 0.3.0
docker run --rm -v "$PWD:/repo:ro" zricethezav/gitleaks detect --source /repo/test/upgrade-seed --no-git
```

The script starts a host with this version's binary, HOME at `/tmp/eta-seed-home`, model `fake-model.ts`, then calls over the wire like the pages do: create agents, projects, conversations, send messages, have the model publish two versions of an artifact, create tasks and run them to completion, store plugin config, register host machines, create routine tasks, change settings. After the host exits, copy the data directory over and generate `manifest.json`, then verify once more. Don't hand-write SQL, don't put in real data, and the hostname must be fake (generated in a container with `--hostname eta-seed`). The driver speaks this checkout's wire, so an older binary needs no adapter, only patience: it mounts its plugins after `/up` answers, and a call that arrives first is retried (`unknown op`) instead of failing the seed. A build that makes a Captain for itself is seeded through the same lens the check reads it back with (`leaveOutSystemData`), or the seed's own manifest disagrees with its own check.

### A client from the last release, against this one

The wire protocol only ever grows, and a release has to keep the clients already out there working: an old phone, an old TUI, a browser tab left open across the upgrade. `scripts/upgrade-e2e/wire-client.ts` drives one version's client against another version's host, both real processes:

```sh
# an rc.3 client (that tree's apps/tui/src/connection/wire.ts) against this build's host
git worktree add /tmp/rc3 v0.4.0-rc.3 && (cd /tmp/rc3 && bun install)
bun apps/eta/src/main.ts --port 18922 --no-web --allow-origin http://127.0.0.1:18922 &
(cd /tmp/rc3 && bun <this repo>/scripts/upgrade-e2e/wire-client.ts apps/tui/src/connection/wire.ts 18922 talk <conversationId> <agentId>)
```

`hello` prints what the host advertises, `talk` sends one message and waits for the reply, `degrade` calls an op the other side lacks and checks the connection survives it. For v0.4.0-rc.4: rc.3's client on this build's host and this build's client on rc.3's host both reached `replied: true`, and the only difference in the ops was two the newer host has (`acp.refresh`, `tasks.workspaceFor`) — an unknown op comes back as an error that leaves the connection open, which is what `degrade` shows.

Rows written before `data.process` existed (v0.3.0 kept a reply's calls as `data.activity` alone) still draw as their last thought and their calls: `savedSteps` in `packages/client-contracts`, tested there.

## No signatures

None of these files are signed or notarized. Desktop app updates are triggered by the user in settings (see "The client app's own updates"), and builds without a configured update URL can only be re-downloaded and reinstalled. macOS and Windows both block them on first open; once allowed, they work normally.

On macOS, drag eta from the DMG into Applications, then remove the quarantine flag from the download, otherwise the system will say the app is damaged:

```sh
xattr -dr com.apple.quarantine /Applications/eta.app
```

Do the same for the downloaded host: `xattr -d com.apple.quarantine eta-host-darwin-arm64`.

On Windows, unzip and run `eta-Setup.exe`. When SmartScreen says "Windows protected your PC", click "More info", then "Run anyway".

## Download and run

The repository is public, so the files download without a token:

```sh
curl -LO https://github.com/0xfe-project/eta/releases/latest/download/eta-host-linux-x64
curl -LO https://github.com/0xfe-project/eta/releases/latest/download/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

`latest/download` is the newest full release; for a given version use `releases/download/v0.2.0/<file>`, or `gh release download v0.2.0 --repo 0xfe-project/eta --pattern 'eta-*' --pattern SHA256SUMS` for every platform at once.

macOS has no `sha256sum`; use `shasum -a 256 -c SHA256SUMS --ignore-missing`. On Windows use PowerShell's `Get-FileHash <file>` and compare against that line in `SHA256SUMS`.

Then:

```sh
chmod +x eta-host-linux-x64
./eta-host-linux-x64 --version
```

`--version` outputs `eta-host 0.2.0 (37d8188c1234)`; the parentheses hold the commit.

Running it and installing it as a service: see [Self-hosting](self-hosting.md).

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
eta-host upgrade              # latest stable release, or the latest pre-release when switched on in settings
eta-host upgrade --prerelease # latest release or pre-release, this once
eta-host upgrade 0.2.0-rc.1   # specific version, pre-release or not
eta-host upgrade --check      # only report whether a new version is available; change nothing
eta-host upgrade --status     # result of the last upgrade, or the stage currently in progress
eta-host upgrade --cancel     # cancel the in-progress upgrade; cannot cancel if the service has already stopped
```

The “Updates” section in settings does the same thing, but never to a version you name: it upgrades to the latest stable release, or with "Pre-releases" switched on, to the highest published `v*` including pre-releases (`-alpha`, `-beta`, `-rc`, …). A full release is higher than its own pre-releases, so `0.3.0` replaces `0.3.0-rc.1`. The switch is the host's setting `upgrade.prerelease`, next to `upgrade.upstream` and `upgrade.token`; from a window connected to a remote host it is that host's. `eta-host upgrade` without a version and the worker the button starts read the same setting from `~/.eta` (`savedPrerelease`), so the button upgrades to what the page showed.

The release list is read one page of 100 at a time, newest first, following the API's `Link` header, until a page holds a release the channel takes, up to 10 pages (1,000 releases). `desktop-v*` releases share the list with the host's, so many client releases in a row can push every `v*` off the first page; they are paged past rather than hiding the host. The desktop launcher's search for a host it can run (`hosts()`) reads the list the same way. A release server that sends no `Link` header is read once.

Switching pre-releases off never goes back: on a pre-release build with nothing newer among the full releases, the page and `eta-host upgrade` say so and offer nothing until a newer full release is out.

The desktop app's first download of a host and the `upgrade-cross.yml` baseline only ever take full releases.

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

The client uses `upgrade.check`, `upgrade.start` and `upgrade.cancel`. It reads progress from the `upgrade` target and shows a full-screen status while the host restarts. Once the socket reconnects, Settings shows the installed version or the reason the upgrade failed.

The button only appears for a compiled host, and only when `io.eta.host` or the desktop app is running that file, on all three platforms. When running from source, when no service is installed, or when the service runs a different file, only the reason is shown; on Windows without an installed service it also says to run `install-service` in an administrator terminal.

### The host machine in the desktop app

The local launcher in `scripts/nsh-host-bootstrap.ts` supervises the host and keeps its original loopback port across upgrades. It uses the service implementation in `scripts/host-launcher/service.ts`.

The launcher provides the host with a token for a loopback service endpoint. It accepts only the host's own upgrade worker, which runs alongside the host. The worker verifies the new release, stops the host, backs up the database and starts the replacement on the previous port. If verification fails after restart, it restores the old executable and database.

A host already serving `~/.eta` is reused. Its own service manager handles restart and upgrade.

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
