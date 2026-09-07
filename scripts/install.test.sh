#!/bin/sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/gauntlet-install-test.XXXXXX")"
trap 'rm -rf "$root"' 0 1 2 15

release_binary="$root/release-binary"
release_skill="$root/gauntlet-skill.md"
printf '#!/bin/sh\necho gauntlet-test-binary\n' > "$release_binary"
cp "$repo_root/.agents/skills/gauntlet/SKILL.md" "$release_skill"

fixture_home="$root/home"
install_dir="$fixture_home/bin"
legacy_skill="$root/legacy-skill"
mkdir -p "$fixture_home/.agents/skills" "$legacy_skill"
cp "$release_skill" "$legacy_skill/SKILL.md"
ln -s "$legacy_skill" "$fixture_home/.agents/skills/gauntlet"

run_installer() {
  HOME="$fixture_home" \
    GAUNTLET_INSTALL_DIR="$install_dir" \
    GAUNTLET_BINARY_URL="file://$release_binary" \
    GAUNTLET_SKILL_URL="file://$release_skill" \
    sh "$repo_root/install.sh"
}

run_installer

test -x "$install_dir/gauntlet"
cmp "$release_binary" "$install_dir/gauntlet"
test ! -L "$fixture_home/.agents/skills/gauntlet"
cmp "$release_skill" "$fixture_home/.agents/skills/gauntlet/SKILL.md"
test -L "$fixture_home/.claude/skills/gauntlet"
test "$(readlink "$fixture_home/.claude/skills/gauntlet")" = "../../.agents/skills/gauntlet"
cmp "$release_skill" "$fixture_home/.claude/skills/gauntlet/SKILL.md"

# Re-running updates the managed files and preserves the correct Claude link.
printf '#!/bin/sh\necho gauntlet-updated-binary\n' > "$release_binary"
printf '\nUpdated release skill.\n' >> "$release_skill"
run_installer
cmp "$release_binary" "$install_dir/gauntlet"
cmp "$release_skill" "$fixture_home/.claude/skills/gauntlet/SKILL.md"
test "$(readlink "$fixture_home/.claude/skills/gauntlet")" = "../../.agents/skills/gauntlet"
cmp "$repo_root/.agents/skills/gauntlet/SKILL.md" "$legacy_skill/SKILL.md"

# An unrelated Claude skill must stop the install before it writes anything.
conflict_home="$root/conflict-home"
mkdir -p "$conflict_home/.claude/skills/gauntlet"
if HOME="$conflict_home" \
  GAUNTLET_INSTALL_DIR="$conflict_home/bin" \
  GAUNTLET_BINARY_URL="file://$release_binary" \
  GAUNTLET_SKILL_URL="file://$release_skill" \
  sh "$repo_root/install.sh" 2>/dev/null
then
  echo "installer replaced an unrelated Claude skill" >&2
  exit 1
fi
test ! -e "$conflict_home/bin/gauntlet"

echo "installer test passed"
