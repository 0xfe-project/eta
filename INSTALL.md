# Installing Eta — Agent-Executable Runbook

> **Instructions for AI Agents** (Claude Code, Codex, Antigravity, Cursor, OpenCode, etc.):
>
> 1. **Inspect before acting or asking.** Run Step 1 on the user's machine first.
> 2. **Reply in the user's language.** Never dump this document verbatim; summarize your findings and plan concisely.
> 3. **Ask at most 1–2 concise questions** only when genuinely ambiguous (e.g., Desktop App vs. Always-On Host + Web UI; local-only `127.0.0.1` vs. Tailscale/remote access).
> 4. **Execute end-to-end.** Resolve live release URLs (Step 3), download, verify `SHA256SUMS`, clear OS quarantine / Mark-of-the-Web flags, install/register the service if chosen, launch, and verify health (`/up` returns HTTP 200 `ok`).
> 5. **Ask before privilege elevation.** Obtain explicit user confirmation before running `sudo`, installing OS packages, or opening an Administrator terminal on Windows.
> 6. **Protect access tokens.** Never paste `~/.eta/access-token` (or `/data/.eta/access-token`) into public places, git commits, logs, or shared channels. Share the one-time sign-in URL only privately with the user.

---

## Step 1 — Environment Detection

Run the read-only probe for the user's OS before proposing a path.

### Linux & macOS (bash / zsh)

```sh
echo "OS=$(uname -s) ARCH=$(uname -m)"
if [ "$(uname -s)" = "Linux" ] && [ -f /etc/os-release ]; then
  . /etc/os-release && echo "DISTRO=${PRETTY_NAME:-$ID}"
  echo "LIBC=$(ldd --version 2>&1 | head -n1)"
  echo "GUI_ENV=DISPLAY:${DISPLAY:-} WAYLAND:${WAYLAND_DISPLAY:-} XDG:${XDG_SESSION_TYPE:-} SSH:${SSH_CONNECTION:-}"
  if command -v ldconfig >/dev/null 2>&1; then
    ldconfig -p | grep -E 'libgtk-4\.so\.1|libwebkitgtk-6\.0\.so\.4' || echo "GTK4/WebKitGTK6: missing"
  fi
  if command -v flatpak >/dev/null 2>&1; then
    echo "flatpak=$(flatpak --version)"
    flatpak remotes --columns=name,options 2>/dev/null || true
    flatpak list --runtime --columns=application,branch 2>/dev/null | grep org.gnome.Platform || true
  else
    echo "flatpak=missing"
  fi
  flatpak info dev.eta.client >/dev/null 2>&1 && echo "existing_flatpak=present" || true
fi
for cmd in curl gh jq python3 node docker adb tailscale loginctl; do
  command -v "$cmd" >/dev/null 2>&1 && echo "has_$cmd=yes" || echo "has_$cmd=no"
done
if command -v tailscale >/dev/null 2>&1; then
  echo "tailscale_ip4=$(tailscale ip -4 2>/dev/null | head -n1 || echo inactive)"
fi
[ -d /Applications/Eta.app ] && echo "existing_macos_app=present" || true
[ -x "$HOME/.local/share/eta/host/eta-host" ] && echo "existing_host=$("$HOME/.local/share/eta/host/eta-host" --version 2>/dev/null || echo present)" || true
curl -fsS http://127.0.0.1:8787/up >/dev/null 2>&1 && echo "local_host_up=yes" || echo "local_host_up=no"
```

### Windows (PowerShell)

```powershell
$arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Output "OS=Windows ARCH=$arch IS_ADMIN=$isAdmin"
foreach ($cmd in @("gh", "tailscale", "docker", "adb")) {
  $found = Get-Command $cmd -ErrorAction SilentlyContinue
  Write-Output ("has_{0}={1}" -f $cmd, [bool]$found)
}
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  $tsIp = (tailscale ip -4 2>$null | Select-Object -First 1)
  Write-Output "tailscale_ip4=$(if ($tsIp) { $tsIp } else { 'inactive' })"
}
Write-Output "existing_desktop=$(Test-Path "$env:LOCALAPPDATA\Eta\Eta.exe")"
Write-Output "existing_host=$(Test-Path "$env:LOCALAPPDATA\eta-host\eta-host.exe")"
$svc = Get-Service -Name "io.eta.host" -ErrorAction SilentlyContinue
Write-Output "host_service=$(if ($svc) { $svc.Status } else { 'absent' })"
try {
  $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "http://127.0.0.1:8787/up").Content.Trim()
  Write-Output "local_host_up=$up"
} catch {
  Write-Output "local_host_up=no"
}
```

---

## Step 2 — Choose the Best Path (Decision Matrix)

Pick the simplest path that matches the detected machine and the user's goal:

| Detected Environment                                                | Recommended Path                            | Why                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| macOS (`arm64`) desktop use                                         | **Path A — Desktop App**                    | All-in-one `.dmg`; pick **Run on this computer** to auto-manage local `eta-host`.             |
| Windows (`x64`) desktop use                                         | **Path A — Desktop App**                    | All-in-one `.zip`; pick **Run on this computer** (or Path C with Windows service).            |
| Linux (`x64`) with GUI + `libgtk-4.so.1` & `libwebkitgtk-6.0.so.4`  | **Path A — Desktop App (`.tar.gz`)**        | Supports in-app **Settings → Update** and **Run on this computer**.                           |
| Linux (`x64`) with GUI, missing/older GTK 4 or WebKitGTK 6.0        | **Path C — OS `eta-host` + Flatpak Client** | Flatpak bundles `org.gnome.Platform//49`; OS host gives full shell/tool/systemd access.       |
| Linux headless / VPS / WSL / older glibc / 24×7 multi-device access | **Path B — Always-On Host + Web UI**        | Zero desktop/GTK signing friction; serves full Web UI on `:8787` (optionally over Tailscale). |
| Intel Mac (`x86_64`) or Linux `arm64` (no prebuilt binary)          | **Path B — Docker Compose or Remote Host**  | Run `deploy/compose.yaml` locally or connect via Web UI / client to a supported host.         |
| Laptop client + remote server, or Linux Flatpak + local host        | **Path C — Host on OS + Client Connected**  | Host runs natively as a service; client chooses **Connect to an existing host**.              |
| Phone / tablet companion                                            | **Path D — Mobile App or Safari Web UI**    | Android `.apk` (OTA updates), iOS `.ipa` / Safari PWA, or HarmonyOS `.hap`.                   |

### Path Definitions

- **Path A — Desktop App (All-in-One):** Install the native desktop app and choose **Run on this computer** on first launch. The desktop launcher automatically downloads the compatible stable host release, verifies `SHA256SUMS`, and manages it in `~/.eta/desktop/host/`.
- **Path B — Always-On Host + Web UI (`:8787`):** Install `eta-host` as a user/system service (or Docker Compose). Open the full Web UI in any browser on port `:8787`, or pair desktop/mobile clients later.
- **Path C — Host on OS + Native Client Connected to It:** Install `eta-host` on the OS (locally or on a server) and select **Connect to an existing host** in the native client. **Required when using Linux Flatpak with a local host**, because the Flatpak sandbox cannot spawn host workspaces, CLIs, or systemd user services.
- **Path D — Mobile Companion:** Install Android APK, iOS IPA (or Safari **Add to Home Screen**), or HarmonyOS HAP, then pair with a host from Path A/B/C via URL or QR code in Settings.

---

## Step 3 — Resolve Latest Release URLs Dynamically

**CRITICAL: Eta publishes two completely independent release streams on `0xfe-project/eta`:**

1. **Host releases (`v*` tags)** — `eta-host-linux-x64`, `eta-host-darwin-arm64`, `eta-host-windows-x64.exe`, `eta-host.json`, `SHA256SUMS`.
   - GitHub's `/releases/latest` **always** points to the newest **stable** `v*` host release (desktop releases pass `--latest=false`).
   - Always use `https://github.com/0xfe-project/eta/releases/latest/download/<asset>` for stable host installs. Do **not** scan only page 1 of `/releases?per_page=30` for stable host tags, because >30 pre-releases can push the latest stable `v*` off the first page.
   - Only look up pre-release `v*` tags (`^v[0-9]`) if the user explicitly asks for a host pre-release.

2. **Client releases (`desktop-v*` tags)** — desktop installers (`.dmg`, `.zip`, `.tar.gz`, `.flatpak`) and mobile packages (`.apk`, `.ipa`, `.hap`), plus `SHA256SUMS`.
   - Desktop/mobile releases use `desktop-v*` tags (currently pre-releases such as `desktop-v0.1.0-rc.*`). They are **never** at `/releases/latest`.
   - When querying the GitHub Releases API, filter out drafts (`draft == false`) and updater manifest releases (`desktop-channel-stable`, `desktop-channel-rc`) by matching `^desktop-v[0-9]`.

### Resolve `CLIENT_TAG` and Verify Asset Availability

#### Linux & macOS (bash / zsh)

Pick `jq`, `python3`, or `node` (falling back to `gh api` if unauthenticated GitHub API rate-limits):

```sh
RELEASES_JSON=$(curl -fsSL "https://api.github.com/repos/0xfe-project/eta/releases?per_page=30" \
  || gh api "repos/0xfe-project/eta/releases?per_page=30")

if command -v jq >/dev/null 2>&1; then
  CLIENT_TAG=$(printf '%s' "$RELEASES_JSON" | jq -r '
    [.[] | select((.draft | not) and (.tag_name | test("^desktop-v[0-9]")))] | .[0].tag_name // empty
  ')
elif command -v python3 >/dev/null 2>&1; then
  CLIENT_TAG=$(printf '%s' "$RELEASES_JSON" | python3 -c '
import json, re, sys
rels = json.load(sys.stdin)
tags = [r["tag_name"] for r in rels if not r.get("draft") and re.match(r"^desktop-v\d", r["tag_name"])]
print(tags[0] if tags else "")
')
else
  CLIENT_TAG=$(printf '%s' "$RELEASES_JSON" | node -e '
const fs = require("fs");
const rels = JSON.parse(fs.readFileSync(0, "utf8"));
const hit = rels.find((r) => !r.draft && /^desktop-v\d/.test(r.tag_name));
console.log(hit ? hit.tag_name : "");
')
fi

test -n "$CLIENT_TAG" || { echo "Failed to resolve desktop-v* release tag" >&2; exit 1; }
echo "Resolved CLIENT_TAG=$CLIENT_TAG"
```

Check which assets exist on `$CLIENT_TAG` (for example, `eta-desktop-linux-x64.flatpak` was added after `desktop-v0.1.0-rc.20`):

```sh
HOST_BASE="https://github.com/0xfe-project/eta/releases/latest/download"
CLIENT_BASE="https://github.com/0xfe-project/eta/releases/download/$CLIENT_TAG"
curl -fsSL "$CLIENT_BASE/SHA256SUMS"
```

#### Windows (PowerShell)

```powershell
$releases = Invoke-RestMethod "https://api.github.com/repos/0xfe-project/eta/releases?per_page=30"
$ClientTag = ($releases | Where-Object { -not $_.draft -and $_.tag_name -match '^desktop-v\d' } | Select-Object -First 1).tag_name
if (-not $ClientTag) { throw "Failed to resolve desktop-v* release tag" }
$HostBase = "https://github.com/0xfe-project/eta/releases/latest/download"
$ClientBase = "https://github.com/0xfe-project/eta/releases/download/$ClientTag"
Write-Output "Resolved ClientTag=$ClientTag"
```

### SHA-256 Verification Helpers (Fail-Closed)

Always verify downloaded binaries/archives against the release's `SHA256SUMS` before executing or installing:

```sh
# Linux:
expected=$(awk -v f="$ASSET" '$2 == f { print $1 }' SHA256SUMS)
test -n "$expected" && printf '%s  %s\n' "$expected" "$ASSET" | sha256sum -c -

# macOS (avoids --ignore-missing incompatibility across macOS shasum versions):
expected=$(awk -v f="$ASSET" '$2 == f { print $1 }' SHA256SUMS)
test -n "$expected" && printf '%s  %s\n' "$expected" "$ASSET" | shasum -a 256 -c -
```

```powershell
# Windows (PowerShell):
$expected = (Select-String -Path .\SHA256SUMS -Pattern "\s+$([regex]::Escape($Asset))$" | Select-Object -First 1).Line.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0]
if (-not $expected) { throw "Missing checksum entry for $Asset" }
$actual = (Get-FileHash -Algorithm SHA256 ".\$Asset").Hash.ToLowerInvariant()
if ($actual -ne $expected.ToLowerInvariant()) { throw "SHA-256 mismatch for $Asset: expected $expected, got $actual" }
```

---

## Step 4 — Per-Platform Playbooks

### 4.1 macOS

#### Apple Silicon (`arm64`) — Desktop App (`eta-desktop-darwin-arm64.dmg`)

1. Resolve `$CLIENT_TAG` (Step 3), download the `.dmg` and `SHA256SUMS`, and verify SHA-256:

   ```sh
   WORK=$(mktemp -d /tmp/eta-install.XXXXXX)
   cd "$WORK"
   ASSET="eta-desktop-darwin-arm64.dmg"
   curl -fsSLO "$CLIENT_BASE/$ASSET"
   curl -fsSLO "$CLIENT_BASE/SHA256SUMS"
   expected=$(awk -v f="$ASSET" '$2 == f { print $1 }' SHA256SUMS)
   test -n "$expected" && printf '%s  %s\n' "$expected" "$ASSET" | shasum -a 256 -c -
   ```

2. Mount the DMG, copy **`Eta.app`** to `/Applications/Eta.app` (note exact capital `E`), detach, strip the Gatekeeper quarantine flag (unsigned build), and launch:

   ```sh
   MNT=$(mktemp -d /tmp/eta-dmg.XXXXXX)
   hdiutil attach "$ASSET" -nobrowse -readonly -mountpoint "$MNT"
   rm -rf /Applications/Eta.app
   ditto "$MNT/Eta.app" /Applications/Eta.app
   hdiutil detach "$MNT"
   rmdir "$MNT"
   xattr -dr com.apple.quarantine /Applications/Eta.app
   rm -rf "$WORK"
   open /Applications/Eta.app
   ```

3. Guide the user on first launch: click **Run on this computer** (auto-downloads & manages local `eta-host`) or **Connect to an existing host**.

#### Apple Silicon (`arm64`) — Always-On Host (`eta-host-darwin-arm64`)

```sh
WORK=$(mktemp -d /tmp/eta-host.XXXXXX)
cd "$WORK"
ASSET="eta-host-darwin-arm64"
curl -fsSLO "https://github.com/0xfe-project/eta/releases/latest/download/$ASSET"
curl -fsSLO "https://github.com/0xfe-project/eta/releases/latest/download/SHA256SUMS"
expected=$(awk -v f="$ASSET" '$2 == f { print $1 }' SHA256SUMS)
test -n "$expected" && printf '%s  %s\n' "$expected" "$ASSET" | shasum -a 256 -c -

mkdir -p ~/.local/share/eta/host
mv "$ASSET" ~/.local/share/eta/host/eta-host
chmod +x ~/.local/share/eta/host/eta-host
xattr -d com.apple.quarantine ~/.local/share/eta/host/eta-host 2>/dev/null || true
rm -rf "$WORK"

# Local-only:
~/.local/share/eta/host/eta-host install-service
# Or expose over Tailscale (enables token gate at ~/.eta/access-token):
# ~/.local/share/eta/host/eta-host install-service --host tailscale
```

#### Intel macOS (`x86_64`)

There are **no prebuilt `darwin-x86_64` binaries** for `eta-host` or `Eta.app`. Recommend:

- **Option 1:** Deploy `eta-host` via Docker Compose (`deploy/compose.yaml` in this repository) and open `http://127.0.0.1:8787`.
- **Option 2:** Run `eta-host` on a Linux server/VPS (Path B) and open its Web UI from macOS.

---

### 4.2 Windows (`x64`, PowerShell)

#### Desktop App (`eta-desktop-windows-x64.zip`)

1. Resolve `$ClientTag` (Step 3), download, verify SHA-256, unblock Mark-of-the-Web, extract to `$env:LOCALAPPDATA` (the archive has a top-level `Eta\` folder, so extracting to `$env:LOCALAPPDATA` places the app at `%LOCALAPPDATA%\Eta\Eta.exe` without nesting `Eta\Eta`), and launch:

   ```powershell
   $Work = Join-Path $env:TEMP "eta-install-$(Get-Random)"
   New-Item -ItemType Directory -Force -Path $Work | Out-Null
   Push-Location $Work

   $Asset = "eta-desktop-windows-x64.zip"
   Invoke-WebRequest -Uri "$ClientBase/$Asset" -OutFile $Asset
   Invoke-WebRequest -Uri "$ClientBase/SHA256SUMS" -OutFile "SHA256SUMS"
   $expected = (Select-String -Path .\SHA256SUMS -Pattern "\s+$([regex]::Escape($Asset))$" | Select-Object -First 1).Line.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0]
   if (-not $expected) { throw "Missing checksum entry for $Asset" }
   $actual = (Get-FileHash -Algorithm SHA256 ".\$Asset").Hash.ToLowerInvariant()
   if ($actual -ne $expected.ToLowerInvariant()) { throw "SHA-256 mismatch for $Asset" }

   Unblock-File ".\$Asset"
   Expand-Archive -Path ".\$Asset" -DestinationPath $env:LOCALAPPDATA -Force
   Get-ChildItem "$env:LOCALAPPDATA\Eta" -Recurse | Unblock-File

   Pop-Location
   Remove-Item -Recurse -Force $Work
   Start-Process "$env:LOCALAPPDATA\Eta\Eta.exe"
   ```

2. **Important user warning:** Because the binary is unsigned, Windows Defender SmartScreen may still show **"Windows protected your PC"**. Tell the user explicitly: click **More info → Run anyway**.

#### Always-On Host (`eta-host-windows-x64.exe`)

Keep the standalone host in `%LOCALAPPDATA%\eta-host` (writable by the user for upgrades, and distinct from `%LOCALAPPDATA%\Eta` on case-insensitive NTFS):

```powershell
$HostDir = "$env:LOCALAPPDATA\eta-host"
New-Item -ItemType Directory -Force -Path $HostDir | Out-Null
$Asset = "eta-host-windows-x64.exe"
$TempDir = Join-Path $env:TEMP "eta-host-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

Invoke-WebRequest -Uri "https://github.com/0xfe-project/eta/releases/latest/download/$Asset" -OutFile "$TempDir\$Asset"
Invoke-WebRequest -Uri "https://github.com/0xfe-project/eta/releases/latest/download/SHA256SUMS" -OutFile "$TempDir\SHA256SUMS"
$expected = (Select-String -Path "$TempDir\SHA256SUMS" -Pattern "\s+$([regex]::Escape($Asset))$" | Select-Object -First 1).Line.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)[0]
if (-not $expected) { throw "Missing checksum entry for $Asset" }
$actual = (Get-FileHash -Algorithm SHA256 "$TempDir\$Asset").Hash.ToLowerInvariant()
if ($actual -ne $expected.ToLowerInvariant()) { throw "SHA-256 mismatch for $Asset" }

Move-Item -Force "$TempDir\$Asset" "$HostDir\eta-host.exe"
Remove-Item -Recurse -Force $TempDir
Unblock-File "$HostDir\eta-host.exe"
```

- **Quick trial (no elevation):** `& "$env:LOCALAPPDATA\eta-host\eta-host.exe"`
- **Windows Service (requires Administrator terminal — ask user before elevating):**
  Run in an **Administrator** PowerShell window (registers `io.eta.host` under the current user account so agents inherit `git`, `gh`, `claude`, and `codex` logins; prompts once for the Windows password — use the Microsoft account password if signed in with one, not the PIN):

  ```powershell
  & "$env:LOCALAPPDATA\eta-host\eta-host.exe" install-service
  # Or bind to Tailscale:
  # & "$env:LOCALAPPDATA\eta-host\eta-host.exe" install-service --host tailscale
  ```

---

### 4.3 Linux (`x64`)

#### A. Always-On Host + Web UI (`eta-host-linux-x64`)

Best for headless servers, VPSs, older Linux distros, WSL, or pairing with the Flatpak desktop client.

```sh
WORK=$(mktemp -d /tmp/eta-host.XXXXXX)
cd "$WORK"
ASSET="eta-host-linux-x64"
curl -fsSLO "https://github.com/0xfe-project/eta/releases/latest/download/$ASSET"
curl -fsSLO "https://github.com/0xfe-project/eta/releases/latest/download/SHA256SUMS"
expected=$(awk -v f="$ASSET" '$2 == f { print $1 }' SHA256SUMS)
test -n "$expected" && printf '%s  %s\n' "$expected" "$ASSET" | sha256sum -c -

mkdir -p ~/.local/share/eta/host
mv "$ASSET" ~/.local/share/eta/host/eta-host
chmod +x ~/.local/share/eta/host/eta-host
rm -rf "$WORK"

# Register systemd user unit (io.eta.host):
~/.local/share/eta/host/eta-host install-service
# Or expose over Tailscale (auto-enables token gate at ~/.eta/access-token):
# ~/.local/share/eta/host/eta-host install-service --host tailscale
```

- **Headless / SSH servers:** Run `loginctl enable-linger "$USER"` so the systemd user service survives SSH logout (ask user before `sudo` if polkit prompts for privilege).
- **Quick trial without systemd:** Run `~/.local/share/eta/host/eta-host` directly in a terminal.

#### B. Desktop App — `.tar.gz` (`eta-desktop-linux-x64.tar.gz`)

Use when Step 1 confirmed `libgtk-4.so.1` and `libwebkitgtk-6.0.so.4` are present on the host OS. Supports in-app updates (**Settings → Update**) and **Run on this computer**.

```sh
WORK=$(mktemp -d /tmp/eta-client.XXXXXX)
cd "$WORK"
ASSET="eta-desktop-linux-x64.tar.gz"
curl -fsSLO "$CLIENT_BASE/$ASSET"
curl -fsSLO "$CLIENT_BASE/SHA256SUMS"
expected=$(awk -v f="$ASSET" '$2 == f { print $1 }' SHA256SUMS)
test -n "$expected" && printf '%s  %s\n' "$expected" "$ASSET" | sha256sum -c -

mkdir -p ~/.local/share/eta/client
tar -xzf "$ASSET" --strip-components=1 -C ~/.local/share/eta/client
rm -rf "$WORK"

# Verify shared libraries resolve before launching:
ldd ~/.local/share/eta/client/Eta | grep "not found" && echo "Missing shared libraries — use Flatpak or Host + Web UI instead" >&2
nohup ~/.local/share/eta/client/Eta >/dev/null 2>&1 &
```

#### C. Desktop App — Flatpak (`eta-desktop-linux-x64.flatpak`)

Use on Linux desktops when host GTK 4 / WebKitGTK 6.0 is missing or older. First verify `eta-desktop-linux-x64.flatpak` exists in `$CLIENT_BASE/SHA256SUMS` or release assets (Flatpak builds shipped in `desktop-v*` releases after `desktop-v0.1.0-rc.20`; if absent in the current release, fall back to `.tar.gz` or Host + Web UI).

1. Ensure `flatpak` is installed (ask before running `sudo apt install -y flatpak` / `dnf` / `pacman`).
2. Add the Flathub user remote (provides the `org.gnome.Platform//49` runtime), download, verify SHA-256, install, and launch:

   ```sh
   flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo

   WORK=$(mktemp -d /tmp/eta-flatpak.XXXXXX)
   cd "$WORK"
   ASSET="eta-desktop-linux-x64.flatpak"
   curl -fsSLO "$CLIENT_BASE/$ASSET"
   curl -fsSLO "$CLIENT_BASE/SHA256SUMS"
   expected=$(awk -v f="$ASSET" '$2 == f { print $1 }' SHA256SUMS)
   test -n "$expected" && printf '%s  %s\n' "$expected" "$ASSET" | sha256sum -c -

   flatpak install --user -y "$ASSET"
   rm -rf "$WORK"
   flatpak run dev.eta.client &
   ```

3. **Two Flatpak sandbox constraints to explain/handle:**
   - **Host connection:** Install `eta-host` directly on the OS (Section 4.3A) or on a remote server, then pick **Connect to an existing host** (`http://127.0.0.1:8787` or remote URL). Do **not** pick **Run on this computer** inside the Flatpak sandbox, because a host spawned inside the sandbox cannot access host workspaces, CLI tools, or systemd user services.
   - **Upgrades:** Flatpak mounts `/app` read-only, so in-app self-replacement is disabled; upgrade by downloading and running `flatpak install --user -y eta-desktop-linux-x64.flatpak` on the newer release.

#### D. Docker Compose (Linux / Intel macOS / Containerized Host)

`deploy/compose.yaml` builds from the repository context:

```sh
git clone https://github.com/0xfe-project/eta.git
cd eta
docker compose -f deploy/compose.yaml up -d --build
# Read the access token privately for the user:
docker compose -f deploy/compose.yaml exec eta cat /data/.eta/access-token
```

If exposing behind a reverse proxy (Caddy/Nginx/Traefik), set `ETA_ALLOW_ORIGIN=https://your.domain` so WebSocket upgrades on `/ws` and `/machines/connect` are accepted.

---

### 4.4 Mobile Companion (Android / iOS / HarmonyOS)

Mobile clients connect to a running `eta-host` (Path A/B/C) over LAN, Tailscale, or HTTPS reverse proxy.

- **Android (`eta-android.apk`):**
  - Signed with Eta's release key from `desktop-v0.1.0-rc.20` onward and supports signed OTA updates under **Settings → Update**.
  - If attached via USB/ADB: verify `SHA256SUMS`, then run `adb install -r eta-android.apk`. Otherwise give the user the verified `$CLIENT_BASE/eta-android.apk` download link.
  - **Upgrade note:** If the device has an older pre-`desktop-v0.1.0-rc.20` debug-signed APK installed, Android refuses an in-place signature change — tell the user to uninstall the old app once before installing the release APK.
  - Pair via host URL (`http://<addr>:8787`) or QR code from the host's Settings page.

- **iOS (`eta-ios.ipa`):**
  - Unsigned IPA (`Payload/Eta.app`). Sideload with AltStore / Sideloadly or re-sign with a personal Apple Developer profile.
  - **Zero-friction alternative:** Open the host's Web UI URL (`http://<tailscale-or-domain>:8787/?token=<token>`) in Mobile Safari and tap **Share → Add to Home Screen**.

- **HarmonyOS (`eta-harmonyos.hap`):**
  - Unsigned HAP (built with OpenHarmony 7.0 SDK). Sign with a developer certificate before installing on a device, or open the host's Web UI in a browser.

---

## Step 5 — Post-Install Verification & Troubleshooting

### 1. Health & Service Checks

```sh
# Health endpoint (returns HTTP 200 "ok", no token required):
curl -fsS http://127.0.0.1:8787/up

# Linux systemd user service status:
systemctl --user status io.eta.host --no-pager

# macOS LaunchAgent status:
launchctl list | grep io.eta.host
```

```powershell
# Windows service & health check:
Get-Service -Name "io.eta.host"
(Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8787/up").Content
```

If bound to Tailscale (`--host tailscale`), also check `curl -fsS "http://$(tailscale ip -4 | head -n1):8787/up"`.

### 2. Non-Loopback Access Token (Handle Privately!)

Whenever `eta-host` binds beyond `127.0.0.1` (e.g., `--host tailscale` or inside Docker), it automatically enforces a token gate backed by `~/.eta/access-token` (`0600`) — or `/data/.eta/access-token` in Docker.

- Read `~/.eta/access-token` locally and give the user their one-time browser sign-in URL privately:
  `http://<tailscale-or-host-ip>:8787/?token=<token>`
- Visiting that URL once exchanges the token for a session cookie. Never print the token in public logs, issues, or shared channels.

### 3. First 60 Seconds in the UI

Tell the user once verified:

1. Open **Settings → Model services** to sign in via device code (ChatGPT/Codex or Grok) or add OpenAI / Anthropic / Gemini / custom API keys. Local **Claude Code**, **Codex**, **Antigravity**, **OpenCode**, **Pi**, and **ACP** CLIs are auto-discovered.
2. Add specialist agents to a project war room or dispatch work onto the Task Board (isolated `git worktree` per task).
3. Pair mobile or secondary desktop clients from Settings via URL or QR code.

### 4. Troubleshooting Quick Reference

| Symptom                                               | Cause                                                               | Fix                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| macOS says `"Eta.app" is damaged and can't be opened` | Unsigned app still has Gatekeeper quarantine attribute              | Run `xattr -dr com.apple.quarantine /Applications/Eta.app` (or `xattr -d com.apple.quarantine` on `eta-host`) |
| Windows shows `"Windows protected your PC"`           | Unsigned binary triggers SmartScreen                                | Run `Unblock-File` recursively on extracted files; click **More info → Run anyway** on prompt                 |
| Linux `.tar.gz` fails with missing `.so` libraries    | Host distro lacks GTK 4 (`libgtk-4.so.1`) / `libwebkitgtk-6.0.so.4` | Switch to `eta-desktop-linux-x64.flatpak` (with OS `eta-host`) or Always-On Host + Web UI                     |
| Linux Flatpak cannot find git, CLIs, or host tools    | **Run on this computer** started host inside Flatpak sandbox        | Install `eta-host` directly on the OS (Step 4.3A) and choose **Connect to an existing host**                  |
| Browser / client gets `401 Unauthorized` remotely     | Non-loopback token gate is active                                   | Open `http://<addr>:8787/?token=<token>` using `~/.eta/access-token`                                          |
| Linux systemd host stops after closing SSH            | User systemd lingering disabled                                     | Run `loginctl enable-linger "$USER"`                                                                          |
| Reverse proxy WebSocket fails to connect              | `Host` / `Origin` header mismatch                                   | Pass `--allow-origin https://your.domain` or set `ETA_ALLOW_ORIGIN=https://your.domain`                       |
| Android refuses APK install over older build          | Pre-`desktop-v0.1.0-rc.20` APK used a temporary debug signature     | Uninstall the older debug-signed APK once, then install the release-signed APK                                |
