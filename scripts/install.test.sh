#!/bin/sh
set -eu

repo_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
root="$(mktemp -d "${TMPDIR:-/tmp}/gauntlet-install-test.XXXXXX")"
trap 'rm -rf "$root"' 0 1 2 15

release_binary="$root/release-binary"
release_skill="$root/gauntlet-skill.md"
printf '#!/bin/sh\necho gauntlet-test-binary\n' > "$release_binary"
cp "$repo_root/.agents/skills/gauntlet-cli/SKILL.md" "$release_skill"

# An earlier install, under the skill's old `gauntlet` name.
fixture_home="$root/home"
install_dir="$fixture_home/bin"
mkdir -p "$fixture_home/.agents/skills/gauntlet" "$fixture_home/.claude/skills"
cp "$release_skill" "$fixture_home/.agents/skills/gauntlet/SKILL.md"
ln -s "../../.agents/skills/gauntlet" "$fixture_home/.claude/skills/gauntlet"

run_installer() {
  HOME="$1" \
    GAUNTLET_INSTALL_DIR="$1/bin" \
    GAUNTLET_BINARY_URL="file://$release_binary" \
    GAUNTLET_SKILL_URL="file://$release_skill" \
    sh "$repo_root/install.sh"
}

run_installer "$fixture_home"

test -x "$install_dir/gauntlet"
cmp "$release_binary" "$install_dir/gauntlet"
cmp "$release_skill" "$fixture_home/.agents/skills/gauntlet-cli/SKILL.md"
test "$(readlink "$fixture_home/.claude/skills/gauntlet-cli")" = "../../.agents/skills/gauntlet-cli"
cmp "$release_skill" "$fixture_home/.claude/skills/gauntlet-cli/SKILL.md"
test ! -e "$fixture_home/.agents/skills/gauntlet"
test ! -L "$fixture_home/.claude/skills/gauntlet"

# Re-running updates the managed files and preserves the correct Claude link.
printf '#!/bin/sh\necho gauntlet-updated-binary\n' > "$release_binary"
printf '\nUpdated release skill.\n' >> "$release_skill"
run_installer "$fixture_home"
cmp "$release_binary" "$install_dir/gauntlet"
cmp "$release_skill" "$fixture_home/.claude/skills/gauntlet-cli/SKILL.md"
test "$(readlink "$fixture_home/.claude/skills/gauntlet-cli")" = "../../.agents/skills/gauntlet-cli"

# An older source-checkout setup linked the old folder into a repository:
# the link goes, its target stays.
linked_home="$root/linked-home"
legacy_skill="$root/legacy-skill"
mkdir -p "$linked_home/.agents/skills" "$legacy_skill"
cp "$release_skill" "$legacy_skill/SKILL.md"
ln -s "$legacy_skill" "$linked_home/.agents/skills/gauntlet"
run_installer "$linked_home"
test ! -L "$linked_home/.agents/skills/gauntlet"
cmp "$release_skill" "$legacy_skill/SKILL.md"

# An unrelated Claude skill must stop the install before it writes anything.
conflict_home="$root/conflict-home"
mkdir -p "$conflict_home/.claude/skills/gauntlet-cli"
if run_installer "$conflict_home" 2>/dev/null; then
  echo "installer replaced an unrelated Claude skill" >&2
  exit 1
fi
test ! -e "$conflict_home/bin/gauntlet"

echo "installer test passed"
