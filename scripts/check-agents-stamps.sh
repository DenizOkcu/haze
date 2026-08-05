#!/usr/bin/env bash
# Verify that every AGENTS.md "Last updated: <date>" stamp matches the date of
# the most recent commit that touched the file. Stamps are manual but enforced:
# a contributor who edits an AGENTS.md without refreshing the stamp fails CI.
#
# Usage: scripts/check-agents-stamps.sh
# Exits non-zero if any stamp is stale or missing.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

stale=0

# Use a temp file so the per-file loop runs in this shell (and can increment
# `stale`). macOS ships bash 3.x without mapfile; this stays portable.
files_tmp="$(mktemp)"
trap 'rm -f "$files_tmp"' EXIT
find . -name AGENTS.md -not -path './node_modules/*' -not -path './dist/*' > "$files_tmp"

while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue
  if ! grep -q '^Last updated:' "$file"; then
    continue
  fi
  stamped=$(grep -oE '^Last updated: [0-9]{4}-[0-9]{2}-[0-9]{2}' "$file" | head -1 | awk '{print $3}')
  if [ -z "$stamped" ]; then
    echo "MISSING date in: $file"
    stale=$((stale + 1))
    continue
  fi
  committed=$(git log -1 --format=%cd --date=short -- "$file" 2>/dev/null || echo "")
  if [ -z "$committed" ]; then
    continue
  fi
  if [ "$stamped" != "$committed" ]; then
    echo "STALE stamp in $file: stamp=$stamped last_commit=$committed"
    stale=$((stale + 1))
  fi
done < "$files_tmp"

if [ "$stale" -ne 0 ]; then
  echo "::error::$stale AGENTS.md stamp(s) need refresh (see above)"
  exit 1
fi

echo "All AGENTS.md stamps are fresh."
