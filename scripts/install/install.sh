#!/bin/sh
# Install eta (the terminal interface) and eta-host into $HOME/.eta/bin, from a GitHub release or
# from a directory that holds one. Run `sh install.sh --help` for the options.
#
# Needs a POSIX sh, awk, cat, chmod, cp, mkdir, mktemp, mv and rm; curl to download; one of
# sha256sum, `shasum -a 256` or `openssl dgst -sha256` to check what it got.

set -u

USER_AGENT=eta-install
DEFAULT_REPO=0xfe-project/eta
BUILDS="linux-x64 darwin-arm64"
BUILD_LIST="linux-x64, darwin-arm64"
VERSION_PATTERN='^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
# The tag of a host's release, in either case, as release.yml writes it; desktop-v0.1.0 is the app's.
HOST_TAG_PATTERN='^[vV][0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
GITHUB_REPO_PATTERN='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9_.-]+$'
# Spelled out, not [[:space:]]: an older dash knows no character classes in patterns.
WHITE_SPACE=$(printf ' \t\r\n\v\fx')
WHITE_SPACE=${WHITE_SPACE%x}

usage() {
  cat <<'EOF'
Usage: install.sh [--version <version>] [--repo <repository>] [--from <directory>] [--force] [--add-to-path] [--help]

Installs eta, the terminal interface, and eta-host into $HOME/.eta/bin.

  --version <version>  The release to install, such as 0.3.0.
                       Default: the newest full release of the host (a v* tag).
  --repo <repository>  owner/name, https://github.com/owner/name, or the API address of a server
                       that answers like GitHub's releases API.
                       Default: $ETA_RELEASES_URL, then 0xfe-project/eta.
  --from <directory>   Take eta-<platform>, eta-host-<platform> and SHA256SUMS from a directory
                       instead of downloading them.
  --force              Replace an eta-host of another version.
  --add-to-path        Add $HOME/.eta/bin to PATH in your shell's startup file.
  --help               Print this and exit.

A token for github.com is taken from GH_TOKEN, GITHUB_TOKEN or `gh auth token`; another server
gets ETA_RELEASES_TOKEN only.
EOF
}

say() { printf '%s\n' "$*"; }
warn() { printf 'eta install: %s\n' "$*" >&2; }
die() {
  warn "$*"
  exit 1
}
usage_error() {
  warn "$*"
  usage >&2
  exit 2
}

# Whether $1 matches the extended regular expression $2, as a whole.
matches() {
  awk 'BEGIN { exit !(ARGV[1] ~ ARGV[2]) }' "$1" "$2"
}

# Reads a release as GitHub's API writes it and prints `draft<TAB><value>` and `tag<TAB><tag>`
# for the release and `asset<TAB><name><TAB><url>` for each asset; a tag with a tab or a line
# break in it is left out. It follows the structure, so the `url` of an asset's uploader and
# text in the release notes are not taken for an asset's.
RELEASE_AWK='
function fail(why) { print why > "/dev/stderr"; failed = 1; exit 1 }
function unescape(s,    out, i, c) {
  out = ""
  while ((i = index(s, "\\")) > 0) {
    out = out substr(s, 1, i - 1)
    c = substr(s, i + 1, 1)
    if (c == "n") out = out "\n"
    else if (c == "t") out = out "\t"
    else if (c == "r") out = out "\r"
    else if (c == "u") { out = out "?"; s = substr(s, i + 6); continue }
    else if (c != "b" && c != "f") out = out c
    s = substr(s, i + 2)
  }
  return out s
}
function scalar(v) {
  if (depth == 1 && kind[1] == "o" && key[1] == "draft") draft = v
  if (depth == 1 && kind[1] == "o" && key[1] == "tag_name") tag = v
  if (depth == 3 && key[1] == "assets" && kind[2] == "a" && kind[3] == "o") {
    if (key[3] == "name") name[item[2]] = v
    if (key[3] == "url") url[item[2]] = v
  }
}
{ text = text $0 "\n" }
END {
  if (failed) exit 1
  depth = 0
  while (text != "") {
    if (match(text, /^[ \t\r\n]+/)) { text = substr(text, RLENGTH + 1); continue }
    c = substr(text, 1, 1)
    if (c == "\"") {
      if (!match(text, /^"([^"\\]|\\.)*"/)) fail("unterminated string")
      token = unescape(substr(text, 2, RLENGTH - 2))
      text = substr(text, RLENGTH + 1)
      if (depth > 0 && kind[depth] == "o" && want_key[depth]) { key[depth] = token; want_key[depth] = 0 }
      else scalar(token)
    } else if (c == "{" || c == "[") {
      depth++
      kind[depth] = (c == "{") ? "o" : "a"
      want_key[depth] = (c == "{")
      key[depth] = ""
      item[depth] = 0
      text = substr(text, 2)
    } else if (c == "}" || c == "]") {
      if (depth == 0) fail("unbalanced " c)
      depth--
      text = substr(text, 2)
    } else if (c == ",") {
      if (kind[depth] == "o") want_key[depth] = 1
      else item[depth]++
      text = substr(text, 2)
    } else if (c == ":") {
      text = substr(text, 2)
    } else if (match(text, /^[-+0-9.eEa-z]+/)) {
      scalar(substr(text, 1, RLENGTH))
      text = substr(text, RLENGTH + 1)
    } else {
      fail("unexpected " c)
    }
  }
  if (depth != 0 || kind[1] != "o") fail("not a JSON object")
  printf "draft\t%s\n", draft
  if (tag !~ /[\t\r\n]/) printf "tag\t%s\n", tag
  for (i in name) if (i in url) printf "asset\t%s\t%s\n", name[i], url[i]
}
'

# Reads the list of releases as GitHub's API writes it and prints the tag of the newest host
# release, or nothing when there is none. A host release has a tag that matches $ETA_HOST_TAG
# and has no `-`, and is neither a draft nor a pre-release; the newest has the highest numbers,
# compared part by part, and of two equal ones the later in the list. It follows the structure,
# so text in the release notes is not taken for a release.
#
# A page of the list runs to megabytes. Each line is cut at its quotes once, so the time grows
# with the length; taking it apart from the front, as RELEASE_AWK does, would grow with its square.
LIST_AWK='
function fail(why) { print why > "/dev/stderr"; failed = 1; exit 1 }
function without_leading_zeros(n) {
  n = n ""
  sub(/^0+/, "", n)
  return n == "" ? "0" : n
}
# Whether the version a (X.Y.Z) is the same as b or higher. Compared as text of equal length,
# so a number of any size compares as a number.
function at_least(a, b,    i, x, y, pa, pb) {
  split(a, pa, ".")
  split(b, pb, ".")
  for (i = 1; i <= 3; i++) {
    x = without_leading_zeros(pa[i])
    y = without_leading_zeros(pb[i])
    if (length(x) != length(y)) return length(x) > length(y)
    if (x != y) return x > y
  }
  return 1
}
function value(v, quoted) {
  if (depth == 0) fail("not a JSON array")
  if (depth != 2 || kind[1] != "a" || kind[2] != "o") return
  if (key[2] == "tag_name") tag = quoted ? v : ""
  else if (key[2] == "draft") draft = (!quoted && v == "true")
  else if (key[2] == "prerelease") prerelease = (!quoted && v == "true")
}
function release_ends() {
  if (tag !~ ENVIRON["ETA_HOST_TAG"] || index(tag, "-") || draft || prerelease) return
  if (newest == "" || at_least(substr(tag, 2), substr(newest, 2))) newest = tag
}
function token(t, quoted) {
  if (depth > 0 && kind[depth] == "o" && want_key[depth]) {
    if (!quoted) fail("a key that is not a string")
    key[depth] = t
    want_key[depth] = 0
  } else {
    value(t, quoted)
  }
}
# The text between two strings: brackets, commas, colons, numbers, true, false and null.
function between(text,    c) {
  while (text != "") {
    if (match(text, /^[ \t\r\n]+/)) { text = substr(text, RLENGTH + 1); continue }
    c = substr(text, 1, 1)
    if (c == "{" || c == "[") {
      depth++
      if (depth == 1) { tops++; top_kind = c }
      kind[depth] = (c == "{") ? "o" : "a"
      want_key[depth] = (c == "{")
      key[depth] = ""
      if (depth == 2 && kind[1] == "a" && c == "{") { tag = ""; draft = 0; prerelease = 0 }
    } else if (c == "}" || c == "]") {
      if (depth == 0 || (c == "}") != (kind[depth] == "o")) fail("unbalanced " c)
      if (depth == 2 && kind[1] == "a" && kind[2] == "o") release_ends()
      depth--
    } else if (c == ",") {
      if (depth > 0 && kind[depth] == "o") want_key[depth] = 1
    } else if (c != ":") {
      if (!match(text, /^[-+0-9.eEa-z]+/)) fail("unexpected " c)
      token(substr(text, 1, RLENGTH), 0)
      text = substr(text, RLENGTH + 1)
      continue
    }
    text = substr(text, 2)
  }
}
# A string cannot hold a line break, so every line starts outside one. A quote after an odd
# number of backslashes is part of the string.
{
  n = split($0, part, "\"")
  between(part[1])
  i = 2
  while (i <= n) {
    s = part[i]
    while (match(s, /\\+$/) && RLENGTH % 2 == 1) {
      if (++i > n) fail("unterminated string")
      s = s "\"" part[i]
    }
    if (i == n) fail("unterminated string")
    token(s, 1)
    between(part[i + 1])
    i += 2
  }
}
END {
  if (failed) exit 1
  if (depth != 0 || tops != 1 || top_kind != "[") fail("not a JSON array")
  if (newest != "") print newest
}
'

# --- the command line -----------------------------------------------------------------------

version=
version_given=
repo=
repo_given=
from=
from_given=
force=
add_to_path=
while [ $# -gt 0 ]; do
  case $1 in
    --help)
      usage
      exit 0
      ;;
    --force) force=1 ;;
    --add-to-path) add_to_path=1 ;;
    --version | --repo | --from)
      [ $# -ge 2 ] || usage_error "$1 needs a value"
      case $1 in
        --version) version=$2 version_given=1 ;;
        --repo) repo=$2 repo_given=1 ;;
        --from) from=$2 from_given=1 ;;
      esac
      shift
      ;;
    *) usage_error "unknown argument: $1" ;;
  esac
  shift
done

if [ -n "$version_given" ]; then
  version=${version#v}
  matches "$version" "$VERSION_PATTERN" ||
    usage_error "not a version: $version (write it as 0.3.0, v0.3.0 or 0.3.0-rc.1)"
fi

[ -n "${HOME:-}" ] || die "HOME is not set, and eta is installed under it"
bin_dir=$HOME/.eta/bin

# --- the platform ---------------------------------------------------------------------------

system=$(uname -s) || die "cannot tell the operating system: uname -s failed"
machine=$(uname -m) || die "cannot tell the processor: uname -m failed"
case $system in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW* | MSYS* | CYGWIN*) die "this is Windows ($system): run install.ps1 in PowerShell instead" ;;
  *) die "$system is not supported. There are builds for $BUILD_LIST." ;;
esac
case $machine in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) arch=$machine ;;
esac
# A shell under Rosetta reports x86_64 on an Apple silicon Mac, which runs the arm64 build.
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then
  arch=arm64
fi
platform=$os-$arch
case " $BUILDS " in
  *" $platform "*) ;;
  *) die "there is no build for $platform. There are builds for $BUILD_LIST." ;;
esac
tui_asset=eta-$platform
host_asset=eta-host-$platform
ASSETS="$tui_asset $host_asset SHA256SUMS"

# --- where the release comes from -----------------------------------------------------------

kind=
api=
api_origin=
label=
token=

not_a_repository() {
  die "not a repository: $1. Give owner/name, https://github.com/owner/name, or the http(s) address of a server that answers like GitHub's releases API."
}

# Sets kind, api and label from how the repository was given.
parse_repo() {
  given=$1
  case $given in
    *'?'* | *'#'*) not_a_repository "$given" ;;
  esac
  case $given in
    http://* | https://*)
      rest=${given#*://}
      case ${rest%%/*} in
        *@*) die "a repository address cannot carry a login: give the token in ETA_RELEASES_TOKEN (GH_TOKEN for github.com)" ;;
      esac
      ;;
  esac
  case $given in
    https://github.com | https://github.com/* | https://www.github.com | https://www.github.com/*)
      path=${given#https://}
      path=${path#*/}
      ;;
    https://api.github.com | https://api.github.com/*)
      path=${given#https://api.github.com}
      case $path in
        /repos/*) path=${path#/repos/} ;;
        *) not_a_repository "$given" ;;
      esac
      ;;
    http://* | https://*)
      kind=other
      api=$given
      while [ "${api%/}" != "$api" ]; do api=${api%/}; done
      label=$api
      return
      ;;
    *) path=$given ;;
  esac
  path=${path%/}
  path=${path%.git}
  matches "$path" "$GITHUB_REPO_PATTERN" || not_a_repository "$given"
  case ${path#*/} in
    . | ..) not_a_repository "$given" ;;
  esac
  kind=github
  api=https://api.github.com/repos/$path
  label=$path
}

# Sets token to $1 without the white space around it; $2 says where it came from. Dies unless
# what is left is printable ASCII without spaces, quotes or backslashes: the curl config that
# carries it would break on a quote or a backslash.
take_token() {
  token=$1
  while :; do
    case $token in
      ["$WHITE_SPACE"]*) token=${token#?} ;;
      *) break ;;
    esac
  done
  while :; do
    case $token in
      *["$WHITE_SPACE"]) token=${token%?} ;;
      *) break ;;
    esac
  done
  printf '%s' "$token" | LC_ALL=C awk '
    { lines++; if ($0 !~ /^[!-~]+$/ || index($0, "\"") || index($0, "\\")) bad = 1 }
    END { exit !(lines == 1 && !bad) }' ||
    die "the token from $2 cannot be used: a token is printable ASCII, without spaces, quotes or backslashes"
}

# Sets token: for github.com GH_TOKEN, GITHUB_TOKEN, then gh's; for another server
# ETA_RELEASES_TOKEN only. Empty when there is none.
choose_token() {
  token=
  if [ "$kind" = other ]; then
    if [ -n "${ETA_RELEASES_TOKEN:-}" ]; then take_token "$ETA_RELEASES_TOKEN" ETA_RELEASES_TOKEN; fi
    return
  fi
  if [ -n "${GH_TOKEN:-}" ]; then
    take_token "$GH_TOKEN" GH_TOKEN
  elif [ -n "${GITHUB_TOKEN:-}" ]; then
    take_token "$GITHUB_TOKEN" GITHUB_TOKEN
  elif command -v gh >/dev/null 2>&1; then
    from_gh=$(gh auth token --hostname github.com 2>/dev/null) || from_gh=
    if [ -n "$from_gh" ]; then take_token "$from_gh" gh; fi
  fi
}

# Prints the origin of the URL $1: scheme://host[:port] in lower case, without a default port.
origin_of() {
  awk -v url="$1" 'BEGIN {
    scheme = url; sub(/:\/\/.*$/, "", scheme); scheme = tolower(scheme)
    authority = url; sub(/^[^:]*:\/\//, "", authority); sub(/[\/?#].*$/, "", authority)
    sub(/^.*@/, "", authority); authority = tolower(authority)
    if ((scheme == "https" && authority ~ /:443$/) || (scheme == "http" && authority ~ /:80$/))
      sub(/:[0-9]+$/, "", authority)
    print scheme "://" authority
  }'
}

# --- HTTP -----------------------------------------------------------------------------------

status=

# curl reads the header from stdin, so the token is in no process's arguments. Every curl here
# starts with -q, which curl takes only as the first argument: it then reads no ~/.curlrc,
# whose options could change where requests go or print the header.
token_config() {
  printf 'header = "Authorization: Bearer %s"\n' "$token"
}

# curl writes its complaint to a file, so every line on stderr starts with `eta install: `.
curl_failed() {
  complaint=$(awk '{ sub(/\r$/, ""); printf "%s%s", (NR > 1 ? " " : ""), $0 }' "$work/curl-error" 2>/dev/null)
  die "could not download $1 (curl exited with $2: ${complaint:-no message})"
}

# GET $1 into the file $3 with `Accept: $2`; sets status. The token goes to $1 only, and only
# when $1 is on the API's origin. A redirect is followed by a request without it: the signed
# address it leads to refuses a request that carries one, and must not see it.
http_get() {
  get_url=$1
  get_accept=$2
  get_out=$3
  if [ -n "$token" ] && [ "$(origin_of "$get_url")" = "$api_origin" ]; then
    token_config | curl -q -sS --stderr "$work/curl-error" -o "$get_out" -D "$work/headers" -w '%{http_code}' \
      -H "Accept: $get_accept" -H "User-Agent: $USER_AGENT" --config - \
      --url "$get_url" >"$work/status" || curl_failed "$get_url" $?
  else
    curl -q -sS --stderr "$work/curl-error" -o "$get_out" -D "$work/headers" -w '%{http_code}' \
      -H "Accept: $get_accept" -H "User-Agent: $USER_AGENT" \
      --url "$get_url" >"$work/status" || curl_failed "$get_url" $?
  fi
  status=$(cat "$work/status")
  case $status in
    3??) ;;
    *) return 0 ;;
  esac
  location=$(awk '{
    line = $0; sub(/\r$/, "", line)
    if (tolower(substr(line, 1, 9)) == "location:") { value = substr(line, 10); sub(/^[ \t]+/, "", value); found = value }
  } END { print found }' "$work/headers")
  case $location in
    http://* | https://*) ;;
    /*)
      rest=${get_url#*://}
      location=${get_url%%://*}://${rest%%/*}$location
      ;;
    *) die "$get_url answered $status without a usable Location" ;;
  esac
  curl -q -sS --stderr "$work/curl-error" -L -o "$get_out" -D "$work/headers" -w '%{http_code}' \
    -H "Accept: $get_accept" -H "User-Agent: $USER_AGENT" \
    --url "$location" >"$work/status" || curl_failed "$get_url" $?
  status=$(cat "$work/status")
}

# Dies unless the last request succeeded; $1 says what was asked for.
expect_success() {
  case $status in
    2??) return 0 ;;
  esac
  hint=
  if [ -z "$token" ]; then
    case $status in
      401 | 403 | 404)
        if [ "$kind" = github ]; then
          hint=" ($label may be a private repository: run \`gh auth login\` or set GH_TOKEN)"
        else
          hint=" (if the releases on this server are private: set ETA_RELEASES_TOKEN)"
        fi
        ;;
    esac
  fi
  die "$1: the server answered $status$hint"
}

# Dies unless the last request brought a release; writes what RELEASE_AWK makes of it to
# $work/assets.
read_release() {
  expect_success "$what"
  awk "$RELEASE_AWK" "$work/release.json" >"$work/assets" 2>/dev/null ||
    die "$what: the answer is not a release as GitHub's API writes it"
}

# Reads into $work/assets the newest published host release that is not a pre-release, and sets
# what to name it. GitHub's latest release is that, unless it is the desktop app's or a draft,
# or there is none; then it is the newest host release in the first page of the list. The rule
# is Releases.latest() in packages/releases, which eta-host upgrade and the desktop app follow.
choose_latest_release() {
  http_get "$api/releases/latest" application/vnd.github+json "$work/release.json"
  if [ "$status" != 404 ]; then
    read_release
    latest_tag=$(awk -F '\t' '$1 == "tag" { print $2 }' "$work/assets")
    latest_draft=$(awk -F '\t' '$1 == "draft" { print $2 }' "$work/assets")
    if matches "$latest_tag" "$HOST_TAG_PATTERN" && [ "$latest_draft" != true ]; then
      return 0
    fi
  fi
  http_get "$api/releases?per_page=100" application/vnd.github+json "$work/releases.json"
  expect_success "$what"
  newest_tag=$(ETA_HOST_TAG=$HOST_TAG_PATTERN awk "$LIST_AWK" "$work/releases.json" 2>/dev/null) ||
    die "$what: the answer is not a list of releases as GitHub's API writes it"
  [ -n "$newest_tag" ] ||
    die "$what: $label has no host release (a v* tag). Give --version <version> to install a release by its version."
  what="$newest_tag of $label"
  http_get "$api/releases/tags/$newest_tag" application/vnd.github+json "$work/release.json"
  read_release
}

# Downloads the three files of the release into $work.
download_release() {
  parse_repo "$1"
  api_origin=$(origin_of "$api")
  command -v curl >/dev/null 2>&1 || die "curl is needed to download the release: install curl, or give --from <directory>"
  choose_token
  if [ -n "$version_given" ]; then
    what="v$version of $label"
    http_get "$api/releases/tags/v$version" application/vnd.github+json "$work/release.json"
    read_release
  else
    what="the latest release of $label"
    choose_latest_release
  fi
  draft=$(awk -F '\t' '$1 == "draft" { print $2 }' "$work/assets")
  [ "$draft" != true ] || die "$what is a draft, not a published release"
  missing=
  for asset in $ASSETS; do
    asset_url=$(awk -F '\t' -v name="$asset" '$1 == "asset" && $2 == name { print $3; exit }' "$work/assets")
    [ -n "$asset_url" ] || missing="$missing $asset"
  done
  [ -z "$missing" ] || die "$what does not have:$missing"
  for asset in $ASSETS; do
    asset_url=$(awk -F '\t' -v name="$asset" '$1 == "asset" && $2 == name { print $3; exit }' "$work/assets")
    http_get "$asset_url" application/octet-stream "$work/$asset"
    expect_success "$asset"
  done
}

# Copies the three files from the directory $1 into $work.
copy_release() {
  missing=
  for asset in $ASSETS; do
    [ -f "$1/$asset" ] || missing="$missing $asset"
  done
  [ -z "$missing" ] || die "$1 does not have:$missing"
  for asset in $ASSETS; do
    cp "$1/$asset" "$work/$asset" || die "could not copy $1/$asset"
  done
}

# --- checking -------------------------------------------------------------------------------

hash_tool=
choose_hash_tool() {
  for tool in sha256sum shasum openssl; do
    if command -v "$tool" >/dev/null 2>&1; then
      hash_tool=$tool
      return
    fi
  done
  die "nothing here computes SHA-256: install sha256sum (coreutils), shasum or openssl"
}

# Prints the SHA-256 of the file $1, in lower case.
sha256_of() {
  case $hash_tool in
    sha256sum) sha256sum <"$1" >"$work/hash" ;;
    shasum) shasum -a 256 <"$1" >"$work/hash" ;;
    openssl) openssl dgst -sha256 <"$1" >"$work/hash" ;;
  esac || die "$hash_tool failed on $1"
  if [ "$hash_tool" = openssl ]; then
    awk '{ print tolower($NF); exit }' "$work/hash"
  else
    awk '{ sub(/^\\/, "", $1); print tolower($1); exit }' "$work/hash"
  fi
}

# Prints the SHA-256 that SHA256SUMS gives for the name $1, in lower case, or nothing.
listed_sha256() {
  awk -v name="$1" '{
    line = $0; sub(/\r$/, "", line)
    hex = substr(line, 1, 64); mark = substr(line, 66, 1)
    if (length(hex) == 64 && hex !~ /[^0-9A-Fa-f]/ && substr(line, 65, 1) == " " && (mark == " " || mark == "*") && substr(line, 67) == name) {
      print tolower(hex); exit
    }
  }' "$work/SHA256SUMS"
}

verify_sums() {
  problems=
  for asset in $tui_asset $host_asset; do
    listed=$(listed_sha256 "$asset")
    if [ -z "$listed" ]; then
      problems="$problems SHA256SUMS has no line for $asset."
    elif [ "$(sha256_of "$work/$asset")" != "$listed" ]; then
      problems="$problems $asset does not match its SHA-256 in SHA256SUMS."
    fi
  done
  [ -z "$problems" ] || die "the download is not the release that was published:$problems Nothing was installed."
}

# --- PATH -----------------------------------------------------------------------------------

on_path() {
  case ":${PATH:-}:" in
    *":$bin_dir:"*) return 0 ;;
  esac
  return 1
}

# Sets profile (the startup file), profile_shown (it under ~) and path_line (what goes in it).
choose_profile() {
  path_line='export PATH="$HOME/.eta/bin:$PATH"'
  shell_name=${SHELL:-}
  shell_name=${shell_name##*/}
  case $shell_name in
    zsh) profile_shown='~/.zshrc' ;;
    bash) if [ "$os" = darwin ]; then profile_shown='~/.bash_profile'; else profile_shown='~/.bashrc'; fi ;;
    fish)
      profile_shown='~/.config/fish/conf.d/eta.fish'
      path_line='fish_add_path -g "$HOME/.eta/bin"'
      ;;
    *) profile_shown='~/.profile' ;;
  esac
  profile=$HOME/${profile_shown#\~/}
}

# Whether the file $1 has a line that is exactly $2.
has_line() {
  [ -f "$1" ] && awk -v line="$2" '$0 == line { found = 1 } END { exit !found }' "$1"
}

# Whether the file $1 is empty or ends with a newline.
ends_with_newline() {
  [ -s "$1" ] || return 0
  content=$(cat "$1" && printf x) || return 0
  content=${content%x}
  [ "${content%"
"}" != "$content" ]
}

advise_path() {
  on_path && return 0
  choose_profile
  if [ -z "$add_to_path" ]; then
    say ""
    say "$bin_dir is not on your PATH. To put it there, add this line to $profile_shown:"
    say "  $path_line"
    say "or run the installer again with --add-to-path."
    return 0
  fi
  if ! has_line "$profile" "$path_line"; then
    mkdir -p "${profile%/*}" || die "could not create ${profile%/*}"
    if ! ends_with_newline "$profile"; then printf '\n' >>"$profile" || die "could not write $profile"; fi
    printf '%s\n' "$path_line" >>"$profile" || die "could not write $profile"
  fi
  say ""
  say "$profile_shown puts $bin_dir on your PATH. Open a new terminal, or run this in the current one:"
  say "  $path_line"
}

# --- main -----------------------------------------------------------------------------------

work=
cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [ -z "$from_given" ]; then
  if [ -n "$repo_given" ]; then
    :
  elif [ -n "${ETA_RELEASES_URL:-}" ]; then
    repo=$ETA_RELEASES_URL
  else
    repo=$DEFAULT_REPO
  fi
  # Refuses an address it cannot read before anything is created.
  parse_repo "$repo"
fi
choose_hash_tool

mkdir -p "$bin_dir" || die "could not create $bin_dir"
work=$(mktemp -d "$bin_dir/.install.XXXXXX") || die "could not create a temporary directory in $bin_dir"

if [ -n "$from_given" ]; then
  copy_release "$from"
else
  download_release "$repo"
fi
verify_sums

chmod 755 "$work/$tui_asset" "$work/$host_asset" || die "could not make the downloaded files executable"
new_version=$("$work/$host_asset" --version 2>&1)
new_status=$?
case $new_version in
  "eta-host "*) ;;
  *) new_status=1 ;;
esac
[ "$new_status" -eq 0 ] ||
  die "the downloaded eta-host does not run on this machine, so nothing was installed. It said: $new_version"

tui_target=$bin_dir/eta
host_target=$bin_dir/eta-host
host_action=install
old_version=
if [ -e "$host_target" ] || [ -L "$host_target" ]; then
  old_version=$("$host_target" --version 2>&1)
  old_status=$?
  if [ "$old_status" -eq 0 ] && [ "$old_version" = "$new_version" ]; then
    host_action=same
  elif [ -n "$force" ]; then
    host_action=replace
  else
    host_action=keep
  fi
  if [ "$old_status" -ne 0 ]; then
    old_version="an eta-host that does not run (${old_version:-no output})"
  fi
fi

# A rename within one file system: a process running the old file keeps it.
mv -f "$work/$tui_asset" "$tui_target" || die "could not put eta in $tui_target"
case $host_action in
  install | replace)
    mv -f "$work/$host_asset" "$host_target" || die "could not put eta-host in $host_target"
    ;;
esac

say "Installed into $bin_dir:"
say "  $tui_target"
case $host_action in
  install) say "  $host_target ($new_version)" ;;
  same) say "  $host_target is already $new_version, and was left as it is" ;;
  replace)
    say "  $host_target ($new_version), replacing $old_version"
    say "An eta-host that is running goes on with the old file until it restarts."
    ;;
  keep)
    say "  $host_target was left as it is ($old_version)"
    warn "$host_target was left as it is: it is $old_version, and this release has $new_version."
    warn "To upgrade it, run \`eta-host upgrade\`: it backs up the database, restarts the service, and rolls back if anything fails."
    warn "To replace the file instead, run the installer again with --force."
    ;;
esac

advise_path
