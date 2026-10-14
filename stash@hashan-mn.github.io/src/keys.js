/* Global shortcut handling.
 *
 * Super+V is already bound to `toggle-message-tray` on a stock Ubuntu 24.04
 * install (the default is ['<Super>v', '<Super>m']). Taking it means editing
 * that key, so the original value is saved and restored verbatim on disable —
 * the tray keeps working via Super+M in the meantime.
 */

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import * as Util from './util.js';

const OUR_BINDING = 'toggle-panel';

const SHELL_KEYS_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';

export class KeyManager {
    constructor(settings) {
        this._settings = settings;
        this._bound = false;
    }

    /**
     * @param {() => void} onActivate called when the shortcut fires
     */
    enable(onActivate) {
        const accelerators = this._settings.get_strv(OUR_BINDING);
        if (accelerators.length > 0)
            this._stealConflicts(accelerators);

        Main.wm.addKeybinding(
            OUR_BINDING,
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            onActivate);

        this._bound = true;
        Util.info(`bound ${accelerators.join(', ') || '(nothing)'}`);
    }

    disable() {
        if (this._bound) {
            Main.wm.removeKeybinding(OUR_BINDING);
            this._bound = false;
        }
        this._restoreConflicts();
    }

    /**
     * Remove our accelerator from any shell keybinding that already claims it.
     * Only `toggle-message-tray` is handled, because that is the one stock
     * conflict; anything else is left alone and simply loses the race.
     *
     * The original value goes into our own GSettings rather than an instance
     * field, so a shell crash (which skips disable()) cannot strand the user
     * without their tray shortcut — the next enable/disable cycle restores it.
     */
    _stealConflicts(accelerators) {
        const shellKeys = new Gio.Settings({schema_id: SHELL_KEYS_SCHEMA});
        const current = shellKeys.get_strv(TRAY_KEY);
        const remaining = current.filter(a => !accelerators.includes(a));

        if (remaining.length === current.length)
            return;

        /* A non-empty backup means a previous run already stole the binding
         * and did not get to restore it. Keep that original, not the value we
         * ourselves left behind. */
        if (this._settings.get_strv('tray-binding-backup').length === 0)
            this._settings.set_strv('tray-binding-backup', current);

        shellKeys.set_strv(TRAY_KEY, remaining);

        Util.info(
            `took ${accelerators.join(', ')} from ${TRAY_KEY} ` +
            `(was [${current.join(', ')}], now [${remaining.join(', ')}])`);
    }

    _restoreConflicts() {
        const backup = this._settings.get_strv('tray-binding-backup');
        if (backup.length === 0)
            return;

        new Gio.Settings({schema_id: SHELL_KEYS_SCHEMA}).set_strv(TRAY_KEY, backup);
        this._settings.set_strv('tray-binding-backup', []);

        Util.info(`restored ${TRAY_KEY} to [${backup.join(', ')}]`);
    }
}
