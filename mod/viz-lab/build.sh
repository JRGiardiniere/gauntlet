#!/bin/sh
# Bundles viz.ts into the gc-viz plugin and copies the replay fixture in.
set -e
cd "$(dirname "$0")"
bun build viz.ts --outfile gc-viz/hooks/vendor/viz.js --target browser --format esm
cp fixture.json gc-viz/hooks/fixture.json
