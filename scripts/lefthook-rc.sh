# Sourced by generated Git hooks from the worktree root. Resolve the local
# dependency so shared hooks never use another worktree's lefthook binary.
axp_lefthook="$(git rev-parse --show-toplevel)/node_modules/lefthook/bin/index.js"
if [ ! -f "$axp_lefthook" ]; then
  echo "AXP: lefthook is missing in this worktree; commit checks cannot run." >&2
  echo "Run ni (or bun install) in the repository root, then retry the commit." >&2
  exit 1
fi
export LEFTHOOK_BIN="$axp_lefthook"
unset axp_lefthook
