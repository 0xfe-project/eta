# Sourced by generated Git hooks from the worktree root. Resolve the local
# dependency so shared hooks never use another worktree's lefthook binary.
axp_top="$(git rev-parse --show-toplevel 2>/dev/null)" || axp_top=""
axp_lefthook="${axp_top:+$axp_top/node_modules/lefthook/bin/index.js}"

axp_pick() {
  for axp_candidate in "$@"; do
    if [ -f "$axp_candidate" ]; then
      axp_lefthook="$axp_candidate"
      return 0
    fi
  done
  return 1
}

case "$(uname -s 2>/dev/null)" in
  MINGW* | MSYS* | CYGWIN*)
    if [ -n "$axp_top" ]; then
      case "$(uname -m 2>/dev/null)" in
        aarch64 | arm64) axp_arch="arm64" ;;
        x86_64 | amd64) axp_arch="x64" ;;
        *) axp_arch="*" ;;
      esac
      axp_pick "$axp_top"/node_modules/lefthook-windows-"$axp_arch"/bin/lefthook.exe ||
        axp_pick "$axp_top"/node_modules/.bun/lefthook-windows-"$axp_arch"@*/node_modules/lefthook-windows-"$axp_arch"/bin/lefthook.exe ||
        axp_pick "$axp_top"/node_modules/lefthook-windows-*/bin/lefthook.exe ||
        axp_pick "$axp_top"/node_modules/.bun/lefthook-windows-*/node_modules/lefthook-windows-*/bin/lefthook.exe ||
        axp_pick "$axp_top/node_modules/.bin/lefthook.exe" ||
        true
      unset axp_arch
    fi
    ;;
esac

unset -f axp_pick
unset axp_candidate axp_top

if [ ! -f "$axp_lefthook" ]; then
  echo "AXP: lefthook is missing in this worktree; commit checks cannot run." >&2
  echo "Run ni (or bun install) in the repository root, then retry the commit." >&2
  exit 1
fi
export LEFTHOOK_BIN="$axp_lefthook"
unset axp_lefthook
