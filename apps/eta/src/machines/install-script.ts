/**
 * The script a new machine runs to install the daemon: `curl -fsSL <primary>/machines/install.sh?code=<code> | sh`.
 *
 * It does on the machine what `install.ts` does over SSH: tell the platform by `uname`, fetch the
 * build this primary carries for it (with the install code, which the download checks but does
 * not use up), keep it as `~/.eta/bin/eta-daemon`, register with the code (`setup --no-wait`) and
 * install the user service. The primary's address in it is the one the script was fetched from,
 * so the machine dials back the way it came.
 */
import { INSTALL_DOWNLOAD_PATH } from "@eta/client-contracts";

/** Quoted for a POSIX shell. */
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** The command the user is told to run. */
export function installCommand(origin: string, code: string): string {
  return `curl -fsSL '${origin}/machines/install.sh?code=${code}' | sh`;
}

export function installScript(origin: string, code: string): string {
  return `#!/bin/sh
# Installs eta-daemon from the eta host at ${origin}.
set -eu
origin=${quote(origin)}
code=${quote(code)}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "eta: the daemon runs on Linux and macOS, not $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "eta: the daemon is built for x64 and arm64, not $(uname -m)" >&2; exit 1 ;;
esac

bin="$HOME/.eta/bin"
mkdir -p "$bin"
echo "Downloading eta-daemon ($os-$arch) from $origin ..."
curl -fsSL "$origin${INSTALL_DOWNLOAD_PATH}/$os-$arch?code=$code" -o "$bin/eta-daemon.part"
chmod 755 "$bin/eta-daemon.part"
mv -f "$bin/eta-daemon.part" "$bin/eta-daemon"

"$bin/eta-daemon" setup "$origin" "$code" --no-wait
"$bin/eta-daemon" install-service
# User services outlive the login only with lingering; a refusal is not a failure.
if [ "$os" = linux ] && command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$(id -un)" 2>/dev/null || true
fi
echo "Done. If the eta host asks, compare the fingerprint above with the one it shows."
`;
}
