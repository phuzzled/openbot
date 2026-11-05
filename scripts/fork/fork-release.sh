#!/bin/bash
# The release steps of this fork (phuzzled/openbot). .github/workflows/fork-sync.yml and
# fork-release.yml run it. See FORK-DEPLOY.md.
#
#   fork-release.sh upstream-latest   The tag of the latest upstream release, from the GitHub API.
#   fork-release.sh fetch-upstream    Fetches the upstream release tags to refs/upstream-tags/* and
#                                     upstream main to refs/upstream/main. The fork tags stay apart.
#   fork-release.sh base [ref]        The newest upstream release tag that ref contains.
#   fork-release.sh fork-tag [ref]    The fork release tag on ref, or nothing.
#   fork-release.sh version [ref]     The fork version for ref: its tag, or the next free one.
#   fork-release.sh unit-tests [ref]  The test files that fork commits touched and that ref has.
#                                     Commits of upstream main (after fetch-upstream) are not fork
#                                     commits.
#   fork-release.sh check-feed        Fails when an update feed of the server names upstream.
#
# Version scheme. The installer, the hosted updater and the release manifest accept X.Y.Z only. A
# fork release on upstream X.Y.Z is X.Y.P with P = (Z + 1) * 1000 + N, and N = 1..999 counts the
# fork releases on that base. So upstream 0.60.0 gives 0.60.1001, 0.60.1002; upstream 0.60.3 gives
# 0.60.4001; upstream 0.61.0 gives 0.61.1001. Each fork release is newer than its upstream release
# and than each fork release before it, and it has no upstream version.
set -euo pipefail
export LC_ALL=C

UPSTREAM=${FORK_UPSTREAM:-nightly-labs/openbot}
STRICT='^v[0-9]+\.[0-9]+\.[0-9]+$'

fail() {
  echo "$*" >&2
  exit 1
}

# Succeeds when $1 is a newer version than $2, as `newer` in scripts/hosting/openbot-hosted-update.
newer() {
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | tail -n 1)" = "$1" ]
}

# A fork version has a patch of 1001 or more.
is_fork_tag() {
  [[ $1 =~ $STRICT ]] && [ "${1##*.}" -ge 1001 ]
}

upstream_latest() {
  local tag
  tag=$(gh api "repos/$UPSTREAM/releases/latest" --jq .tag_name)
  [[ $tag =~ $STRICT ]] || fail "The latest upstream release has no valid tag: $tag"
  echo "$tag"
}

fetch_upstream() {
  git fetch --quiet --no-tags "https://github.com/$UPSTREAM.git" \
    '+refs/tags/v*:refs/upstream-tags/v*' '+refs/heads/main:refs/upstream/main'
}

base() {
  local ref=${1:-HEAD} tag
  while read -r tag; do
    [[ $tag =~ $STRICT ]] || continue
    if git merge-base --is-ancestor "refs/upstream-tags/$tag^{commit}" "$ref"; then
      echo "$tag"
      return 0
    fi
  done < <(git for-each-ref --format='%(refname:strip=2)' refs/upstream-tags | sort -rV)
  fail "$ref contains no upstream release. Run: $0 fetch-upstream"
}

fork_tag() {
  local ref=${1:-HEAD} tag
  while read -r tag; do
    if is_fork_tag "$tag"; then
      echo "$tag"
      return 0
    fi
  done < <(git tag --points-at "$ref" | sort -rV)
  return 0
}

version() {
  local ref=${1:-HEAD} tag base_tag major minor patch low high highest="" count=0 next a b c
  tag=$(fork_tag "$ref")
  if [ -n "$tag" ]; then
    echo "${tag#v}"
    return 0
  fi
  base_tag=$(base "$ref")
  IFS=. read -r major minor patch <<<"${base_tag#v}"
  low=$(((patch + 1) * 1000 + 1))
  high=$(((patch + 1) * 1000 + 999))
  while read -r tag; do
    is_fork_tag "$tag" || continue
    if [ -z "$highest" ] || newer "${tag#v}" "$highest"; then highest=${tag#v}; fi
    IFS=. read -r a b c <<<"${tag#v}"
    if [ "$a" = "$major" ] && [ "$b" = "$minor" ] && [ "$c" -ge "$low" ] && [ "$c" -le "$high" ] && [ "$c" -gt "$count" ]; then
      count=$c
    fi
  done < <(git tag --list 'v*')
  if [ "$count" -eq 0 ]; then next=$low; else next=$((count + 1)); fi
  [ "$next" -le "$high" ] || fail "No free fork version is left on $base_tag."
  next="$major.$minor.$next"
  # A server only moves to a newer version, so each release must be newer than each one before it.
  if [ -n "$highest" ] && ! newer "$next" "$highest"; then
    fail "The next fork version $next is not newer than the fork release $highest."
  fi
  echo "$next"
}

# Files that fork commits (not in the upstream release that ref is on, nor in upstream main) added or
# changed, and that ref still has.
unit_tests() {
  local ref=${1:-HEAD} base_tag file not
  base_tag=$(base "$ref")
  not=("refs/upstream-tags/$base_tag")
  if git rev-parse --verify --quiet refs/upstream/main >/dev/null; then not+=(refs/upstream/main); fi
  git log --no-merges --format= --name-only --diff-filter=AMR "$ref" --not "${not[@]}" |
    sort -u | grep -E '\.test\.tsx?$' | while read -r file; do
    if git cat-file -e "$ref:$file" 2>/dev/null; then echo "$file"; fi
  done
}

check_feed() {
  local found
  found=$(grep -nE 'nightly-labs/openbot/releases|^  owner: nightly-labs' \
    electron-builder.yml scripts/install-server.sh scripts/hosting/openbot-hosted-update \
    scripts/hosting/openbot-server-setup src/main/host-release-service.ts src/main/hosted-update-adapter.ts || true)
  [ -z "$found" ] || fail "An update feed of the server names upstream:
$found"
}

case ${1:-} in
  upstream-latest) upstream_latest ;;
  fetch-upstream) fetch_upstream ;;
  base) base "${2:-HEAD}" ;;
  fork-tag) fork_tag "${2:-HEAD}" ;;
  version) version "${2:-HEAD}" ;;
  unit-tests) unit_tests "${2:-HEAD}" ;;
  check-feed) check_feed ;;
  *) fail "usage: $0 upstream-latest|fetch-upstream|base|fork-tag|version|unit-tests|check-feed [ref]" ;;
esac
