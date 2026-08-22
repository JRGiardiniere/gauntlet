#!/bin/sh
# Gauntlet installer: fetch the latest release binary for this platform.
#
#   curl -fsSL https://raw.githubusercontent.com/JRGiardiniere/gauntlet/main/install.sh | sh
#
# Installs to ~/.local/bin (override with GAUNTLET_INSTALL_DIR). Re-running
# always installs the latest release; an installed binary can also update
# itself with `gauntlet upgrade`.
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
mkdir -p "$install_dir"

url="https://github.com/$repo/releases/latest/download/gauntlet-$os-$arch"
echo "downloading $url" >&2
curl -fL --progress-bar "$url" -o "$install_dir/gauntlet.download"
chmod +x "$install_dir/gauntlet.download"
mv "$install_dir/gauntlet.download" "$install_dir/gauntlet"

echo "installed $install_dir/gauntlet" >&2
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "note: $install_dir is not on your PATH" >&2 ;;
esac
