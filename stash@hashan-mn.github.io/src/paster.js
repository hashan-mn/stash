/* Writing the clipboard and pasting into the app that was focused.
 *
 * On Wayland this can only be done from inside the shell: an external tool
 * can neither restore focus to the caller's window nor synthesize input into
 * it. The sequence matters:
 *
 *   1. remember the focused window *before* the panel takes its modal grab
 *   2. put the entry on the clipboard
 *   3. close the panel, releasing the grab
 *   4. re-activate the remembered window
 *   5. only then synthesize Ctrl+V
 *
 * Steps 4 and 5 must be separated by at least one frame, otherwise the key
 * event races the focus change and lands nowhere.
 */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Util from './util.js';

/* Give the compositor time to hand focus back before typing into it. */
const PASTE_DELAY_MS = 60;

export class Paster {
    constructor({monitor, persistence}) {
        this._monitor = monitor;
        this._persist = persistence;
        this._focusWindow = null;
        this._virtualDevice = null;
        this._pasteTimeoutId = 0;
    }

    /** Called just before the panel opens and takes the keyboard. */
    rememberFocus() {
        this._focusWindow = global.display.focus_window;
        Util.debug(`remembered focus: ${this._focusWindow?.get_wm_class() ?? 'none'}`);
    }

    get focusedAppName() {
        return Util.prettyAppName(this._focusWindow?.get_wm_class());
    }

    /**
     * Put an entry on the clipboard.
     * @returns {boolean} whether it succeeded
     */
    setClipboard(item, plainText = false) {
        const clipboard = St.Clipboard.get_default();

        if (item.kind === 'image' && !plainText) {
            const bytes = this._readImage(item);
            if (!bytes)
                return false;
            this._monitor?.expectSelfWrite(Util.hashBytes(bytes));
            clipboard.set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
            return true;
        }

        const text = item.kind === 'image' ? item.label : item.full;
        if (!text)
            return false;

        this._monitor?.expectSelfWrite(Util.hashString(text));
        clipboard.set_text(St.ClipboardType.CLIPBOARD, text);
        return true;
    }

    _readImage(item) {
        return Util.guard('read stored image', () => {
            const file = Gio.File.new_for_path(this._persist.imagePath(item.id));
            if (!file.query_exists(null))
                return null;
            const [ok, contents] = file.load_contents(null);
            return ok ? new GLib.Bytes(contents) : null;
        });
    }

    /**
     * Set the clipboard, then paste into the window that was focused before
     * the panel opened. `afterGrabReleased` must actually release the grab.
     */
    pasteIntoFocusedWindow(item, plainText, afterGrabReleased) {
        if (!this.setClipboard(item, plainText))
            return false;

        const target = this._focusWindow;

        if (afterGrabReleased)
            afterGrabReleased();

        if (!target) {
            Util.debug('no window to paste into; clipboard set only');
            return true;
        }

        this._cancelPending();
        this._pasteTimeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, PASTE_DELAY_MS, () => {
                this._pasteTimeoutId = 0;
                Util.guard('paste', () => {
                    /* The window can vanish while the panel is open. */
                    if (!target || target.get_compositor_private() === null) {
                        Util.debug('target window is gone, clipboard set only');
                        return;
                    }
                    target.activate(global.get_current_time());
                    this._sendCtrlV();
                });
                return GLib.SOURCE_REMOVE;
            });

        return true;
    }

    _sendCtrlV() {
        if (!this._virtualDevice) {
            const seat = Clutter.get_default_backend().get_default_seat();
            this._virtualDevice = seat.create_virtual_device(
                Clutter.InputDeviceType.KEYBOARD_DEVICE);
        }

        /* notify_keyval takes microseconds. */
        const now = global.get_current_time() * 1000;
        const device = this._virtualDevice;

        device.notify_keyval(now, Clutter.KEY_Control_L, Clutter.KeyState.PRESSED);
        device.notify_keyval(now, Clutter.KEY_v, Clutter.KeyState.PRESSED);
        device.notify_keyval(now, Clutter.KEY_v, Clutter.KeyState.RELEASED);
        device.notify_keyval(now, Clutter.KEY_Control_L, Clutter.KeyState.RELEASED);

        Util.debug('sent Ctrl+V');
    }

    _cancelPending() {
        if (this._pasteTimeoutId) {
            GLib.source_remove(this._pasteTimeoutId);
            this._pasteTimeoutId = 0;
        }
    }

    destroy() {
        this._cancelPending();
        this._virtualDevice = null;
        this._focusWindow = null;
    }
}
