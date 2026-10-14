/* Clipboard monitor.
 *
 * The only way to observe every copy on GNOME Wayland is from inside the
 * shell: Mutter 46 implements no wlr/ext data-control protocol, so external
 * clients (wl-paste --watch) cannot do this at all.
 *
 * Verified against GNOME Shell 46 at runtime:
 *   global.display.get_selection()      -> Meta.Selection
 *   'owner-changed' (sel, type, source) -> fires on every clipboard change
 *   sel.get_mimetypes(type)             -> ['text/plain;charset=utf-8', ...]
 *   St.Clipboard.get_text(type, cb)     -> cb(clipboard, text)
 *   St.Clipboard.get_content(type, mime, cb) -> cb(clipboard, GLib.Bytes)
 */

import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Util from './util.js';

const TEXT_MIME = 'text/plain;charset=utf-8';
const TEXT_MIME_FALLBACK = 'text/plain';

/* Image types we understand, in order of preference. */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/bmp', 'image/tiff'];

/* Presence of any of these means "a password manager put this here". */
const SENSITIVE_MIMES = [
    'x-kde-passwordManagerHint',
    'application/x-secret-service',
];

/* File-manager copies: the text form is an internal marker, not useful text. */
const FILE_COPY_MIMES = [
    'x-special/gnome-copied-files',
    'x-special/nautilus-clipboard',
];

export class ClipboardMonitor {
    /**
     * @param {object} params
     * @param {Gio.Settings} params.settings
     * @param {(clip: object) => void} params.onClip called with a normalized clip
     */
    constructor({settings, onClip}) {
        this._settings = settings;
        this._onClip = onClip;

        this._selection = null;
        this._ownerChangedId = 0;

        /* Hashes we wrote ourselves — skipped once so pasting does not
         * re-record the entry and bubble it to the top. */
        this._selfWrites = new Set();

        /* Guards against overlapping async reads when copies arrive quickly. */
        this._readToken = 0;
    }

    start() {
        if (this._ownerChangedId)
            return;

        this._selection = global.display.get_selection();
        this._ownerChangedId = this._selection.connect(
            'owner-changed',
            (_selection, type, _source) => {
                /* Never let an exception escape into the shell's main loop. */
                Util.guard('owner-changed', () => this._onOwnerChanged(type));
            });

        Util.debug('monitor started');
    }

    stop() {
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = 0;
        }
        this._selection = null;
        this._selfWrites.clear();
        this._readToken++;

        Util.debug('monitor stopped');
    }

    /**
     * Tell the monitor that we are about to write this content ourselves, so
     * the resulting owner-changed is not recorded as a new clip.
     */
    expectSelfWrite(hash) {
        this._selfWrites.add(hash);
        /* Safety valve: never let the set grow without bound if a write is
         * swallowed by another client taking the selection first. */
        if (this._selfWrites.size > 16)
            this._selfWrites.delete(this._selfWrites.values().next().value);
    }

    _onOwnerChanged(type) {
        if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
            return;

        const mimetypes = this._selection.get_mimetypes(type) ?? [];
        Util.debug('owner-changed mimetypes:', mimetypes.join(', ') || '(none)');

        if (mimetypes.length === 0)
            return;

        if (this._isSensitive(mimetypes)) {
            Util.debug('skipped: password manager hint');
            return;
        }

        const source = this._currentSource();
        if (this._isBlockedApp(source.wmClass)) {
            Util.debug(`skipped: blocked app ${source.wmClass}`);
            return;
        }

        const token = ++this._readToken;

        const hasText = mimetypes.includes(TEXT_MIME) ||
                        mimetypes.includes(TEXT_MIME_FALLBACK);
        const imageMime = IMAGE_MIMES.find(m => mimetypes.includes(m));

        /* Screenshots and copied images offer an image type and no plain text.
         * Rich-text copies offer both — those we want as text. */
        if (imageMime && !hasText) {
            if (!this._settings.get_boolean('track-images')) {
                Util.debug('skipped: image tracking disabled');
                return;
            }
            this._readImage(imageMime, source, token);
            return;
        }

        if (mimetypes.some(m => FILE_COPY_MIMES.includes(m))) {
            Util.debug('skipped: file-manager copy');
            return;
        }

        if (hasText)
            this._readText(source, token);
    }

    _isSensitive(mimetypes) {
        if (!this._settings.get_boolean('ignore-password-managers'))
            return false;
        return mimetypes.some(m => SENSITIVE_MIMES.includes(m));
    }

    _isBlockedApp(wmClass) {
        if (!wmClass)
            return false;
        const blocked = this._settings.get_strv('app-blocklist');
        return blocked.some(b => b.toLowerCase() === wmClass.toLowerCase());
    }

    _currentSource() {
        const win = global.display.focus_window;
        const wmClass = win ? win.get_wm_class() : null;
        return {wmClass, name: Util.prettyAppName(wmClass)};
    }

    _readText(source, token) {
        St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
            Util.guard('read text', () => {
                if (token !== this._readToken)
                    return;
                if (!text || text.trim() === '')
                    return;

                /* Nautilus writes an internal marker as plain text. */
                if (text.startsWith('x-special/nautilus-clipboard'))
                    return;

                const hash = Util.hashString(text);
                if (this._consumeSelfWrite(hash))
                    return;

                this._onClip({
                    kind: 'text',
                    type: Util.classifyText(text),
                    text,
                    hash,
                    source: source.name,
                    wmClass: source.wmClass,
                    timestamp: Math.floor(Date.now() / 1000),
                });
            });
        });
    }

    _readImage(mime, source, token) {
        St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, mime, (_clipboard, bytes) => {
            Util.guard('read image', () => {
                if (token !== this._readToken)
                    return;
                if (!bytes)
                    return;

                const size = bytes.get_size();
                if (size === 0)
                    return;

                const maxBytes = this._settings.get_int('max-image-bytes');
                if (size > maxBytes) {
                    Util.debug(`skipped: image ${size}b exceeds limit ${maxBytes}b`);
                    return;
                }

                const hash = Util.hashBytes(bytes);
                if (this._consumeSelfWrite(hash))
                    return;

                const dimensions = this._imageDimensions(bytes);

                this._onClip({
                    kind: 'image',
                    type: 'image',
                    bytes,
                    mime,
                    byteSize: size,
                    width: dimensions?.width ?? 0,
                    height: dimensions?.height ?? 0,
                    hash,
                    source: source.name,
                    wmClass: source.wmClass,
                    timestamp: Math.floor(Date.now() / 1000),
                });
            });
        });
    }

    _imageDimensions(bytes) {
        return Util.guard('image dimensions', () => {
            const stream = Gio.MemoryInputStream.new_from_bytes(bytes);
            const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(stream, null);
            stream.close(null);
            return {width: pixbuf.get_width(), height: pixbuf.get_height()};
        });
    }

    _consumeSelfWrite(hash) {
        if (!this._selfWrites.has(hash))
            return false;
        this._selfWrites.delete(hash);
        Util.debug('skipped: our own write');
        return true;
    }
}
