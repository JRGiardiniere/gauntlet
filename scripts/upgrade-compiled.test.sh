#!/bin/sh
set -eu

binary="${1:-dist/gauntlet}"
if [ ! -x "$binary" ]; then
  echo "compiled updater test: $binary is not executable" >&2
  exit 1
fi

if output="$($binary upgrade 2>&1)"; then
  case "$output" in
    *"already up to date"*) ;;
    *)
      echo "$output" >&2
      echo "compiled updater test: successful command did not confirm release lookup" >&2
      exit 1
      ;;
  esac
else
  echo "$output" >&2
  echo "compiled updater test: release lookup failed" >&2
  exit 1
fi

echo "$output"
echo "compiled updater test passed"
