/* Shared helpers: logging, hashing, text classification, formatting. */

import GLib from 'gi://GLib';

const PREFIX = '[stash]';

let debugEnabled = false;

export function setDebug(enabled) {
    debugEnabled = enabled;
}

export function isDebug() {
    return debugEnabled;
}

export function debug(...args) {
    if (debugEnabled)
        console.log(`${PREFIX}`, ...args);
}

export function info(...args) {
    console.log(`${PREFIX}`, ...args);
}

export function warn(...args) {
    console.warn(`${PREFIX}`, ...args);
}

/** Report an error without ever letting it escape into the shell's main loop. */
export function guard(label, fn) {
    try {
        return fn();
    } catch (e) {
        logError(e, `${PREFIX} ${label}`);
        return null;
    }
}

/** Stable content hash used for dedupe. */
export function hashString(str) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, str, -1);
}

export function hashBytes(bytes) {
    return GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes);
}

const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const SHELL_RE = /^(sudo |git |npm |pnpm |yarn |docker |kubectl |systemctl |apt |dnf |pacman |cargo |go |make |cd |ls |rm |cp |mv |ssh |scp |curl |wget |python3? |node |gjs |flatpak |snap |gsettings |journalctl )/;
const SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i;
const CODE_HINT_RE = /[{};]\s*$|^\s*(function|const|let|var|class|def|import|export|#include|package)\s/m;

/**
 * Classify a text clip into one of the mark types the design uses:
 * URL / CMD / TXT. Images are classified by the caller.
 */
export function classifyText(text) {
    const trimmed = text.trim();
    if (URL_RE.test(trimmed))
        return 'link';
    if (SHELL_RE.test(trimmed) || SQL_RE.test(trimmed) || CODE_HINT_RE.test(trimmed))
        return 'code';
    return 'text';
}

/** "2m ago", "3h ago", "4d ago" — matches the mock's meta line. */
export function relativeTime(timestampSeconds, nowSeconds = Math.floor(Date.now() / 1000)) {
    const delta = Math.max(0, nowSeconds - timestampSeconds);
    if (delta < 60)
        return 'just now';
    if (delta < 3600)
        return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400)
        return `${Math.floor(delta / 3600)}h ago`;
    if (delta < 604800)
        return `${Math.floor(delta / 86400)}d ago`;
    return `${Math.floor(delta / 604800)}w ago`;
}

/**
 * Turn a WM_CLASS into something presentable: "org.gnome.Nautilus" -> "Nautilus",
 * "gnome-terminal-server" -> "Terminal".
 */
const APP_NAME_OVERRIDES = {
    'gnome-terminal-server': 'Terminal',
    'org.gnome.Console': 'Console',
    'org.gnome.Nautilus': 'Files',
    'org.gnome.TextEditor': 'Text Editor',
    'org.gnome.Screenshot': 'Screenshot',
    'firefox': 'Firefox',
    'firefox-esr': 'Firefox',
    'Navigator': 'Firefox',
    'code': 'VS Code',
    'Code': 'VS Code',
    'jetbrains-idea': 'IntelliJ',
    'thunderbird': 'Thunderbird',
    'obsidian': 'Obsidian',
    'Slack': 'Slack',
    'gimp': 'GIMP',
    'Gimp': 'GIMP',
};

export function prettyAppName(wmClass) {
    if (!wmClass)
        return 'Unknown';
    if (APP_NAME_OVERRIDES[wmClass])
        return APP_NAME_OVERRIDES[wmClass];

    let name = wmClass;
    // Strip a reverse-DNS prefix: org.gnome.Foo -> Foo
    const parts = name.split('.');
    if (parts.length > 1)
        name = parts[parts.length - 1];
    name = name.replace(/[-_]/g, ' ').trim();
    if (!name)
        return 'Unknown';
    return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Collapse whitespace for the single-line-ish list preview. */
export function previewText(text, maxChars = 220) {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > maxChars
        ? `${collapsed.slice(0, maxChars)}…`
        : collapsed;
}
