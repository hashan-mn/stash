#!/usr/bin/env bash
# Tail gnome-shell's journal, filtered to this extension.
# Pass -a to see all shell output (useful when hunting a stack trace).
set -euo pipefail

if [[ "${1:-}" == "-a" ]]; then
    exec journalctl -f -o cat /usr/bin/gnome-shell
fi

exec journalctl -f -o cat /usr/bin/gnome-shell | grep --line-buffered -iE '\[stash\]'
