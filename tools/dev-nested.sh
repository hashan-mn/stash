#!/usr/bin/env bash
# Run a nested GNOME Shell in a window so extension crashes or freezes kill
# that window instead of your real session. This is the safe development loop.
#
# Close it with Ctrl+C here, or just close the window.
#
# Note: gnome-shell only scans the extensions directory at startup, and there
# is no env var to force-enable an extension (GNOME_SHELL_ENABLED_EXTENSIONS
# does not exist). The only mechanism is the `enabled-extensions` GSettings
# key, which the nested shell reads from your normal dconf database. Adding
# our UUID there is harmless to the running session: it has not scanned the
# directory, so it ignores the UUID until the next login.
set -euo pipefail

UUID="stash@hashan-mn.github.io"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -L "$HOME/.local/share/gnome-shell/extensions/$UUID" ]]; then
    echo "==> Not installed yet, running install.sh"
    "$REPO_ROOT/tools/install.sh"
else
    echo "==> Recompiling schema"
    glib-compile-schemas "$REPO_ROOT/$UUID/schemas"
fi

current="$(gsettings get org.gnome.shell enabled-extensions)"
if [[ "$current" != *"$UUID"* ]]; then
    echo "==> Adding $UUID to enabled-extensions"
    echo "    (was: $current)"
    python3 - "$UUID" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
cur = subprocess.check_output(
    ['gsettings', 'get', 'org.gnome.shell', 'enabled-extensions'], text=True).strip()
items = [] if cur in ('@as []', '[]') else ast.literal_eval(cur)
if uuid not in items:
    items.append(uuid)
value = '[' + ', '.join(f"'{i}'" for i in items) + ']'
subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', 'enabled-extensions', value])
PY
fi

echo "==> Starting nested GNOME Shell"
echo "    Watch logs in another terminal with: $REPO_ROOT/tools/logs.sh"
echo

export MUTTER_DEBUG_DUMMY_MODE_SPECS="1280x760"

exec dbus-run-session -- gnome-shell --nested --wayland
