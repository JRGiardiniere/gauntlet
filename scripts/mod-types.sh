#!/bin/sh
# Claude Code's plugin API declarations for mod/ (#134). Claude Code writes
# them itself, beside each mod it loads, for the version installed; they are
# not vendored. This loads an empty probe mod headlessly (a local slash
# command, so no model turn) and copies what Claude Code wrote into
# mod/types/, which git ignores. Rerun after a Claude Code update.
#
#   sh scripts/mod-types.sh          write mod/types/claude-code*/
#   sh scripts/mod-types.sh --check  fail, naming this script, when missing
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
packages="claude-code claude-code-tools claude-code-mcp"

if [ "${1:-}" = "--check" ]; then
  for package in $packages; do
    if [ ! -f "$root/mod/types/$package/index.d.ts" ]; then
      echo "mod/types/$package is missing: run \`bun run mod-types\` (Claude Code writes the mod's plugin declarations)" >&2
      exit 1
    fi
  done
  exit 0
fi

probe=$(mktemp -d "${TMPDIR:-/tmp}/gauntlet-mod-types.XXXXXX")
trap 'rm -rf "$probe"' EXIT
mkdir -p "$probe/.claude-plugin" "$probe/hooks"
printf '{ "name": "gauntlet-mod-types", "version": "0.0.0" }\n' >"$probe/.claude-plugin/plugin.json"
printf '{ "modules": ["./register.ts"] }\n' >"$probe/hooks/hooks.json"
printf 'export const register = () => {}\n' >"$probe/hooks/register.ts"
(cd "$probe" && claude -p --no-session-persistence --strict-mcp-config --plugin-dir "$probe" /cost </dev/null >/dev/null)

for package in $packages; do
  written="$probe/.claude-plugin/types/$package/index.d.ts"
  if [ ! -f "$written" ]; then
    echo "Claude Code wrote no $package declarations into the probe mod" >&2
    exit 1
  fi
  mkdir -p "$root/mod/types/$package"
  cp "$written" "$root/mod/types/$package/index.d.ts"
done
echo "mod/types: $(head -1 "$root/mod/types/claude-code/index.d.ts")"
