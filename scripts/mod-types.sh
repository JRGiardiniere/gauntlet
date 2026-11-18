#!/bin/sh
# Claude Code's plugin API declarations for mod/ (#134). Claude Code writes
# them itself, beside each mod it loads, for the version installed; they are
# not vendored. Since 2.1.327 only an interactive session writes them (`-p`
# loads the mod but writes nothing), so this starts one in a pseudo-terminal
# with an empty probe mod, waits for the files, and ends it before any model
# turn. It runs from the repo root, which Claude Code must already trust.
# What Claude Code wrote is copied into mod/types/, which git ignores. Rerun
# after a Claude Code update.
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
session=""
trap '[ -n "$session" ] && kill "$session" 2>/dev/null; rm -rf "$probe"' EXIT
mkdir -p "$probe/.claude-plugin" "$probe/hooks"
printf '{ "name": "gauntlet-mod-types", "version": "0.0.0" }\n' >"$probe/.claude-plugin/plugin.json"
printf '{ "modules": ["./register.ts"] }\n' >"$probe/hooks/hooks.json"
printf 'export const register = () => {}\n' >"$probe/hooks/register.ts"

written() { [ -f "$probe/.claude-plugin/types/$1/index.d.ts" ]; }
all_written() {
  for package in $packages; do written "$package" || return 1; done
}

# util-linux and BSD (macOS) script(1) take the command differently.
cd "$root"
if script --version 2>/dev/null | grep -q util-linux; then
  script -qec "claude --plugin-dir '$probe' --strict-mcp-config" /dev/null </dev/null >/dev/null 2>&1 &
else
  script -q /dev/null claude --plugin-dir "$probe" --strict-mcp-config </dev/null >/dev/null 2>&1 &
fi
session=$!
waited=0
until all_written || [ "$waited" -ge 60 ]; do
  sleep 1
  waited=$((waited + 1))
done
kill "$session" 2>/dev/null || true
wait "$session" 2>/dev/null || true
session=""

for package in $packages; do
  written="$probe/.claude-plugin/types/$package/index.d.ts"
  if [ ! -f "$written" ]; then
    echo "Claude Code wrote no $package declarations into the probe mod in 60s; run \`claude\` in $root once to trust the folder, then rerun" >&2
    exit 1
  fi
  mkdir -p "$root/mod/types/$package"
  cp "$written" "$root/mod/types/$package/index.d.ts"
done
echo "mod/types: $(head -1 "$root/mod/types/claude-code/index.d.ts")"
