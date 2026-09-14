#!/usr/bin/env bash
# Brings the latest r2-lfs release into a repository made by the Deploy to Cloudflare button.
#
# Such a repository starts as a copy without r2-lfs's history, so a merge has nothing in common to work
# from. Instead this applies the changes between the release the copy has (package.json's version) and the
# latest release, with a three-way merge where both sides changed the same lines, such as wrangler.jsonc.
#
# Leaves the result committed on a new branch and writes to $GITHUB_OUTPUT:
#   version    the release applied, empty when already up to date
#   branch     the branch with the commit
#   conflicts  files left with conflict markers, space-separated
#   workflows  files under .github/workflows the release changed, which GITHUB_TOKEN may not push
set -euo pipefail

upstream="${UPSTREAM_URL:-https://github.com/ken109/r2-lfs.git}"

output() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >>"$GITHUB_OUTPUT"; fi
}

# Upstream tags go to their own namespace so they never mix with this repository's tags.
git fetch --quiet --no-tags "$upstream" '+refs/tags/v*:refs/r2-lfs-upstream/v*'
latest=$(git for-each-ref --format='%(refname:strip=2)' 'refs/r2-lfs-upstream/' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -n 1 || true)
current="v$(node -p 'require("./package.json").version')"

if [ -z "$latest" ] || [ "$(printf '%s\n%s\n' "$current" "$latest" | sort -V | tail -n 1)" = "$current" ]; then
  echo "r2-lfs $current is the latest release"
  output version ""
  exit 0
fi
if ! git rev-parse --quiet --verify "refs/r2-lfs-upstream/$current" >/dev/null; then
  echo "package.json says $current, which is not an r2-lfs release; cannot tell what to apply" >&2
  exit 1
fi

from="refs/r2-lfs-upstream/$current"
to="refs/r2-lfs-upstream/$latest"
branch="r2-lfs-upgrade/$latest"
git switch --quiet -c "$branch"

patch=$(mktemp)
git diff --binary "$from" "$to" -- . ':(exclude).github/workflows' >"$patch"
workflows=$(git diff --name-only "$from" "$to" -- .github/workflows | tr '\n' ' ')

# Exits non-zero when some hunks conflict; those files keep the markers and are listed below.
git apply --3way --index "$patch" || true
conflicts=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
if [ -z "$conflicts" ] && git diff --cached --quiet; then
  echo "applying the changes from $current to $latest changed nothing; the patch may not have applied" >&2
  exit 1
fi
git add -A
git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet --no-verify -m "chore: upgrade r2-lfs from $current to $latest"
rm -f "$patch"

output version "$latest"
output branch "$branch"
output conflicts "${conflicts% }"
output workflows "${workflows% }"
