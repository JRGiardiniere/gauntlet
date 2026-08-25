#!/bin/sh
# Gauntlet installer: fetch the latest release binary and agent skill.
#
#   curl -fsSL https://raw.githubusercontent.com/JRGiardiniere/gauntlet/main/install.sh | sh
#
# Installs the binary to ~/.local/bin (override with GAUNTLET_INSTALL_DIR),
# installs the shared agent skill to ~/.agents/skills/gauntlet, and links that
# skill into ~/.claude/skills. Re-running installs the latest release.
set -eu

repo="JRGiardiniere/gauntlet"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "gauntlet: unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *)
    echo "gauntlet: unsupported architecture: $(uname -m)" >&2
    exit 1
    ;;
esac

install_dir="${GAUNTLET_INSTALL_DIR:-$HOME/.local/bin}"
skills_root="$HOME/.agents/skills"
skill_dir="$skills_root/gauntlet"
claude_skills_dir="$HOME/.claude/skills"
claude_skill="$claude_skills_dir/gauntlet"
claude_target="../../.agents/skills/gauntlet"

# Refuse unrelated Claude content before changing anything. A correct relative
# link and an equivalent absolute link are both valid rerun states.
if [ -L "$claude_skill" ]; then
  existing_target="$(readlink "$claude_skill")"
  if [ "$existing_target" != "$claude_target" ] && [ "$existing_target" != "$skill_dir" ]; then
    echo "gauntlet: refusing to replace unrelated symlink $claude_skill -> $existing_target" >&2
    exit 1
  fi
elif [ -e "$claude_skill" ]; then
  echo "gauntlet: refusing to replace existing path $claude_skill" >&2
  exit 1
fi

if [ ! -L "$skill_dir" ] && [ -e "$skill_dir" ] && [ ! -d "$skill_dir" ]; then
  echo "gauntlet: refusing to replace non-directory path $skill_dir" >&2
  exit 1
fi

mkdir -p "$install_dir"
mkdir -p "$skills_root"

binary_url="${GAUNTLET_BINARY_URL:-https://github.com/$repo/releases/latest/download/gauntlet-$os-$arch}"
skill_url="${GAUNTLET_SKILL_URL:-https://github.com/$repo/releases/latest/download/gauntlet-skill.md}"
binary_download="$install_dir/gauntlet.download.$$"
skill_download="$skills_root/gauntlet-skill.download.$$"

cleanup() {
  rm -f "$binary_download" "$skill_download"
}
trap cleanup 0 1 2 15

echo "downloading $binary_url" >&2
curl -fL --progress-bar "$binary_url" -o "$binary_download"
echo "downloading $skill_url" >&2
curl -fL --progress-bar "$skill_url" -o "$skill_download"

chmod +x "$binary_download"

# Older source-checkout setups linked this path back into the repository.
# Replace only the link; its target remains untouched.
if [ -L "$skill_dir" ]; then
  rm "$skill_dir"
fi
mkdir -p "$skill_dir"
mv "$skill_download" "$skill_dir/SKILL.md"
mv "$binary_download" "$install_dir/gauntlet"

mkdir -p "$claude_skills_dir"
if [ ! -L "$claude_skill" ]; then
  ln -s "$claude_target" "$claude_skill"
fi

trap - 0 1 2 15

echo "installed $install_dir/gauntlet" >&2
echo "installed $skill_dir/SKILL.md" >&2
echo "linked $claude_skill -> $claude_target" >&2
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "note: $install_dir is not on your PATH" >&2 ;;
esac
