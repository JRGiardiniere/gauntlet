#!/bin/sh
# The gc-cli mod's plugin tests (#135): builds both plugins into a scratch
# folder and runs each plugin's tests/ under `claude plugin test`, in the
# environment its hooks run in.
set -eu

repo_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/gauntlet-mod-test.XXXXXX")"
trap 'rm -rf "$root"' 0 1 2 15

(cd "$repo_root" && bun scripts/build-mod.ts "$root" > /dev/null)
for plugin in "$root"/*/; do
  if [ -d "$plugin/tests" ]; then claude plugin test "$plugin"; fi
done
