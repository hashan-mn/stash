#!/usr/bin/env bash
# Install the Archivo font (SIL Open Font License) into the user's font dir.
# The design specifies Archivo; without it the panel falls back to Cantarell,
# which changes the metrics. Nothing outside ~/.local/share/fonts is touched.
#
# Undo with: tools/install-font.sh --uninstall
set -euo pipefail

DEST="$HOME/.local/share/fonts/stash"
BASE="https://github.com/Omnibus-Type/Archivo/raw/master/fonts/ttf"
FACES=(
    "Archivo-Regular.ttf"
    "Archivo-Medium.ttf"
    "Archivo-SemiBold.ttf"
    "Archivo-ExtraBold.ttf"
)

if [[ "${1:-}" == "--uninstall" ]]; then
    rm -rf "$DEST"
    fc-cache -f >/dev/null 2>&1 || true
    echo "==> Removed $DEST and refreshed the font cache"
    exit 0
fi

mkdir -p "$DEST"

echo "==> Downloading Archivo into $DEST"
for face in "${FACES[@]}"; do
    if [[ -f "$DEST/$face" ]]; then
        echo "    $face (already present)"
        continue
    fi
    if curl -fsSL --retry 2 -o "$DEST/$face" "$BASE/$face"; then
        echo "    $face"
    else
        echo "    WARNING: could not fetch $face" >&2
        rm -f "$DEST/$face"
    fi
done

echo "==> Refreshing font cache"
fc-cache -f "$DEST" >/dev/null

found=$(fc-list : family 2>/dev/null | grep -ci archivo || true)
if [[ "$found" -gt 0 ]]; then
    echo "==> Archivo is installed and visible to fontconfig"
else
    echo "==> WARNING: Archivo still not visible; the panel will fall back to Cantarell" >&2
    exit 1
fi
