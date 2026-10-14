#!/usr/bin/env bash
# Install the extension for the current user by symlinking the source tree
# into ~/.local/share/gnome-shell/extensions. Nothing outside $HOME is touched.
set -euo pipefail

UUID="stash@hashan-mn.github.io"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/$UUID"
DEST_DIR="$HOME/.local/share/gnome-shell/extensions"
DEST="$DEST_DIR/$UUID"

if [[ ! -d "$SRC" ]]; then
    echo "error: source not found at $SRC" >&2
    exit 1
fi

echo "==> Compiling GSettings schema"
glib-compile-schemas "$SRC/schemas"

mkdir -p "$DEST_DIR"

if [[ -e "$DEST" && ! -L "$DEST" ]]; then
    echo "error: $DEST exists and is not a symlink; refusing to overwrite" >&2
    echo "       move it aside first if you want the dev symlink" >&2
    exit 1
fi

echo "==> Linking $DEST -> $SRC"
ln -sfn "$SRC" "$DEST"

echo "==> Installed. Next:"
echo "    gnome-extensions enable $UUID"
echo
echo "    On Wayland the shell cannot hot-reload; either log out and back in,"
echo "    or test with: $REPO_ROOT/tools/dev-nested.sh"
