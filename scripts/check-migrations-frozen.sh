#!/usr/bin/env bash
# A migration that went out in a `v*` tag, pre-release tags included, may not be renamed, removed or
# edited: a host that ran it holds every later build to it (docs/release.md, "Pre-releases").
#
#   scripts/check-migrations-frozen.sh [<previous tag>] [<commit>]
#
# Compares apps/eta/src/migrations/ at <commit> (HEAD) with the previous tag: by default the
# highest `v*` tag below $TAG (the tag being released), or below none when $TAG is unset. Each file
# there must be at <commit> under the same name with the same blob, which is a hash of its content.
# Needs the tags fetched.
set -euo pipefail

DIR=apps/eta/src/migrations
commit=${2:-HEAD}
previous=${1:-}

if [[ -z $previous ]]; then
  current=${TAG:-}
  # `-` sorts before its release (v0.3.0-rc.1 < v0.3.0), as semver has it.
  while read -r tag; do
    [[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || continue
    [[ $tag == "$current" ]] && break
    previous=$tag
  done < <(git -c versionsort.suffix=- tag --list 'v*' --sort=v:refname)
fi
if [[ -z $previous ]]; then
  echo "No earlier v* tag: nothing to hold the migrations to."
  exit 0
fi

echo "Holding $DIR at $(git rev-parse --short "$commit") to $previous."
broken=0
while read -r _mode _type blob path; do
  now=$(git rev-parse -q --verify "$commit:$path" || true)
  if [[ -z $now ]]; then
    echo "::error file=$path::$path is in $previous and gone or renamed here. Put it back and add a new migration instead."
    broken=1
  elif [[ $now != "$blob" ]]; then
    echo "::error file=$path::$path changed since $previous. Put it back and add a new migration instead."
    broken=1
  fi
done < <(git ls-tree -r "$previous" -- "$DIR/")
if [[ $broken != 0 ]]; then
  echo "A migration that went out in a tag stays as it is: hosts that ran it would refuse every later build, or quietly not run the change."
  exit 1
fi
echo "Every migration in $previous is here as it was."
